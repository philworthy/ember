// The session/item engine (docs/brief.md › Behaviour). It listens to the device link, stores every
// reading, keeps sessions and items in the DB, spots items reaching target or coming off and the
// cook looking done, runs the user's commands, and publishes a live state and domain events for
// SSE (and, from M6, web push). All state worth keeping is in the DB, so a restart rebuilds it.

import { EventEmitter } from "node:events";
import {
  type CookEvent,
  type CookEventType,
  cToDisplayF,
  type FireUpOutcome,
  type Food,
  foodName,
  type Item,
  type ItemEndReason,
  type LiveState,
  type ProbeSetup,
  type ProbeSlot,
  type Reading,
  type Session,
  type SessionOrigin,
  type TargetSource,
} from "@ember/shared";
import { COOK } from "../config.ts";
import type { Store } from "../db/store.ts";
import type { Clock } from "../device/clock.ts";
import type { CommandResult, DeviceEvents, DeviceLink } from "../device/device.ts";
import type { Command, Intent } from "../device/machine.ts";
import type { Catalog } from "./catalog.ts";
import {
  estimate,
  type ItemTrack,
  itemStats,
  newTrack,
  pitFalling,
  pitStatus,
  type Sample,
  type TrackOutcome,
  trackReading,
} from "./detect.ts";

export const SLOTS: ProbeSlot[] = [1, 2, 3];
const SLOT_KEY = { 1: "t1C", 2: "t2C", 3: "t3C" } as const;
/** Readings kept in memory per channel: enough for the estimate and the pit-falling check. */
const BUFFER_MS = 30 * 60_000;

/** Settings keys. */
export const SETTING = {
  linkRestore: "link.restore",
  probeSetup: "probe.setup",
  nextPitC: "cook.nextPitC",
} as const;

export interface LinkRestore {
  intent: Intent;
  sceSentS: number | null;
}

/** A command the user can't make right now (400 invalid, 404 nothing there, 409 wrong state). */
export class CommandError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface Accepted {
  /** Follow the device's read-back on SSE as a `commandResult` event; null when nothing is sent. */
  id: string | null;
  sessionId: number | null;
}

export interface AssignProbe {
  food: Food | null;
  weightLb?: number | null;
  targetC?: number;
}

type EngineEvents = { event: [CookEvent]; state: [LiveState] };

export interface CookEngineOptions {
  store: Store;
  link: DeviceLink;
  clock: Clock;
  catalog: Catalog;
  /** How fast `clock` runs against real time (the sped-up simulator); 1 by default. */
  clockRate?: number;
  log?: (msg: string, data?: unknown) => void;
}

/** The DeviceLink restore for a server start: saved intent and sce, last reading time. */
export function linkRestoreFrom(store: Store) {
  const saved = store.getSetting<LinkRestore>(SETTING.linkRestore);
  return {
    intent: saved?.intent,
    sceSentS: saved?.sceSentS ?? null,
    lastGoodReadingMs: store.lastReadingTs(),
  };
}

export class CookEngine extends EventEmitter<EngineEvents> {
  private readonly store: Store;
  private readonly link: DeviceLink;
  private readonly clock: Clock;
  private readonly catalog: Catalog;
  private readonly clockRate: number;
  private readonly log: (msg: string, data?: unknown) => void;

  private session: Session | null;
  private readonly tracks = new Map<ProbeSlot, { itemId: number; track: ItemTrack }>();
  private readonly buffers: Record<"pit" | ProbeSlot, Sample[]> = { pit: [], 1: [], 2: [], 3: [] };
  private latest: Reading | null = null;
  private foreignControlAt: number | null = null;
  private halted = false;
  private wasOffline = false;
  private nextCommand = 1;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(opts: CookEngineOptions) {
    super();
    this.store = opts.store;
    this.link = opts.link;
    this.clock = opts.clock;
    this.catalog = opts.catalog;
    this.clockRate = opts.clockRate ?? 1;
    this.log = opts.log ?? (() => {});
    this.session = this.store.openSession();
    this.restore();
    this.subscribe();
  }

  /** Stop listening to the link (the link itself is stopped by its owner). */
  close(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  // ---------------------------------------------------------------- commands

  /** Start cook: opens a session (with items for set-up probes) or retargets the open one. */
  start(pitC: number): Accepted {
    this.checkPit(pitC);
    const sessionId = this.store.transaction(() => {
      this.closeFireUp("stopped");
      if (this.session) this.recordPit(pitC, "user");
      else this.openSession("user", pitC, "user");
      this.clearLooksDone();
      this.store.setSetting(SETTING.nextPitC, pitC);
      return this.session?.id ?? null;
    });
    const id = this.issue({ kind: "start", tptC: pitC });
    this.publish();
    return { id, sessionId };
  }

  /** Change the pit target. With no cook running it's saved for the next Start. */
  retarget(pitC: number): Accepted {
    this.checkPit(pitC);
    const intent = this.link.snapshot.intent;
    if (intent.kind === "fireUp") {
      throw new CommandError(409, "Fire it up is running; stop it or wait for it to finish");
    }
    this.store.setSetting(SETTING.nextPitC, pitC);
    if (intent.kind === "idle") {
      this.publish();
      return { id: null, sessionId: this.session?.id ?? null };
    }
    if (this.session) this.recordPit(pitC, "user");
    else this.openSession("adopted", pitC, "user");
    this.clearLooksDone();
    const id = this.issue({ kind: "start", tptC: pitC });
    this.publish();
    return { id, sessionId: this.session?.id ?? null };
  }

  /** Stop the fan (and Fire it up). The session stays open; "Looks done" takes it from there. */
  stop(): Accepted {
    this.closeFireUp("stopped");
    const id = this.issue({ kind: "stop" });
    this.publish();
    return { id, sessionId: this.session?.id ?? null };
  }

  /** End cook: stop the device and close the session and its items. */
  end(): Accepted {
    const sessionId = this.session?.id ?? null;
    const id = this.issue({ kind: "stop" });
    if (this.session) this.endSession("user");
    else this.closeFireUp("stopped");
    this.publish();
    return { id, sessionId };
  }

  /**
   * Fire it up for `minutes`. With "then hold" it opens a session now (if none is open) and holds
   * `thenHoldC` when the timer ends; without it the device stops at the end.
   */
  fireUp(minutes: number, thenHoldC: number | null): Accepted {
    const { min, max } = COOK.limits.fireUpMin;
    if (!Number.isFinite(minutes) || minutes < min || minutes > max) {
      throw new CommandError(400, `minutes must be ${min}–${max}`);
    }
    if (thenHoldC !== null) this.checkPit(thenHoldC);
    const sessionId = this.store.transaction(() => {
      this.closeFireUp("stopped");
      if (!this.session && thenHoldC !== null) this.openSession("fireUp", null, "fireUp");
      this.clearLooksDone();
      if (thenHoldC !== null) this.store.setSetting(SETTING.nextPitC, thenHoldC);
      const f = this.store.insertFireUp({
        sessionId: this.session?.id ?? null,
        startedAt: this.clock.now(),
        minutes,
        thenHoldC,
      });
      this.event("fireUpStarted", { fireUpId: f.id, minutes, thenHoldC });
      return this.session?.id ?? null;
    });
    const id = this.issue({ kind: "fireUp", minutes, thenHoldC });
    this.publish();
    return { id, sessionId };
  }

  /** Keep going: dismiss "Looks like you're done" until its conditions clear and return. */
  keepGoing(): Accepted {
    const s = this.session;
    if (!s?.looksDoneAt) throw new CommandError(409, "Nothing to keep going from");
    this.session = this.store.updateSession(s.id, {
      looksDoneAt: null,
      keepGoingAt: this.clock.now(),
    });
    this.event("keepGoing", {});
    this.publish();
    return { id: null, sessionId: s.id };
  }

  /**
   * Put a food on a probe. In a session: edits the active item, or starts a new one (Reuse probe).
   * Otherwise it's set up for the next Start. The target defaults to the catalog's "pull at".
   */
  assignProbe(slot: ProbeSlot, a: AssignProbe): Accepted {
    this.checkFood(a.food);
    const weightLb = a.weightLb ?? null;
    if (weightLb !== null) {
      const { min, max } = COOK.limits.weightLb;
      if (!Number.isFinite(weightLb) || weightLb <= min || weightLb > max) {
        throw new CommandError(400, `weightLb must be over ${min} and at most ${max}`);
      }
    }
    const active = this.activeItem(slot);
    const setup = this.setups()[slot] ?? null;
    const targetC =
      a.targetC ??
      (a.food && "path" in a.food ? this.catalog.pullAtC(a.food.path) : null) ??
      active?.targetC ??
      setup?.targetC;
    if (targetC === undefined || targetC === null) {
      throw new CommandError(400, "targetC is required for a custom food");
    }
    this.checkProbe(targetC);

    if (!this.session) {
      this.saveSetup(slot, { food: a.food, weightLb, targetC });
      this.publish();
      return { id: null, sessionId: null };
    }
    this.store.transaction(() => {
      if (active) {
        if (targetC !== active.targetC) this.retargetItem(active, targetC);
        const item = this.store.updateItem(active.id, { food: a.food, weightLb });
        this.event("itemUpdated", { itemId: item.id, slot, name: foodName(item.food, slot) });
      } else {
        this.startItem(slot, a.food, weightLb, targetC);
      }
      this.updateTitle();
    });
    this.publish();
    return { id: null, sessionId: this.session.id };
  }

  /** Set a probe's target. With no food on it in a session, it starts a "Probe N" item. */
  setProbeTarget(slot: ProbeSlot, targetC: number): Accepted {
    this.checkProbe(targetC);
    const active = this.activeItem(slot);
    if (active) {
      this.retargetItem(active, targetC);
    } else if (this.session) {
      this.startItem(slot, null, null, targetC);
      this.updateTitle();
    } else {
      const setup = this.setups()[slot];
      this.saveSetup(slot, {
        food: setup?.food ?? null,
        weightLb: setup?.weightLb ?? null,
        targetC,
      });
    }
    this.publish();
    return { id: null, sessionId: this.session?.id ?? null };
  }

  /** Take the food off a probe: ends its item (reason `user`) or clears its setup. */
  clearProbe(slot: ProbeSlot): Accepted {
    const active = this.activeItem(slot);
    if (active) {
      this.endItem(active, "user", this.clock.now(), this.slotTemp(slot));
    } else if (!this.session && this.setups()[slot]) {
      this.saveSetup(slot, null);
    } else {
      throw new CommandError(404, `Nothing on probe ${slot}`);
    }
    this.publish();
    return { id: null, sessionId: this.session?.id ?? null };
  }

  // ---------------------------------------------------------------- live state

  live(): LiveState {
    const snap = this.link.snapshot;
    const intent = snap.intent;
    const now = this.clock.now();
    const active = intent.kind !== "idle";
    const nextPitC = this.store.getSetting<number>(SETTING.nextPitC) ?? COOK.defaultPitC;
    const pitTargetC =
      intent.kind === "cook"
        ? intent.tptC
        : intent.kind === "fireUp"
          ? (intent.thenHoldC ?? nextPitC)
          : nextPitC;
    const holdC = intent.kind === "cook" ? intent.tptC : null;
    const f = this.store.openFireUp();
    const s = this.session;
    const setups = this.setups();
    return {
      now,
      clockRate: this.clockRate,
      link: {
        state: snap.link,
        lastSeenMs: snap.lastGoodReadingMs,
        halted: this.halted,
        foreignControlAt: this.foreignControlAt,
      },
      reading: this.latest,
      cook: {
        active,
        pitTargetC,
        status: pitStatus(this.latest?.pitC ?? null, holdC, active),
      },
      fireUp:
        f && intent.kind === "fireUp"
          ? {
              startedAt: f.startedAt,
              endsAtMs: intent.endsAtMs,
              minutes: f.minutes,
              thenHoldC: f.thenHoldC,
            }
          : null,
      session: s
        ? {
            ...s,
            foundRunning: s.origin === "adopted",
            autoEndAt:
              s.looksDoneAt === null ? null : s.looksDoneAt + COOK.looksDone.autoEndAfterMs,
            pitTargets: this.store.targets(s.id).filter((t) => t.subject === "pit"),
          }
        : null,
      probes: SLOTS.map((slot) => {
        const item = this.activeItem(slot) ?? (s ? this.store.lastItem(s.id, slot) : null);
        return {
          slot,
          tempC: this.latest?.[SLOT_KEY[slot]] ?? null,
          item,
          setup: s ? null : (setups[slot] ?? null),
          estimate:
            item && item.endedAt === null
              ? estimate(this.buffers[slot], item.targetC, this.latest?.ts ?? now)
              : null,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- device events

  private subscribe(): void {
    const on = <K extends keyof DeviceEvents>(type: K, fn: (e: DeviceEvents[K][0]) => void) => {
      // A listener error must never break the device link (it would stop polling).
      const guarded = ((e: DeviceEvents[K][0]) => {
        try {
          fn(e);
        } catch (err) {
          this.log(`cook engine: ${type} handler failed`, err);
        }
      }) as never;
      this.link.on(type, guarded);
      this.unsubscribe.push(() => this.link.off(type, guarded));
    };

    on("intent", (e) => this.store.setSetting(SETTING.linkRestore, e satisfies LinkRestore));
    on("reading", (e) => this.onReading(e.reading));
    on("link", (e) => {
      if (e.state === "offline") {
        this.wasOffline = true;
        this.event("deviceOffline", { previous: e.previous });
      } else if (e.state === "online" && this.wasOffline) {
        this.wasOffline = false;
        this.event("deviceOnline", {});
      }
      this.publish();
    });
    on("adopted", (e) => {
      if (this.session) this.recordPit(e.tptC, "adopted");
      else this.openSession("adopted", e.tptC, "adopted");
      this.clearLooksDone();
      this.event("foundRunning", { tptC: e.tptC });
    });
    on("recovery", (e) => {
      this.event("recovery", { action: e.action, device: e.device });
      if (e.action === "resume" && !this.session && e.intent.kind === "cook") {
        // The DB lost the session but the link kept the cook: track it like a found one.
        this.openSession("adopted", e.intent.tptC, "adopted");
      }
      if (e.action === "fireUpEnded") this.finishFireUp(e.intent.kind === "cook" ? "hold" : "stop");
      this.publish();
    });
    on("foreignControl", (e) => {
      this.foreignControlAt = this.clock.now();
      this.event("foreignControl", { before: e.before, after: e.after });
      if (e.after.acs) {
        if (!this.session) this.openSession("foreign", e.after.tptC, "foreign");
        else if (this.store.lastPitTarget(this.session.id)?.targetC !== e.after.tptC) {
          this.recordPit(e.after.tptC, "foreign");
        }
        this.clearLooksDone();
      }
      this.closeFireUp("stopped");
      this.publish();
    });
    on("selfStopped", (e) => {
      this.event("selfStopped", { tptC: e.tptC });
      this.publish();
    });
    on("fireUpEnded", (e) => {
      this.finishFireUp(e.next);
      this.publish();
    });
    on("halted", (e) => {
      this.halted = true;
      this.event("halted", { error: e.error.message });
      this.publish();
    });
    on("fault", (e) => this.log("device link fault", e));
  }

  private onReading(r: Reading): void {
    this.store.insertReading(r);
    this.latest = r;
    this.buffer(r);
    for (const slot of SLOTS) {
      const t = this.tracks.get(slot);
      if (t) this.onTrack(t.itemId, trackReading(t.track, r.ts, r[SLOT_KEY[slot]]));
    }
    this.checkLooksDone(r.ts);
    this.publish();
  }

  private buffer(r: Reading): void {
    const keep = (b: Sample[], c: number | null) => {
      b.push({ ts: r.ts, c });
      while (b.length && (b[0] as Sample).ts < r.ts - BUFFER_MS) b.shift();
    };
    keep(this.buffers.pit, r.pitC);
    for (const slot of SLOTS) keep(this.buffers[slot], r[SLOT_KEY[slot]]);
  }

  private onTrack(itemId: number, outcomes: TrackOutcome[]): void {
    for (const o of outcomes) {
      const item = this.store.item(itemId);
      if (!item || item.endedAt !== null) return;
      if (o.kind === "reached") {
        this.store.updateItem(itemId, { reachedTargetAt: o.ts });
        this.event("itemAtTarget", {
          itemId,
          slot: item.slot,
          name: foodName(item.food, item.slot),
          tempC: o.c,
          targetC: item.targetC,
        });
      } else {
        this.endItem(item, o.reason, o.ts, o.c);
      }
    }
  }

  /**
   * Looks done: no active items, and the cook is no longer meant to run (stopped by the user, the
   * device's sce or another client) or the pit has been falling for 15 min below the holding
   * band (the fire is dying). Prompt once; end the
   * session if nobody answers within the hour. Once up, the prompt stays until there's new
   * activity (see `clearLooksDone`): a dying fire that levels off is still done. Keep going holds
   * it off until the conditions clear and come back.
   */
  private checkLooksDone(now: number): void {
    const s = this.session;
    if (!s) return;
    const intent = this.link.snapshot.intent;
    const idle = intent.kind === "idle";
    // While holding, a pit falling back to its target (Fire it up overshot, or the target was
    // lowered) isn't a dying fire: only a fall below the holding band counts.
    const pitC = this.latest?.pitC ?? null;
    const dying =
      intent.kind === "cook" &&
      pitC !== null &&
      pitC < intent.tptC - COOK.holdingBandC &&
      pitFalling(this.buffers.pit);
    const done = this.tracks.size === 0 && (idle || dying);
    if (s.looksDoneAt !== null) {
      if (now < s.looksDoneAt + COOK.looksDone.autoEndAfterMs) return;
      if (!idle) this.issue({ kind: "stop" });
      this.endSession("auto");
    } else if (s.keepGoingAt !== null) {
      if (!done) this.session = this.store.updateSession(s.id, { keepGoingAt: null });
    } else if (done) {
      this.session = this.store.updateSession(s.id, { looksDoneAt: now });
      this.event("looksDone", {
        reason: idle ? "stopped" : "pitFalling",
        autoEndAt: now + COOK.looksDone.autoEndAfterMs,
      });
    }
  }

  /** New activity (a food on a probe, the cook started or retargeted) takes the prompt down. */
  private clearLooksDone(): void {
    const s = this.session;
    if (!s || (s.looksDoneAt === null && s.keepGoingAt === null)) return;
    this.session = this.store.updateSession(s.id, { looksDoneAt: null, keepGoingAt: null });
    if (s.looksDoneAt !== null) this.event("looksDoneCleared", {});
  }

  // ---------------------------------------------------------------- sessions and items

  private openSession(origin: SessionOrigin, pitC: number | null, source: TargetSource): void {
    const now = this.clock.now();
    const s = this.store.insertSession(now, origin, "");
    this.session = s;
    if (pitC !== null) {
      this.store.insertTarget({
        sessionId: s.id,
        itemId: null,
        ts: now,
        subject: "pit",
        targetC: pitC,
        source,
      });
    }
    this.event("sessionStarted", { origin, pitC });
    const setups = this.setups();
    for (const slot of SLOTS) {
      const setup = setups[slot];
      if (setup) this.startItem(slot, setup.food, setup.weightLb, setup.targetC);
    }
    this.store.setSetting(SETTING.probeSetup, {});
    this.updateTitle();
  }

  private endSession(by: "user" | "auto"): void {
    const s = this.session;
    if (!s) return;
    const now = this.clock.now();
    this.store.transaction(() => {
      for (const item of this.store.activeItems()) {
        this.endItem(item, "session_end", now, this.slotTemp(item.slot));
      }
      this.closeFireUp("stopped");
      this.store.updateSession(s.id, { endedAt: now, endedBy: by, looksDoneAt: null });
      this.event("sessionEnded", { endedBy: by });
    });
    this.session = null;
  }

  private recordPit(pitC: number, source: TargetSource): void {
    const s = this.session;
    if (!s) return;
    this.store.insertTarget({
      sessionId: s.id,
      itemId: null,
      ts: this.clock.now(),
      subject: "pit",
      targetC: pitC,
      source,
    });
    this.event("pitTarget", { targetC: pitC, source });
    if (!s.titleCustom && this.store.sessionItems(s.id).length === 0) this.updateTitle();
  }

  private startItem(
    slot: ProbeSlot,
    food: Food | null,
    weightLb: number | null,
    targetC: number,
  ): Item {
    const s = this.session as Session;
    const now = this.clock.now();
    const item = this.store.insertItem({
      sessionId: s.id,
      slot,
      food,
      weightLb,
      targetC,
      startedAt: now,
    });
    this.store.insertTarget({
      sessionId: s.id,
      itemId: item.id,
      ts: now,
      subject: `p${slot}`,
      targetC,
      source: "user",
    });
    this.tracks.set(slot, { itemId: item.id, track: newTrack(targetC) });
    this.clearLooksDone();
    this.event("itemStarted", { itemId: item.id, slot, name: foodName(food, slot), targetC });
    return item;
  }

  /** A new target can be reached again, so "reached" resets. */
  private retargetItem(item: Item, targetC: number): void {
    this.store.updateItem(item.id, { targetC, reachedTargetAt: null });
    this.store.insertTarget({
      sessionId: item.sessionId,
      itemId: item.id,
      ts: this.clock.now(),
      subject: `p${item.slot}`,
      targetC,
      source: "user",
    });
    const t = this.tracks.get(item.slot);
    if (t) {
      t.track.targetC = targetC;
      t.track.reached = false;
    }
  }

  private endItem(item: Item, reason: ItemEndReason, at: number, c: number | null): void {
    const readings = this.store.readings(item.startedAt, at);
    const stats = itemStats(readings, { ...item, reachedTargetAt: item.reachedTargetAt });
    this.store.updateItem(item.id, { endedAt: at, endReason: reason, cameOffC: c, stats });
    this.tracks.delete(item.slot);
    const data = {
      itemId: item.id,
      slot: item.slot,
      name: foodName(item.food, item.slot),
      reason,
      tempC: c,
      durationMs: at - item.startedAt,
    };
    this.event(reason === "removed" || reason === "unplugged" ? "itemCameOff" : "itemEnded", data);
  }

  /** Title from the foods ("Brisket & Pork butt"), or the pit target for a no-probe cook. */
  private updateTitle(): void {
    const s = this.session;
    if (!s || s.titleCustom) return;
    const names = [...new Set(this.store.sessionItems(s.id).map((i) => foodName(i.food, i.slot)))];
    const pit = this.store.lastPitTarget(s.id)?.targetC;
    const title = names.length
      ? names.join(" & ")
      : pit !== undefined
        ? `${cToDisplayF(pit)}° cook`
        : "Cook";
    if (title !== s.title) this.session = this.store.updateSession(s.id, { title });
  }

  // ---------------------------------------------------------------- Fire it up

  private finishFireUp(next: "hold" | "stop"): void {
    const f = this.store.openFireUp();
    if (!f) return;
    this.store.closeFireUp(f.id, this.clock.now(), next);
    const intent = this.link.snapshot.intent;
    if (next === "hold" && intent.kind === "cook") {
      if (this.session) this.recordPit(intent.tptC, "fireUp");
      else this.openSession("fireUp", intent.tptC, "fireUp");
    }
    this.event("fireUpFinished", { fireUpId: f.id, next });
  }

  private closeFireUp(outcome: FireUpOutcome): void {
    const f = this.store.openFireUp();
    if (f) this.store.closeFireUp(f.id, this.clock.now(), outcome);
  }

  // ---------------------------------------------------------------- plumbing

  /** Send a device command; its read-back result goes out as a `commandResult` event. */
  private issue(command: Command): string {
    const id = `c${this.nextCommand++}`;
    void this.link.command(command).then((r: CommandResult) => {
      try {
        this.event("commandResult", { id, command: command.kind, ...r }, !r.ok);
        this.publish();
      } catch (err) {
        this.log("cook engine: command result failed", err);
      }
    });
    return id;
  }

  private event(type: CookEventType, data: Record<string, unknown>, persist = true): void {
    const base = { ts: this.clock.now(), sessionId: this.session?.id ?? null, type, data };
    const ev = persist ? this.store.insertEvent(base) : { id: 0, ...base };
    this.emit("event", ev);
  }

  private publish(): void {
    if (this.listenerCount("state")) this.emit("state", this.live());
  }

  private activeItem(slot: ProbeSlot): Item | null {
    const t = this.tracks.get(slot);
    return t ? this.store.item(t.itemId) : null;
  }

  private slotTemp(slot: ProbeSlot): number | null {
    return this.latest?.[SLOT_KEY[slot]] ?? null;
  }

  private setups(): Partial<Record<ProbeSlot, ProbeSetup | null>> {
    return this.store.getSetting(SETTING.probeSetup) ?? {};
  }

  private saveSetup(slot: ProbeSlot, setup: ProbeSetup | null): void {
    this.store.setSetting(SETTING.probeSetup, { ...this.setups(), [slot]: setup });
  }

  private checkPit(pitC: number): void {
    const { min, max } = COOK.limits.pitC;
    if (!Number.isInteger(pitC) || pitC < min || pitC > max) {
      throw new CommandError(400, `pitC must be a whole number ${min}–${max}`);
    }
  }

  private checkProbe(targetC: number): void {
    const { min, max } = COOK.limits.probeC;
    if (!Number.isFinite(targetC) || targetC < min - 1e-6 || targetC > max + 1e-6) {
      throw new CommandError(400, `targetC must be ${min.toFixed(1)}–${max.toFixed(1)}`);
    }
  }

  private checkFood(food: Food | null): void {
    if (food === null) return;
    if ("path" in food) {
      if (!Array.isArray(food.path) || this.catalog.pullAtC(food.path) === null) {
        throw new CommandError(400, "food.path is not a food in the catalog");
      }
    } else if (typeof food.custom !== "string" || !food.custom.trim() || food.custom.length > 60) {
      throw new CommandError(400, "food.custom must be 1–60 characters");
    }
  }

  /** Rebuild in-memory state from the DB after a restart. */
  private restore(): void {
    const lastTs = this.store.lastReadingTs();
    if (lastTs === null) return;
    const recent = this.store.readings(lastTs - BUFFER_MS, lastTs);
    this.latest = recent.at(-1) ?? null;
    const windowFrom = lastTs - COOK.cameOff.windowMs;
    for (const item of this.store.activeItems()) {
      if (item.sessionId !== this.session?.id) continue;
      const maxC = this.store.maxProbeC(item.slot, item.startedAt, windowFrom - 1);
      this.tracks.set(item.slot, {
        itemId: item.id,
        track: newTrack(item.targetC, item.reachedTargetAt !== null, maxC),
      });
    }
    // Replay the last couple of minutes through the same rules, so a run of nulls or a drop that
    // straddled the restart still counts.
    for (const r of recent) {
      this.buffer(r);
      if (r.ts < windowFrom) continue;
      for (const slot of SLOTS) {
        const t = this.tracks.get(slot);
        const item = t && this.store.item(t.itemId);
        if (t && item && r.ts >= item.startedAt) {
          this.onTrack(t.itemId, trackReading(t.track, r.ts, r[SLOT_KEY[slot]]));
        }
      }
    }
  }
}
