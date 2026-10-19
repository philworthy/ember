// The device link's brain: offline detection, reboot recovery, command read-back, foreign-control
// detection and the sce / Fire it up timers, as a pure state machine. `step` takes the current
// state, one input and the time, and returns the next state plus effects (requests to send and
// events to emit). No IO and no timers, so every rule in docs/protocol.md is a table-style test.

import type { DeviceLinkState, Reading } from "@ember/shared";
import { toUnixS } from "./clock.ts";
import { type DecodedData, GRILL_B_TPT_C, type Payload, startCook, stopCook } from "./protocol.ts";
import { isJump, snapshot, type TempSnapshot } from "./sanity.ts";

export const TIMING = {
  pollMs: 5_000,
  /** Offline after this long without a successful response, not after N failures (quirk 5). */
  offlineAfterMs: 30_000,
  /** Recovery waits for this long of sane readings, because the controller acts on garbage too. */
  recoverySaneMs: 30_000,
  /** While the clock is unset, a reading only counts as sane from this uptime on. */
  saneUptimeS: 35,
  /** A valid device clock this far from ours means it lost track (rebooted, drifted). */
  maxSkewMs: 60_000,
  /** Push sce out to now + 24 h this often during a cook (protocol.md › Safety). */
  extendSceMs: 3_600_000,
  /** With "then hold", the device's sce sits this far past the server's timer. */
  fireUpHoldGraceS: 120,
  /** An acs 1 → 0 with tpt kept, up to this long after the sce Ember sent, is the device's own stop. */
  selfStopWindowS: 15,
  /** Sends per command before giving up (the first send plus two resends). */
  maxSends: 3,
};

export type Intent =
  | {
      kind: "idle";
      /**
       * Who made it idle. A cook found running is adopted unless Ember itself stopped it
       * (`ember`); `unknown` is a fresh server with nothing saved.
       */
      by: "unknown" | "ember" | "device";
    }
  | { kind: "cook"; tptC: number; origin: "user" | "adopted" | "foreign" }
  | { kind: "fireUp"; endsAtMs: number; thenHoldC: number | null };

export type Command =
  | { kind: "start"; tptC: number }
  | { kind: "stop" }
  | { kind: "fireUp"; minutes: number; thenHoldC: number | null };

export interface DeviceSnapshot {
  acs: boolean;
  tptC: number;
}

export type RecoveryAction = "resume" | "adopt" | "stop" | "fireUp" | "fireUpEnded";

export type DeviceEvent =
  | { type: "reading"; reading: Reading }
  | { type: "link"; state: DeviceLinkState; previous: DeviceLinkState }
  | { type: "recovery"; action: RecoveryAction; device: DeviceSnapshot; intent: Intent }
  | { type: "adopted"; tptC: number }
  | { type: "foreignControl"; before: DeviceSnapshot; after: DeviceSnapshot }
  | { type: "selfStopped"; tptC: number }
  | { type: "fireUpEnded"; next: "hold" | "stop" }
  | { type: "commandApplied"; ids: string[] }
  | { type: "commandFailed"; ids: string[]; reason: "no-readback" | "superseded" }
  | { type: "dropped"; reason: "clock-unset" | "jump" | "recovering" };

export type Effect =
  | { type: "send"; payload: Payload; reason: SendReason }
  | { type: "emit"; event: DeviceEvent };

export type SendReason = "command" | "resend" | "recovery" | "extend" | "fireUpEnd" | "adopt";

export type Input =
  /**
   * `stale`: a command was queued after this poll, so the data predates it and can't be used to
   * read the command back or to spot changes nobody commanded.
   */
  | { type: "poll"; ok: true; data: DecodedData; stale?: boolean }
  | { type: "poll"; ok: false }
  | { type: "command"; id: string; command: Command };

interface Pending {
  /** Command ids that resolve when this send is read back. */
  ids: string[];
  expect: DeviceSnapshot;
  sends: number;
}

export interface MachineState {
  link: DeviceLinkState;
  intent: Intent;
  /** The last sce Ember sent (Unix s). The device never reports it. */
  sceSentS: number | null;
  lastExtendMs: number | null;
  /** When the machine was created, for the offline clock before the first response. */
  sinceMs: number;
  lastSuccessMs: number | null;
  lastGoodReadingMs: number | null;
  failStreak: number;
  /** acs/tpt as last seen and accounted for. */
  observed: DeviceSnapshot | null;
  /** Temperatures of the previous successful response, for the jump check. */
  prevTemps: TempSnapshot | null;
  /** Set while waiting for sane readings after a reconnect. */
  recovery: { saneSinceMs: number | null } | null;
  pending: Pending | null;
  /** Commands accepted while not online; they resolve with recovery's send. */
  waiting: string[];
}

export interface Restore {
  intent?: Intent;
  sceSentS?: number | null;
  lastGoodReadingMs?: number | null;
}

export function initialState(nowMs: number, restore: Restore = {}): MachineState {
  return {
    link: "starting",
    intent: restore.intent ?? { kind: "idle", by: "unknown" },
    sceSentS: restore.sceSentS ?? null,
    lastExtendMs: null,
    sinceMs: nowMs,
    lastSuccessMs: null,
    lastGoodReadingMs: restore.lastGoodReadingMs ?? null,
    failStreak: 0,
    observed: null,
    prevTemps: null,
    recovery: null,
    pending: null,
    waiting: [],
  };
}

/** The full payload that makes the device match an intent (always the whole command, quirk 4). */
export function payloadFor(intent: Intent, nowMs: number): Payload {
  const now = toUnixS(nowMs);
  switch (intent.kind) {
    case "idle":
      return stopCook(now);
    case "cook":
      return startCook(intent.tptC, now);
    case "fireUp": {
      const grace = intent.thenHoldC === null ? 0 : TIMING.fireUpHoldGraceS;
      return startCook(GRILL_B_TPT_C, now, undefined, toUnixS(intent.endsAtMs) + grace);
    }
  }
}

export function expectedFor(intent: Intent): DeviceSnapshot {
  switch (intent.kind) {
    case "idle":
      return { acs: false, tptC: 0 };
    case "cook":
      return { acs: true, tptC: Math.round(intent.tptC) };
    case "fireUp":
      return { acs: true, tptC: GRILL_B_TPT_C };
  }
}

const same = (a: DeviceSnapshot, b: DeviceSnapshot) => a.acs === b.acs && a.tptC === b.tptC;

function deviceOf(d: DecodedData): DeviceSnapshot {
  return { acs: d.cookActive, tptC: d.targetPitC ?? 0 };
}

const DECODED_KEYS = new Set(["pt", "t1", "t2", "t3", "dc", "acs", "tpt"]);

export function toReading(d: DecodedData, nowMs: number): Reading {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.fields)) if (!DECODED_KEYS.has(k)) raw[k] = v;
  return {
    ts: nowMs,
    pitC: d.pitC,
    t1C: d.t1C,
    t2C: d.t2C,
    t3C: d.t3C,
    fanPct: d.fanPct ?? 0,
    cookActive: d.cookActive,
    targetPitC: d.targetPitC ?? 0,
    raw,
  };
}

/** Collects effects while a step mutates its own copy of the state. */
class Step {
  readonly effects: Effect[] = [];

  constructor(
    readonly s: MachineState,
    readonly now: number,
  ) {}

  emit(event: DeviceEvent): void {
    this.effects.push({ type: "emit", event });
  }

  setLink(state: DeviceLinkState): void {
    if (this.s.link === state) return;
    const previous = this.s.link;
    this.s.link = state;
    this.emit({ type: "link", state, previous });
  }

  /** Send the full command for the current intent and wait for its read-back. */
  send(reason: SendReason, ids: string[] = []): void {
    const payload = payloadFor(this.s.intent, this.now);
    this.effects.push({ type: "send", payload, reason });
    const sce = Number(payload.sce);
    this.s.sceSentS = sce > 0 ? sce : null;
    if (this.s.intent.kind === "cook") this.s.lastExtendMs = this.now;
    this.s.pending = { ids, expect: expectedFor(this.s.intent), sends: 1 };
  }

  /** A new command replaces whatever was in flight. */
  supersede(): void {
    const ids = [...(this.s.pending?.ids ?? []), ...this.s.waiting];
    if (ids.length) this.emit({ type: "commandFailed", ids, reason: "superseded" });
    this.s.pending = null;
    this.s.waiting = [];
  }
}

export function step(
  state: MachineState,
  input: Input,
  nowMs: number,
): {
  state: MachineState;
  effects: Effect[];
} {
  const st = new Step(structuredClone(state), nowMs);
  if (input.type === "command") onCommand(st, input.id, input.command);
  else if (input.ok) onData(st, input.data, input.stale ?? false);
  else onFailure(st);
  return { state: st.s, effects: st.effects };
}

function onCommand(st: Step, id: string, cmd: Command): void {
  const s = st.s;
  st.supersede();
  switch (cmd.kind) {
    case "stop":
      s.intent = { kind: "idle", by: "ember" };
      break;
    case "start":
      s.intent = { kind: "cook", tptC: Math.round(cmd.tptC), origin: "user" };
      break;
    case "fireUp":
      s.intent = {
        kind: "fireUp",
        endsAtMs: st.now + Math.round(cmd.minutes * 60) * 1000,
        thenHoldC: cmd.thenHoldC === null ? null : Math.round(cmd.thenHoldC),
      };
      break;
  }
  // Stop goes out at once whatever the link state (safety). Anything else waits for the device
  // to be online; recovery sends the latest intent when it acts.
  if (s.link === "online" || cmd.kind === "stop") st.send("command", [id]);
  else s.waiting.push(id);
}

function onFailure(st: Step): void {
  const s = st.s;
  s.failStreak++;
  const lastHeard = s.lastSuccessMs ?? s.sinceMs;
  if (s.link !== "offline" && st.now - lastHeard >= TIMING.offlineAfterMs) {
    s.recovery = null;
    st.setLink("offline");
  }
}

function onData(st: Step, d: DecodedData, stale: boolean): void {
  const s = st.s;
  const now = st.now;
  const device = deviceOf(d);
  s.failStreak = 0;
  s.lastSuccessMs = now;

  const temps = snapshot(d, now);
  const jump = isJump(s.prevTemps, temps);
  s.prevTemps = temps;

  // ---- Reconnect triggers: recovery runs once per trigger, not per poll ----
  // A reboot can't hide between polls: HTTP needs 19–29 s after power-on, so either the
  // failures last 30 s (offline) or the first answer has an unset clock.
  const skewed =
    d.valid && d.deviceTime !== null && Math.abs(d.deviceTime * 1000 - now) > TIMING.maxSkewMs;
  if (
    s.link !== "recovering" &&
    (s.link === "starting" || s.link === "offline" || !d.valid || skewed)
  ) {
    s.recovery = { saneSinceMs: null };
    if (s.pending) {
      s.waiting.push(...s.pending.ids);
      s.pending = null;
    }
    st.setLink("recovering");
  }

  if (s.link === "recovering" && s.recovery) {
    // A stop sent during recovery is still read back, so the user hears it landed.
    if (!stale && s.pending && same(s.pending.expect, device)) {
      st.emit({ type: "commandApplied", ids: s.pending.ids });
      s.pending = null;
    }
    const sane = !jump && (d.valid || (d.deviceTime ?? 0) >= TIMING.saneUptimeS);
    if (!sane) s.recovery.saneSinceMs = null;
    else s.recovery.saneSinceMs ??= now;
    st.emit({ type: "dropped", reason: !d.valid ? "clock-unset" : jump ? "jump" : "recovering" });
    if (s.recovery.saneSinceMs !== null && now - s.recovery.saneSinceMs >= TIMING.recoverySaneMs) {
      recover(st, device);
    }
    return;
  }

  // ---- Online ----
  if (jump) {
    st.emit({ type: "dropped", reason: "jump" });
  } else {
    s.lastGoodReadingMs = now;
    st.emit({ type: "reading", reading: toReading(d, now) });
  }

  if (stale) return;
  if (s.pending) verify(st, device);
  else if (s.observed && !same(s.observed, device)) unexpectedChange(st, s.observed, device);
  s.observed = device;

  timers(st, device);
}

/** Read-back after a command: a reset POST is not applied, so resend the full command. */
function verify(st: Step, device: DeviceSnapshot): void {
  const s = st.s;
  const p = s.pending;
  if (!p) return;
  if (same(p.expect, device)) {
    if (p.ids.length) st.emit({ type: "commandApplied", ids: p.ids });
    s.pending = null;
    return;
  }
  if (p.sends >= TIMING.maxSends) {
    st.emit({ type: "commandFailed", ids: p.ids, reason: "no-readback" });
    s.pending = null;
    return;
  }
  const ids = p.ids;
  const sends = p.sends + 1;
  st.send("resend", ids);
  if (s.pending) s.pending.sends = sends;
}

/** acs/tpt changed and Ember didn't command it: the device's own sce stop, or another client. */
function unexpectedChange(st: Step, before: DeviceSnapshot, after: DeviceSnapshot): void {
  const s = st.s;
  const nowS = toUnixS(st.now);
  const selfStop =
    before.acs &&
    !after.acs &&
    after.tptC === before.tptC &&
    s.sceSentS !== null &&
    nowS >= s.sceSentS &&
    nowS <= s.sceSentS + TIMING.selfStopWindowS + TIMING.pollMs / 1000;
  if (selfStop) {
    st.emit({ type: "selfStopped", tptC: after.tptC });
    if (s.intent.kind === "fireUp") {
      endFireUp(st, s.intent.thenHoldC);
    } else {
      s.intent = { kind: "idle", by: "device" };
      s.sceSentS = null;
    }
    return;
  }

  // Another client is controlling the device. Follow it rather than fight it (that's how Ember
  // and Home Assistant ping-ponged), and surface it.
  st.emit({ type: "foreignControl", before, after });
  if (after.acs) {
    s.intent = { kind: "cook", tptC: after.tptC, origin: "foreign" };
    // Its sce is unknown, so set a known one (same target: nothing changes on the grill).
    st.send("adopt");
  } else {
    s.intent = { kind: "idle", by: "device" };
    s.sceSentS = null;
  }
}

function timers(st: Step, device: DeviceSnapshot): void {
  const s = st.s;
  if (s.pending) return;
  if (s.intent.kind === "fireUp" && st.now >= s.intent.endsAtMs) {
    endFireUp(st, s.intent.thenHoldC);
    return;
  }
  if (
    s.intent.kind === "cook" &&
    device.acs &&
    (s.lastExtendMs === null || st.now - s.lastExtendMs >= TIMING.extendSceMs)
  ) {
    st.send("extend");
  }
}

/** Fire it up's server-side timer: hold the pit target, or a full stop (zeroing tpt). */
function endFireUp(st: Step, thenHoldC: number | null): void {
  const s = st.s;
  st.emit({ type: "fireUpEnded", next: thenHoldC === null ? "stop" : "hold" });
  s.intent =
    thenHoldC === null
      ? { kind: "idle", by: "ember" }
      : { kind: "cook", tptC: thenHoldC, origin: "user" };
  st.send("fireUpEnd");
}

/** After ~30 s of sane readings: reconcile the device with the intent, once. */
function recover(st: Step, device: DeviceSnapshot): void {
  const s = st.s;
  const ids = [...s.waiting, ...(s.pending?.ids ?? [])];
  s.waiting = [];
  s.pending = null;
  s.recovery = null;
  let action: RecoveryAction;

  switch (s.intent.kind) {
    case "cook":
      // Always resume, however long the device was gone (Phil, 2026-10-18).
      action = "resume";
      break;
    case "fireUp":
      if (st.now >= s.intent.endsAtMs) {
        action = "fireUpEnded";
        const hold = s.intent.thenHoldC;
        s.intent =
          hold === null
            ? { kind: "idle", by: "ember" }
            : { kind: "cook", tptC: hold, origin: "user" };
      } else {
        action = "fireUp";
      }
      break;
    case "idle":
      if (device.acs && s.intent.by !== "ember") {
        action = "adopt";
        s.intent = { kind: "cook", tptC: device.tptC, origin: "adopted" };
        st.emit({ type: "adopted", tptC: device.tptC });
      } else {
        // Harmless when idle, and its ct sets the clock.
        action = "stop";
      }
      break;
  }

  st.send("recovery", ids);
  st.emit({ type: "recovery", action, device, intent: s.intent });
  s.observed = device;
  st.setLink("online");
}
