// The Ember server: opens the DB, connects to the iKamand (or the in-process simulator), runs the
// cook engine, and serves the API and the PWA.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const link = new DeviceLink(new DeviceClient(transport), {
  clock,
  restore: linkRestoreFrom(store),
});
let logWarn: (msg: string, data?: unknown) => void = (msg, data) => console.warn(msg, data);
const engine = new CookEngine({ store, link, clock, catalog, log: (m, d) => logWarn(m, d) });
const app = await buildApp({ engine, store, catalog, clock, logger: true });
logWarn = (msg, data) => app.log.warn({ data }, msg);

engine.on("event", (e) => {
  if (e.type !== "commandResult" || e.data.ok === false) app.log.info({ event: e }, e.type);
});
link.on("sent", (e) => {
  if (!e.ok) app.log.warn({ reason: e.reason, error: e.error }, "device command send failed");
});

await app.listen({ port: env.port, host: "0.0.0.0" });
app.log.info(`device: ${source}; data: ${env.dataDir}`);
link.start();

// Stopping or redeploying leaves a cook running on purpose; the device's sce is the backstop.
async function shutdown(signal: string) {
  app.log.info(`${signal}: stopping (any cook keeps running)`);
  await link.stop();
  engine.close();
  await app.close();
  db.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
