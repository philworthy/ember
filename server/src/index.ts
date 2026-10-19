// The Ember server: opens the DB, connects to the iKamand (or the in-process simulator), runs the
// cook engine, and serves the API and the PWA.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceInfo } from "@ember/shared";
import { buildApp } from "./app.ts";
import { loadEnv } from "./config.ts";
import { Catalog } from "./cook/catalog.ts";
import { CookEngine, linkRestoreFrom } from "./cook/engine.ts";
import { openDb } from "./db/open.ts";
import { Store } from "./db/store.ts";
import { DeviceClient } from "./device/client.ts";
import { type Clock, ScaledClock, systemClock } from "./device/clock.ts";
import { DeviceLink } from "./device/device.ts";
import type { Transport } from "./device/transport.ts";
import { TcpTransport } from "./device/transport.ts";
import { AlertService } from "./push/alerts.ts";
import { PushSender, webPushTransport } from "./push/sender.ts";
import { loadVapid } from "./push/vapid.ts";
import { SimDevice } from "./sim/device.ts";
import { getScenario } from "./sim/scenarios.ts";
import { SimTransport } from "./sim/wire.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = loadEnv(process.env, ROOT);

// Simulated cooks get their own DB, so they never land in real history.
const db = openDb(path.join(env.dataDir, env.useSimulator ? "ember-sim.db" : "ember.db"));
const store = new Store(db);

let clock: Clock;
let transport: Transport;
let source: string;
if (env.useSimulator) {
  // `tsx watch` restarts the in-process simulator; a sped-up clock from an earlier run may have
  // written readings "in the future", so keep timestamps increasing.
  const start = Math.max(Date.now(), (store.lastReadingTs() ?? 0) + 5_000);
  clock = new ScaledClock(env.simSpeed, start);
  const sim = new SimDevice(clock);
  const scenario = env.simScenario ? getScenario(env.simScenario) : null;
  scenario?.setup(sim, clock.now());
  transport = new SimTransport(sim);
  source = `simulator (${scenario?.name ?? "no scenario"}, ${env.simSpeed}×)`;
} else {
  clock = systemClock;
  transport = new TcpTransport(env.ikamandHost as string);
  source = `iKamand at ${env.ikamandHost}`;
}

const catalog = Catalog.load(env.dataDir);
// Reconcile with the DB before sending anything (protocol.md › Safety): the link starts from
// the saved intent, and its recovery decides what to send.
const client = new DeviceClient(transport);
const link = new DeviceLink(client, {
  clock,
  restore: linkRestoreFrom(store),
});
let logWarn: (msg: string, data?: unknown) => void = (msg, data) => console.warn(msg, data);
const engine = new CookEngine({
  store,
  link,
  clock,
  catalog,
  clockRate: env.useSimulator ? env.simSpeed : 1,
  log: (m, d) => logWarn(m, d),
});

const vapid = loadVapid({ env: env.vapid, subject: env.vapidSubject }, env.dataDir);
let logInfo: (msg: string) => void = (msg) => console.info(msg);
const sender = new PushSender({
  store,
  transport: webPushTransport(vapid),
  now: () => Date.now(),
  log: (m, d) => (d === undefined ? logInfo(m) : logWarn(m, d)),
});
const alerts = new AlertService({ engine, store, sender, log: (m, d) => logWarn(m, d) });

const app = await buildApp({
  engine,
  store,
  catalog,
  clock,
  push: { sender, publicKey: vapid.publicKey, deviceInfo },
  logger: true,
});
logWarn = (msg, data) => app.log.warn({ data }, msg);
logInfo = (msg) => app.log.info(msg);

engine.on("event", (e) => {
  if (e.type !== "commandResult" || e.data.ok === false) app.log.info({ event: e }, e.type);
});
link.on("sent", (e) => {
  if (!e.ok) app.log.warn({ reason: e.reason, error: e.error }, "device command send failed");
});

await app.listen({ port: env.port, host: "0.0.0.0" });
app.log.info(`device: ${source}; data: ${env.dataDir}`);
const VAPID_FROM = { env: "from the environment", file: "loaded", generated: "generated" };
app.log.info(`push: VAPID keys ${VAPID_FROM[vapid.source]}; subject ${vapid.subject}`);
link.start();
// Pit drift and offline need time to pass without events; once a second is plenty.
const alertTimer = setInterval(() => alerts.tick(), 1000);

/** What Settings shows about the grill. The `info` GET joins the client's one-at-a-time queue. */
let infoFields: Promise<Record<string, string> | null> | null = null;
function deviceInfo(): Promise<DeviceInfo> {
  infoFields ??= client.get("info").then(
    (res) => (res.status < 300 ? res.fields : null),
    () => null,
  );
  return infoFields.then((fields) => {
    if (!fields) infoFields = null; // try again next time
    return {
      source: env.useSimulator ? "simulator" : "iKamand",
      host: env.useSimulator ? null : env.ikamandHost,
      firmware: fields?.fw_version ?? null,
      mac: fields?.MAC ?? null,
    };
  });
}

// Stopping or redeploying leaves a cook running on purpose; the device's sce is the backstop.
async function shutdown(signal: string) {
  app.log.info(`${signal}: stopping (any cook keeps running)`);
  clearInterval(alertTimer);
  await link.stop();
  alerts.close();
  engine.close();
  await app.close();
  db.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
