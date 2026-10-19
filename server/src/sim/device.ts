// A fake iKamand that behaves like Phil's unit on firmware 1.0.56 (docs/protocol.md), including
// its faults. It runs on an injected Clock: a ManualClock in tests (stepped, instant) or a
// ScaledClock for sped-up playback. Physics is integrated lazily up to `clock.now()` whenever
// anything looks at the device.

import { type Clock, toUnixS } from "../device/clock.ts";
import type { Payload } from "../device/protocol.ts";
import {
  type FoodModel,
  holdingFanPct,
  pitEquilibriumC,
  stepFood,
  stepPit,
  stepProbeInAir,
} from "./physics.ts";
import { makeRng } from "./rng.ts";

export type ProbeSlot = 1 | 2 | 3;

export interface SimRequest {
  method: string;
  /** Path after `/cgi-bin/`, e.g. `data`. */
  path: string;
  fields: Record<string, string>;
}

/** What the device does with one request. The transport turns this into bytes or socket errors. */
export type SimOutcome =
  | { kind: "response"; status: number; body: string }
  /** Connection reset; a POST is not applied. */
  | { kind: "reset" }
  /** Accepts the connection and never answers. */
  | { kind: "timeout" }
  /** Web server down (it happened once for ~2½ min while the controller kept running). */
  | { kind: "refused" }
  /** Powered off or still booting: nothing on the network. */
  | { kind: "unreachable" };

export interface FaultConfig {
  /** Chance that a request starts a failure streak. */
  rate: number;
  /** Streaks last 1..streakMax requests (3 seen on a healthy device). */
  streakMax: number;
  /** Of failures, the share that are timeouts rather than resets (5 of 34 seen). */
  timeoutShare: number;
}

export interface SimOptions {
  seed?: number;
  ambientC?: number;
  /** HTTP starts answering this long after power-on (seen 19 s and 29 s). */
  httpReadyAfterS?: number;
  /** Pit and P1 read a bogus climbing value until this uptime (seen until ~33 s). */
  garbageUntilS?: number;
  /** The device sets its own clock this long after boot (seen 43–48 s and 259–339 s). */
  clockSelfSetAfterS?: number;
  faults?: Partial<FaultConfig>;
  /** Chance that a request arriving while another is in flight is reset. */
  overlapResetRate?: number;
}

interface Probe {
  plugged: boolean;
  inMeat: boolean;
  food: FoodModel | null;
  tempC: number;
}

interface TimelineEvent {
  atMs?: number;
  when?: (sim: SimDevice) => boolean;
  label: string;
  run: (sim: SimDevice) => void;
  done: boolean;
}

/** Field order of a real 1.0.56 `data` response. It never includes sce, p or tft. */
const DATA_ORDER = [
  "time",
  "rm",
  "acs",
  "csid",
  "cm",
  "ag",
  "as",
  "pt",
  "t1",
  "t2",
  "t3",
  "dc",
  "tpt",
] as const;

const STEP_MS = 1000;
const NO_PROBE = "400";

export class SimDevice {
  readonly ambientC: number;
  readonly log: (SimRequest & { atMs: number; outcome: SimOutcome["kind"] })[] = [];
  /** Highest number of requests ever in flight at once (1 if the client serializes). */
  maxConcurrency = 0;

  private readonly rng: () => number;
  private readonly opts: Required<Omit<SimOptions, "faults" | "seed" | "ambientC">>;
  private faults: FaultConfig;
  private failStreak = 0;
  private streakJustEnded = false;
  private forced: ("reset" | "timeout" | "refused")[] = [];
  private inFlight = 0;

  // Firmware state
  private powered = true;
  private offUntilMs: number | null = null;
  private bootAtMs: number;
  /** Device clock = real clock + offset; null while unset (then `time` is seconds since boot). */
  private clockOffsetMs: number | null = 0;
  private acs = false;
  private tptC = 0;
  /** Scheduled cook end, Unix s. Kept internally, never reported. */
  private sce = 0;
  private dc = 0;
  private cookStartedMs = 0;
  private webDownUntilMs = 0;
  private fanPlugged = true;

  // Physics
  private fireLit = false;
  private pitC: number;
  private readonly probes: Record<ProbeSlot, Probe>;
  private lastMs: number;
  private readonly timeline: TimelineEvent[] = [];

  constructor(
    readonly clock: Clock,
    options: SimOptions = {},
  ) {
    this.rng = makeRng(options.seed ?? 1);
    this.ambientC = options.ambientC ?? 22;
    this.opts = {
      httpReadyAfterS: options.httpReadyAfterS ?? 29,
      garbageUntilS: options.garbageUntilS ?? 34,
      clockSelfSetAfterS: options.clockSelfSetAfterS ?? 45,
      overlapResetRate: options.overlapResetRate ?? 0.8,
    };
    this.faults = { rate: 0, streakMax: 3, timeoutShare: 0.15, ...options.faults };
    this.lastMs = clock.now();
    // Powered on long ago with its clock set.
    this.bootAtMs = this.lastMs - 3_600_000;
    this.pitC = this.ambientC;
    const unplugged = (): Probe => ({
      plugged: false,
      inMeat: false,
      food: null,
      tempC: this.ambientC,
    });
    this.probes = { 1: unplugged(), 2: unplugged(), 3: unplugged() };
  }

  // ---- Scenario controls ----

  /** Put food on a probe (plugs it in). */
  insertProbe(slot: ProbeSlot, food: FoodModel): void {
    this.probes[slot] = { plugged: true, inMeat: true, food, tempC: food.startC };
  }

  unplugProbe(slot: ProbeSlot): void {
    this.probes[slot].plugged = false;
  }

  /** The probe comes out of the meat and is laid down: it falls to ambient. */
  removeFromMeat(slot: ProbeSlot): void {
    this.probes[slot].inMeat = false;
  }

  setFanPlugged(plugged: boolean): void {
    this.fanPlugged = plugged;
  }

  /** Cut the power for `offS`, then boot: cook lost, clock unset, garbage readings. */
  powerCycle(offS: number): void {
    this.advance();
    this.powered = false;
    this.offUntilMs = this.clock.now() + offS * 1000;
    this.acs = false;
    this.dc = 0;
  }

  /** The web server refuses connections for `durS`; the controller and cook carry on. */
  webOutage(durS: number): void {
    this.webDownUntilMs = this.clock.now() + durS * 1000;
  }

  setFaults(faults: Partial<FaultConfig>): void {
    this.faults = { ...this.faults, ...faults };
  }

  /** The next requests fail this way, in order, before any random fault. */
  failNext(...kinds: ("reset" | "timeout" | "refused")[]): void {
    this.forced.push(...kinds);
  }

  /** Another client (e.g. Home Assistant) sends a command. */
  foreignCommand(payload: Payload): void {
    this.advance();
    this.applyCook(Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])));
  }

  /** Run `run` at `atMs` (absolute clock time) or the first time `when` is true. */
  schedule(
    event: { atMs?: number; when?: (sim: SimDevice) => boolean; label: string },
    run: (sim: SimDevice) => void,
  ): void {
    this.timeline.push({ ...event, run, done: false });
  }

  // ---- Introspection ----

  /** A probe's true temperature right now, without advancing time (safe inside `when`). */
  probeC(slot: ProbeSlot): number {
    return this.probes[slot].tempC;
  }

  /** True (un-noised) temperatures and firmware state, without going through HTTP. */
  get truth() {
    this.advance();
    return {
      powered: this.powered,
      acs: this.acs,
      tptC: this.tptC,
      sce: this.sce,
      dc: this.dc,
      pitC: this.pitC,
      probeC: { 1: this.probes[1].tempC, 2: this.probes[2].tempC, 3: this.probes[3].tempC },
      clockSet: this.clockOffsetMs !== null,
      deviceTimeS: this.deviceTimeS(),
      uptimeS: this.uptimeS(),
    };
  }

  // ---- The device ----

  /** Handle one request. `concurrent` wraps this for transports that can overlap requests. */
  handle(req: SimRequest): SimOutcome {
    this.advance();
    const outcome = this.decide(req);
    this.log.push({ ...req, atMs: this.clock.now(), outcome: outcome.kind });
    return outcome;
  }

  /** Mark a request in flight for overlap detection; call the returned function when done. */
  begin(): { overlapped: boolean; end: () => void } {
    this.inFlight++;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.inFlight);
    return {
      overlapped: this.inFlight > 1,
      end: () => {
        this.inFlight--;
      },
    };
  }

  /** As `handle`, but a request that overlaps another is likely reset (protocol.md › Commands). */
  handleOverlapping(req: SimRequest, overlapped: boolean): SimOutcome {
    if (overlapped && this.rng() < this.opts.overlapResetRate) {
      this.advance();
      this.log.push({ ...req, atMs: this.clock.now(), outcome: "reset" });
      return { kind: "reset" };
    }
    return this.handle(req);
  }

  private decide(req: SimRequest): SimOutcome {
    if (!this.powered || this.uptimeS() < this.opts.httpReadyAfterS) return { kind: "unreachable" };
    if (this.clock.now() < this.webDownUntilMs) return { kind: "refused" };

    const forced = this.forced.shift();
    if (forced) return { kind: forced };
    // A streak is followed by at least one good answer, so streaks never run together.
    const afterStreak = this.streakJustEnded;
    this.streakJustEnded = false;
    if (
      this.failStreak > 0 ||
      (!afterStreak && this.faults.rate > 0 && this.rng() < this.faults.rate)
    ) {
      if (this.failStreak === 0) {
        this.failStreak = 1 + Math.floor(this.rng() * this.faults.streakMax);
      }
      this.failStreak--;
      this.streakJustEnded = this.failStreak === 0;
      return { kind: this.rng() < this.faults.timeoutShare ? "timeout" : "reset" };
    }

    if (req.method === "GET" && req.path === "info") {
      return ok("fw_version=1.0.56&env=v1-0011223344AA&MAC=0011223344AA");
    }
    if (req.method === "GET" && req.path === "data") return ok(this.dataBody());
    if (req.method === "POST" && req.path === "cook") {
      this.applyCook(req.fields);
      return ok("");
    }
    return { kind: "response", status: 404, body: "" };
  }

  private applyCook(f: Record<string, string>): void {
    if (f.ct !== undefined && Number(f.ct) > 0) {
      // Any command's ct sets the clock at once (VERIFIED).
      this.clockOffsetMs = Number(f.ct) * 1000 - this.clock.now();
    }
    if (f.acs === "1") {
      if (!this.acs) this.cookStartedMs = this.clock.now();
      this.acs = true;
      this.fireLit = true;
      if (f.tpt !== undefined) this.tptC = Number(f.tpt);
      if (f.sce !== undefined) this.sce = Number(f.sce);
      this.dc = this.controllerDc();
    } else if (f.acs === "0") {
      this.acs = false;
      this.tptC = f.tpt !== undefined ? Number(f.tpt) : 0;
      this.sce = 0;
      this.dc = 0;
    }
    // ag/sge (method A) and p/tft are accepted and do nothing on 1.0.56.
  }

  private dataBody(): string {
    const garbage = this.uptimeS() < this.opts.garbageUntilS;
    const bogus = String(Math.round(4.8 * this.uptimeS() - 7.2));
    const temp = (c: number) => String(Math.round(c + (this.rng() - 0.5) * 1.2));
    const probe = (slot: ProbeSlot) => {
      if (slot === 1 && garbage) return bogus;
      const p = this.probes[slot];
      return p.plugged ? temp(p.tempC) : NO_PROBE;
    };
    const values: Record<(typeof DATA_ORDER)[number], string> = {
      time: String(this.deviceTimeS()),
      rm: this.acs ? "1" : "0",
      acs: this.acs ? "1" : "0",
      csid: "",
      cm: "0",
      ag: "0",
      as: "0",
      pt: garbage ? bogus : temp(this.pitC),
      t1: probe(1),
      t2: probe(2),
      t3: probe(3),
      dc: String(this.dc),
      tpt: String(this.tptC),
    };
    return DATA_ORDER.map((k) => `${k}=${encodeURIComponent(values[k])}`).join("&");
  }

  private uptimeS(): number {
    return Math.floor((this.clock.now() - this.bootAtMs) / 1000);
  }

  private deviceTimeS(): number {
    return this.clockOffsetMs === null
      ? this.uptimeS()
      : toUnixS(this.clock.now() + this.clockOffsetMs);
  }

  /** What the controller reads as the pit: garbage right after boot, like the real one. */
  private sensedPitC(): number {
    if (this.uptimeS() < this.opts.garbageUntilS) return 4.8 * this.uptimeS() - 7.2;
    return this.pitC;
  }

  private controllerDc(): number {
    if (!this.acs) return 0;
    const error = this.tptC - this.sensedPitC();
    // Flat out for the first few seconds of a cold start (80 % then 100 % was seen).
    if (this.clock.now() - this.cookStartedMs < 3000 && error > 20) return 80;
    const dc = holdingFanPct(this.ambientC, this.tptC) + 5 * error;
    return Math.round(Math.min(100, Math.max(0, dc)));
  }

  /** Integrate physics and firmware timers up to now, firing due timeline events in order. */
  advance(): void {
    const target = this.clock.now();
    while (this.lastMs < target) {
      const next = Math.min(target, this.lastMs + STEP_MS);
      this.step(next);
      this.runDue();
    }
    this.runDue();
  }

  private runDue(): void {
    for (const e of this.timeline) {
      if (e.done) continue;
      const due = e.atMs !== undefined ? this.lastMs >= e.atMs : (e.when?.(this) ?? false);
      if (due) {
        e.done = true;
        e.run(this);
      }
    }
  }

  private step(toMs: number): void {
    const dtS = (toMs - this.lastMs) / 1000;
    this.lastMs = toMs;

    if (!this.powered && this.offUntilMs !== null && toMs >= this.offUntilMs) {
      // Boot: the cook is lost (VERIFIED) and the clock is unset until ct or a self-set.
      this.powered = true;
      this.bootAtMs = this.offUntilMs;
      this.offUntilMs = null;
      this.clockOffsetMs = null;
      this.acs = false;
      this.tptC = 0;
      this.sce = 0;
      this.dc = 0;
    }
    if (
      this.powered &&
      this.clockOffsetMs === null &&
      this.uptimeS() >= this.opts.clockSelfSetAfterS
    ) {
      this.clockOffsetMs = 0;
    }
    if (this.acs && this.clockOffsetMs !== null && this.sce > 0 && this.deviceTimeS() >= this.sce) {
      // The device ends the cook itself at sce, leaving tpt set (VERIFIED).
      this.acs = false;
      this.dc = 0;
    }
    if (this.acs) this.dc = this.controllerDc();

    const fan = this.fanPlugged ? this.dc : 0;
    this.pitC = stepPit(this.pitC, pitEquilibriumC(this.ambientC, fan, this.fireLit), dtS);
    for (const p of Object.values(this.probes)) {
      if (p.inMeat && p.food) p.tempC = stepFood(p.tempC, this.pitC, p.food, dtS);
      else if (!p.inMeat) p.tempC = stepProbeInAir(p.tempC, this.ambientC, dtS);
    }
  }
}

function ok(body: string): SimOutcome {
  return { kind: "response", status: 200, body };
}
