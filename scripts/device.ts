// Real-device CLI for the milestone 1 protocol spike. See docs/m1-runbook.md.
// Every command that changes device state shows the exact payload and asks for "yes" first.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type ContentTypeMode,
  type DecodedData,
  DeviceClient,
  decodeData,
  encodeForm,
  GRILL_B_TPT_C,
  grillStartA,
  grillStartB,
  grillStop,
  type Payload,
  parseRawPairs,
  startCook,
  stopCook,
} from "@ember/server/device";
import { fToDeviceC } from "@ember/shared";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  CSV_COLUMNS,
  csvRow,
  describeData,
  describePayload,
  diffFields,
  fmtDuration,
  statusLine,
} from "./lib/format.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURES = path.join(ROOT, "captures");

// Shell environment wins over .env, so tests can point IKAMAND_HOST at a local stub.
if (!process.env.EMBER_SKIP_DOTENV && existsSync(path.join(ROOT, ".env"))) {
  process.loadEnvFile(path.join(ROOT, ".env"));
}

/** Pause between a command and the follow-up `data` read, so the device has time to react. */
const SETTLE_MS = Number(process.env.EMBER_SETTLE_MS ?? 3000);
/** protocol.md › Quirks 5: streaks of 3 failures happen while the device is fine. */
const OFFLINE_AFTER_FAILURES = 5;

const nowS = () => Math.floor(Date.now() / 1000);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

class CliError extends Error {}

function die(message: string): never {
  throw new CliError(message);
}

function makeClient(transcript: boolean): DeviceClient {
  const host = process.env.IKAMAND_HOST;
  if (!host) die("IKAMAND_HOST is not set. Put it in .env (see .env.example).");
  const { timeout } = program.opts<{ timeout: number }>();
  return new DeviceClient(host, {
    timeoutMs: timeout,
    transcriptPath: transcript
      ? path.join(CAPTURES, `device-${stamp().slice(0, 8)}.log`)
      : undefined,
  });
}

function logEnabled(): boolean {
  return program.opts<{ log: boolean }>().log;
}

async function readData(client: DeviceClient): Promise<{ d: DecodedData; raw: string }> {
  const res = await client.get("data");
  if (res.status >= 300) die(`data returned HTTP ${res.status}: ${res.body.trim()}`);
  return { d: decodeData(res.fields), raw: res.body };
}

async function trySnapshot(client: DeviceClient): Promise<DecodedData | null> {
  try {
    return (await readData(client)).d;
  } catch (err) {
    console.log(`  (could not read data: ${(err as Error).message})`);
    return null;
  }
}

function isRunning(d: DecodedData): boolean {
  return d.cookActive || d.ag === "1" || (d.fanPct ?? 0) > 0;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.on("SIGINT", () => {
      console.log("\nNot sent.");
      process.exit(1);
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Show what will be sent and require "yes". The payload is built again after the answer so `ct`
 * and the timers are measured from the moment it is actually sent.
 */
async function confirm(
  client: DeviceClient,
  title: string,
  build: (now: number) => Payload,
  contentType: ContentTypeMode,
  notes: string[] = [],
): Promise<void> {
  const preview = build(nowS());
  const header = contentType === "json" ? "application/json" : "application/x-www-form-urlencoded";
  console.log(`\n${title}`);
  console.log(`  POST ${client.baseUrl}cook   Content-Type: ${header}`);
  console.log(describePayload(preview, nowS()));
  console.log(`  body: ${encodeForm(preview)}`);
  for (const note of notes) console.log(`  ! ${note}`);
  const answer = await ask('\nType "yes" to send: ');
  if (answer.trim().toLowerCase() !== "yes") die("Not sent.");
}

/** Snapshot, confirm, send, wait, snapshot again, and print what changed. */
async function sendWithConfirmation(
  client: DeviceClient,
  title: string,
  build: (now: number) => Payload,
  opts: { contentType?: ContentTypeMode; notes?: string[] } = {},
): Promise<DecodedData | null> {
  const contentType = opts.contentType ?? "json";
  const before = await trySnapshot(client);
  if (before) console.log(`\nNow:   ${statusLine(before)}`);
  await confirm(client, title, build, contentType, opts.notes);

  // A reset POST is not applied (protocol.md › Quirks 5), so read back the state either way.
  try {
    const res = await client.postCook(build(nowS()), contentType);
    console.log(`\nSent.  HTTP ${res.status}  ${res.body.trim() || "(empty body)"}`);
  } catch (err) {
    console.log(`\nSEND FAILED: ${(err as Error).message}. Checking whether it was applied…`);
  }

  await sleep(SETTLE_MS);
  const after = await trySnapshot(client);
  if (after) {
    console.log(`After: ${statusLine(after)}`);
    if (before) {
      const changes = diffFields(before.fields, after.fields);
      console.log(changes.length ? `Changed:\n${changes.join("\n")}` : "Changed: nothing");
    }
  }
  return after;
}

// ---- Commands ----

async function cmdInfo(opts: { raw?: boolean }) {
  const res = await makeClient(logEnabled()).get("info");
  if (!opts.raw) {
    console.log(`HTTP ${res.status}`);
    for (const [k, v] of Object.entries(res.fields)) console.log(`  ${k.padEnd(13)} ${v}`);
  }
  console.log(`raw: ${res.body.trim()}`);
}

async function cmdData(opts: { raw?: boolean }) {
  const { d, raw } = await readData(makeClient(logEnabled()));
  if (!opts.raw) console.log(describeData(d, nowS()));
  console.log(`raw: ${raw.trim()}`);
}

async function cmdWatch(opts: { interval: number; out?: string }) {
  const client = makeClient(false);
  const out = opts.out ?? path.join(CAPTURES, `watch-${stamp()}.csv`);
  mkdirSync(path.dirname(out), { recursive: true });
  if (!existsSync(out)) writeFileSync(out, `${CSV_COLUMNS.join(",")}\n`);
  console.log(`Watching ${client.baseUrl}data every ${opts.interval}s → ${out}  (Ctrl-C to stop)`);

  let rows = 0;
  let failures = 0;
  process.on("SIGINT", () => {
    console.log(`\nStopped watching. ${rows} rows in ${out}`);
    process.exit(0);
  });

  for (;;) {
    const started = Date.now();
    const now = nowS();
    const clock = new Date().toLocaleTimeString();
    try {
      const { d, raw } = await readData(client);
      failures = 0;
      appendFileSync(out, `${csvRow(now, d, raw, null)}\n`);
      console.log(`${clock}  ${statusLine(d)}`);
    } catch (err) {
      failures++;
      const message = (err as Error).message;
      appendFileSync(out, `${csvRow(now, null, null, message)}\n`);
      const offline = failures >= OFFLINE_AFTER_FAILURES ? "  OFFLINE" : "";
      console.log(`${clock}  poll failed (${failures} in a row): ${message}${offline}`);
    }
    rows++;
    await sleep(Math.max(0, opts.interval * 1000 - (Date.now() - started)));
  }
}

async function cmdStart(opts: {
  pit: number;
  probe?: number;
  probeTarget?: number;
  formHeader?: boolean;
}) {
  const { pit, probe, probeTarget } = opts;
  if (pit < 150 || pit > 700) die("--pit must be 150–700 °F");
  if ((probe === undefined) !== (probeTarget === undefined)) {
    die("--probe and --probe-target go together");
  }
  if (probe !== undefined && ![1, 2, 3].includes(probe)) die("--probe must be 1, 2 or 3");
  if (probeTarget !== undefined && (probeTarget < 50 || probeTarget > 220)) {
    die("--probe-target must be 50–220 °F");
  }
  const tptC = fToDeviceC(pit);
  const foodProbe =
    probe !== undefined && probeTarget !== undefined
      ? { slot: probe as 1 | 2 | 3, tftC: fToDeviceC(probeTarget) }
      : undefined;

  const notes = [`Starts a cook. The device stops itself at sce (24 h) unless you run "stop".`];
  if (tptC > GRILL_B_TPT_C) {
    notes.push(
      `tpt=${tptC} is above 260 °C: UNVERIFIED on this firmware. Watch the fan and check what tpt reads back.`,
    );
  }
  if (foodProbe) {
    notes.push(
      `Device food-probe target p=${foodProbe.slot} tft=${foodProbe.tftC}: UNVERIFIED. It may end the cook when reached.`,
    );
  }
  const client = makeClient(logEnabled());
  const after = await sendWithConfirmation(
    client,
    `Start cook at ${pit}°F (tpt=${tptC} °C)`,
    (now) => startCook(tptC, now, foodProbe),
    { contentType: opts.formHeader ? "form" : "json", notes },
  );
  if (after?.cookActive) console.log("\nCook is running. Stop it with: npm run device -- stop");
}

async function cmdStop(opts: { formHeader?: boolean }) {
  const client = makeClient(logEnabled());
  const after = await sendWithConfirmation(client, "Stop cook", stopCook, {
    contentType: opts.formHeader ? "form" : "json",
  });
  if (after && isRunning(after)) {
    console.log(
      "\n! Device still reports running. Check acs/ag/dc above; try again or use the grill.",
    );
  }
}

async function cmdRawPost(pairs: string[], opts: { formHeader?: boolean }) {
  // Validate before contacting the device.
  parseRawPairs(pairs, nowS());
  const client = makeClient(logEnabled());
  const after = await sendWithConfirmation(
    client,
    "Raw POST to cook",
    (now) => parseRawPairs(pairs, now),
    {
      contentType: opts.formHeader ? "form" : "json",
      notes: ["Raw payloads have no auto-stop. If this starts the fan, you must run stop."],
    },
  );
  if (after && isRunning(after)) {
    console.log("\nDevice reports running (acs, ag or fan). Stop it with: npm run device -- stop");
  }
}

async function cmdGrill(opts: { min: number; method: "a" | "b"; grace: number; interval: number }) {
  const { min, method, grace, interval } = opts;
  if (!(min > 0 && min <= 30)) die("--min must be greater than 0 and at most 30");
  if (grace < 0 || grace > 300) die("--grace must be 0–300 s");
  const client = makeClient(logEnabled());

  const { d: before } = await readData(client);
  console.log(`\nNow:   ${statusLine(before)}`);
  if (before.cookActive || before.ag === "1") {
    die("A cook or grill mode is already active. Run stop first.");
  }

  const seconds = Math.round(min * 60);
  const build = (now: number) => (method === "a" ? grillStartA(min, now) : grillStartB(min, now));
  await confirm(
    client,
    `Fire it up, method ${method.toUpperCase()}, ${fmtDuration(seconds).slice(1)}`,
    build,
    "json",
    [
      "The fan will run at up to 100%.",
      `This command stays in the foreground and sends stop ${grace ? `${grace}s after` : "at"} the end of the timer.`,
      "Ctrl-C sends stop immediately. If this process is killed, only the device timer can stop it.",
    ],
  );

  const started = nowS();
  const res = await client.postCook(build(started), "json");
  console.log(`\nSent.  HTTP ${res.status}  ${res.body.trim() || "(empty body)"}`);
  const endAt = started + seconds;
  const stopAt = endAt + grace;

  let stopping: Promise<void> | null = null;
  let deviceStoppedAt: number | null = null;

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      console.log(`\nSending stop (${reason})…`);
      const send = async (payload: Payload, label: string) => {
        try {
          const r = await client.postCook(payload, "json");
          console.log(`  ${label}: HTTP ${r.status}  ${r.body.trim() || "(empty body)"}`);
        } catch (err) {
          console.log(`  ${label} FAILED: ${(err as Error).message}`);
        }
      };
      await send(grillStop(method, nowS()), method === "a" ? "grill-mode stop" : "stop cook");
      await sleep(SETTLE_MS);
      let d = await trySnapshot(client);
      if (method === "a" && (d === null || isRunning(d))) {
        console.log("  Still running (or unknown) after grill-mode stop: sending full stop cook.");
        await send(stopCook(nowS()), "stop cook");
        await sleep(SETTLE_MS);
        d = await trySnapshot(client);
      }
      if (d === null) {
        console.log("\n!!! Could not confirm the device stopped. CHECK THE GRILL.");
      } else if (isRunning(d)) {
        console.log(`\n!!! DEVICE STILL REPORTS RUNNING (${statusLine(d)}). Stop it at the grill.`);
      } else {
        console.log(`Stopped: ${statusLine(d)}`);
      }
      if (deviceStoppedAt !== null) {
        console.log(
          `Device reported nothing running at ${fmtDuration(deviceStoppedAt - endAt)} relative to the timer end.`,
        );
      } else {
        console.log("Device never stopped on its own before Ember sent stop.");
      }
    })();
    return stopping;
  };

  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts > 1) {
      console.log("\nSecond Ctrl-C: exiting WITHOUT confirming the stop. CHECK THE GRILL.");
      process.exit(130);
    }
    stop("Ctrl-C").finally(() => process.exit(130));
  });

  while (!stopping && nowS() < stopAt) {
    const t = nowS();
    const phase = t < endAt ? `T${fmtDuration(t - endAt)}` : `grace ${fmtDuration(stopAt - t)}`;
    try {
      const { d } = await readData(client);
      if (deviceStoppedAt === null && !isRunning(d)) {
        deviceStoppedAt = t;
        console.log(`${phase}  device reports nothing running (acs=0, ag≠1, fan 0)`);
      }
      console.log(`${phase}  ${statusLine(d)}`);
    } catch (err) {
      console.log(`${phase}  poll failed: ${(err as Error).message}`);
    }
    const left = stopAt - nowS();
    if (left > 0) await sleep(Math.min(interval, left) * 1000);
  }
  await stop("timer");
}

// ---- Wiring ----

function intArg(name: string) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new InvalidArgumentError(`${name} must be a number`);
    return n;
  };
}

const program = new Command("device")
  .description("Talk to the real iKamand at IKAMAND_HOST (milestone 1 protocol spike).")
  .option("--timeout <ms>", "HTTP timeout", intArg("timeout"), 8000)
  .option("--no-log", "don't append requests/responses to captures/device-<date>.log");

const formHeader = new Option(
  "--form-header",
  "send Content-Type: application/x-www-form-urlencoded instead of the references' application/json",
);

program
  .command("info")
  .description("GET info (firmware, MAC, env)")
  .option("--raw", "raw response only")
  .action(cmdInfo);

program
  .command("data")
  .description("GET data once, decoded (°F and raw °C) plus the raw response")
  .option("--raw", "raw response only")
  .action(cmdData);

program
  .command("watch")
  .description("poll data and append each reading to a CSV in captures/ (read-only)")
  .option("--interval <s>", "seconds between polls", intArg("interval"), 5)
  .option("--out <file>", "CSV path (default captures/watch-<time>.csv)")
  .action(cmdWatch);

program
  .command("start")
  .description("start a cook, or change the pit target of a running one")
  .requiredOption("--pit <F>", "pit target in °F (150–700)", intArg("pit"))
  .option("--probe <n>", "test only: device food-probe slot p (1–3)", intArg("probe"))
  .option("--probe-target <F>", "test only: device food-probe target tft in °F", intArg("probe"))
  .addOption(formHeader)
  .action(cmdStart);

program.command("stop").description("stop the cook").addOption(formHeader).action(cmdStop);

program
  .command("grill")
  .description("Fire it up: fan flat out for a while, stopped by this command at the end")
  .requiredOption("--min <n>", "minutes (max 30; decimals allowed)", intArg("min"))
  .addOption(
    new Option("--method <a|b>", "A: native ag/sge grill mode. B: cook at 260 °C with short sce")
      .choices(["a", "b"])
      .makeOptionMandatory(),
  )
  .option(
    "--grace <s>",
    "wait this long after the timer before sending stop, to see if the device stops itself",
    intArg("grace"),
    0,
  )
  .addOption(
    new Option("--interval <s>", "seconds between polls")
      .argParser(intArg("interval"))
      .default(5)
      .hideHelp(),
  )
  .action(cmdGrill);

program
  .command("raw-post")
  .description("POST arbitrary k=v pairs to cook (ct=now is added unless given)")
  .argument("<pairs...>", "k=v pairs, e.g. acs=1 tpt=107")
  .addOption(formHeader)
  .action(cmdRawPost);

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
  } else {
    const cause = (err as Error & { cause?: Error }).cause;
    console.error(`Error: ${(err as Error).message}${cause ? ` (${cause.message})` : ""}`);
  }
  process.exit(1);
}
