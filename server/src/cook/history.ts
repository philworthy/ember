// History (docs/brief.md › History editing): the list, a past cook's detail, and trims. A trim
// only moves the session's window; readings are never deleted, and item stats are recalculated
// from them. Each trim works from what the cook engine recorded, so it can always be undone.

import {
  type CookDetail,
  type CookEdit,
  cToDisplayF,
  type Food,
  foodName,
  type HistoryEntry,
  type Item,
  type ItemStats,
  type ProbeSetup,
  type ProbeSlot,
  type Reading,
  type Session,
  type Span,
  type TargetChange,
} from "@ember/shared";
import { COOK, HISTORY } from "../config.ts";
import type { RecordedItem, RecordedSession, Store } from "../db/store.ts";
import type { Clock } from "../device/clock.ts";
import { itemStats } from "./detect.ts";
import { CommandError } from "./errors.ts";

type Cfg = typeof COOK;

const SLOT_KEY = { 1: "t1C", 2: "t2C", 3: "t3C" } as const;
const NO_STATS: ItemStats = {
  timeToTargetMs: null,
  stallStartAt: null,
  stallEndAt: null,
  stallStartC: null,
  stallEndC: null,
  avgPitC: null,
};

// ---- Pure rules ----

/** Title from the foods ("Brisket & Pork butt"), or the pit target for a no-probe cook. */
export function sessionTitle(
  items: { food: Food | null; slot: ProbeSlot }[],
  pitC: number | null,
): string {
  const names = [...new Set(items.map((i) => foodName(i.food, i.slot)))];
  if (names.length) return names.join(" & ");
  return pitC === null ? "Cook" : `${cToDisplayF(pitC)}° cook`;
}

/** A trim can leave an item with no time inside the cook; it stays, shown as outside. */
export function inWindow(item: Pick<Item, "startedAt" | "endedAt">): boolean {
  return item.endedAt === null || item.endedAt > item.startedAt;
}

function pitChanges(targets: TargetChange[]): TargetChange[] {
  return targets.filter((t) => t.subject === "pit").sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/** The pit target held longest inside the window (a reverse sear's last few minutes don't win). */
export function heldPitTarget(targets: TargetChange[], win: Span): number | null {
  const pits = pitChanges(targets);
  const held = new Map<number, number>();
  pits.forEach((t, i) => {
    const from = Math.max(t.ts, win.from);
    const to = Math.min(pits[i + 1]?.ts ?? Number.POSITIVE_INFINITY, win.to);
    if (to > from) held.set(t.targetC, (held.get(t.targetC) ?? 0) + to - from);
  });
  let best: number | null = null;
  for (const [c, ms] of held) if (best === null || ms > (held.get(best) as number)) best = c;
  return best ?? pits.at(-1)?.targetC ?? null;
}

/**
 * The pit card's stats over a cook's readings. Each pit target counts from when the pit first
 * came within the holding band of it, while the cook was running, so the heat-up and a cool-down
 * after Stop don't count. "Held within" is the 95th percentile of the distance from the target.
 */
export function pitStats(
  readings: Reading[],
  targets: TargetChange[],
  cfg: Cfg = COOK,
): CookDetail["pit"] {
  const pits = pitChanges(targets);
  let next = 0;
  let target: number | null = null;
  let armed = false;
  const devs: number[] = [];
  const held: number[] = [];
  const all: number[] = [];
  for (const r of readings) {
    while (next < pits.length && (pits[next] as TargetChange).ts <= r.ts) {
      const c = (pits[next++] as TargetChange).targetC;
      if (c !== target) armed = false;
      target = c;
    }
    if (r.pitC === null) continue;
    all.push(r.pitC);
    if (target === null || !r.cookActive) continue;
    const dev = Math.abs(r.pitC - target);
    if (dev <= cfg.holdingBandC) armed = true;
    if (!armed) continue;
    devs.push(dev);
    held.push(r.pitC);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  devs.sort((a, b) => a - b);
  return {
    avgC: mean(held) ?? mean(all),
    heldWithinC: devs.length ? (devs[Math.ceil(0.95 * devs.length) - 1] as number) : null,
  };
}

export interface TrimmedItem {
  startedAt: number;
  endedAt: number;
  reachedTargetAt: number | null;
  cameOffC: number | null;
  stats: ItemStats;
}

/**
 * Move an item with its session's new window, and recompute what depends on it. An item that
 * started with the session starts with the new window; one that ended with it (`session_end`)
 * ends with it; anything else keeps its own times, clipped to the window. `readings` must cover
 * both the recorded and the new window.
 */
export function trimItem(
  item: Pick<Item, "slot" | "targetC">,
  rec: RecordedItem,
  recSession: Span,
  win: Span,
  readings: Reading[],
  cfg: Cfg = COOK,
): TrimmedItem {
  const from = rec.startedAt <= recSession.from ? win.from : Math.max(rec.startedAt, win.from);
  const to = rec.endReason === "session_end" ? win.to : Math.min(rec.endedAt, win.to);
  if (to <= from) {
    const at = Math.min(Math.max(rec.startedAt, win.from), win.to);
    return { startedAt: at, endedAt: at, reachedTargetAt: null, cameOffC: null, stats: NO_STATS };
  }
  const key = SLOT_KEY[item.slot];
  const inWin = readings.filter((r) => r.ts >= from && r.ts <= to);

  // The engine watched [rec.startedAt, rec.endedAt] for the target, so its answer stands where it
  // still applies. Look again only where it didn't watch, or from the new start if the probe was
  // already at target before it.
  let reachedTargetAt: number | null = null;
  if (rec.reachedTargetAt !== null && rec.reachedTargetAt >= from && rec.reachedTargetAt <= to) {
    reachedTargetAt = rec.reachedTargetAt;
  } else {
    const after =
      rec.reachedTargetAt !== null && rec.reachedTargetAt < from ? from : rec.endedAt + 1;
    const hit = inWin.find((r) => r.ts >= after && (r[key] ?? -Infinity) >= item.targetC);
    reachedTargetAt = hit?.ts ?? null;
  }

  let cameOffC = rec.cameOffC;
  if (to !== rec.endedAt) {
    cameOffC = null;
    for (const r of inWin) if (r[key] !== null) cameOffC = r[key];
  }

  return {
    startedAt: from,
    endedAt: to,
    reachedTargetAt,
    cameOffC,
    stats: itemStats(inWin, { slot: item.slot, startedAt: from, reachedTargetAt }, cfg),
  };
}

// ---- The service over the store ----

export interface CookAgain {
  pitC: number | null;
  setups: Record<ProbeSlot, ProbeSetup | null>;
}

export class History {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  /** Newest first, each with its held pit target, foods and a small graph. */
  list(limit: number, before?: number): HistoryEntry[] {
    return this.store.sessions(limit, before).map((s) => {
      const win = this.window(s);
      const items = this.store.sessionItems(s.id).filter(inWindow);
      return {
        ...s,
        pitTargetC: heldPitTarget(this.store.targets(s.id), win),
        foods: items.map((i) => ({ slot: i.slot, food: i.food, weightLb: i.weightLb })),
        spark: s.endedAt === null ? [] : this.spark(win),
      };
    });
  }

  detail(id: number): CookDetail | null {
    const s = this.store.session(id);
    if (!s) return null;
    const win = this.window(s);
    const targets = this.store.targets(id);
    const rec = this.recorded(s);
    return {
      session: s,
      items: this.store.sessionItems(id).map((i) => ({ ...i, inWindow: inWindow(i) })),
      targets,
      fireUps: this.store.sessionFireUps(id),
      events: this.store.sessionEvents(id),
      recorded: rec,
      bounds: rec.endedAt === null ? win : this.bounds(s, rec as RecordedSession),
      pitTargetC: heldPitTarget(targets, win),
      pit: pitStats(this.store.readings(win.from, win.to), targets),
    };
  }

  /** Trim, retitle or annotate a past cook. The open cook belongs to the engine. */
  edit(id: number, patch: CookEdit): CookDetail {
    const s = this.store.session(id);
    if (!s) throw new CommandError(404, "No such cook");
    if (s.endedAt === null) throw new CommandError(409, "End the cook first");
    const endedAt = s.endedAt;
    const trimming = patch.startedAt !== undefined || patch.endedAt !== undefined;
    this.store.transaction(() => {
      if (patch.notes !== undefined) this.store.updateSession(id, { notes: patch.notes });
      if (trimming) {
        this.trim(s, { from: patch.startedAt ?? s.startedAt, to: patch.endedAt ?? endedAt });
      }
      const title = patch.title === undefined ? undefined : (patch.title?.trim() ?? "");
      if (title) this.store.updateSession(id, { title, titleCustom: true });
      else if (title === "") this.store.updateSession(id, { titleCustom: false });
      if (title === "" || trimming) this.retitle(id);
    });
    return this.detail(id) as CookDetail;
  }

  /** Cook this again: the held pit target, and the longest-held food on each probe. */
  cookAgain(id: number): CookAgain {
    const s = this.store.session(id);
    if (!s) throw new CommandError(404, "No such cook");
    const best = new Map<ProbeSlot, Item>();
    const span = (i: Item) => (i.endedAt ?? this.clock.now()) - i.startedAt;
    for (const i of this.store.sessionItems(id).filter(inWindow)) {
      const cur = best.get(i.slot);
      if (!cur || span(i) > span(cur)) best.set(i.slot, i);
    }
    const setup = (slot: ProbeSlot): ProbeSetup | null => {
      const i = best.get(slot);
      return i ? { food: i.food, weightLb: i.weightLb, targetC: i.targetC } : null;
    };
    return {
      pitC: heldPitTarget(this.store.targets(id), this.window(s)),
      setups: { 1: setup(1), 2: setup(2), 3: setup(3) },
    };
  }

  /**
   * How far Adjust start & end reaches: up to 3 h either side of the recorded cook, not into the
   * cooks before and after it, and only over readings that exist (the grill is often off).
   */
  private bounds(s: Session, rec: RecordedSession): Span {
    const { prev, next } = this.store.neighbours(s.id);
    const m = HISTORY.boundsMarginMs;
    const lo = Math.max(prev?.endedAt ?? 0, rec.startedAt - m);
    const hi = Math.min(
      next?.startedAt ?? Number.MAX_SAFE_INTEGER,
      rec.endedAt + m,
      this.clock.now(),
    );
    const before = this.store.readingSpan(lo, rec.startedAt).first ?? rec.startedAt;
    const after = this.store.readingSpan(rec.endedAt, hi).last ?? rec.endedAt;
    return {
      from: Math.min(before, s.startedAt),
      to: Math.max(after, s.endedAt ?? rec.endedAt),
    };
  }

  private trim(s: Session, win: Span): void {
    const rec = this.recorded(s) as RecordedSession;
    const b = this.bounds(s, rec);
    if (!(win.to - win.from >= HISTORY.minWindowMs)) {
      throw new CommandError(400, `A cook must be at least ${HISTORY.minWindowMs / 60_000} min`);
    }
    if (win.from < b.from || win.to > b.to) {
      throw new CommandError(400, "Start and end must be inside the recorded readings");
    }
    this.store.setSessionRecorded(s.id, rec);
    const recSpan = { from: rec.startedAt, to: rec.endedAt };
    const readings = this.store.readings(
      Math.min(win.from, rec.startedAt),
      Math.max(win.to, rec.endedAt),
    );
    for (const { item, recorded } of this.store.sessionItemsRecorded(s.id)) {
      if (item.endedAt === null || item.endReason === null) continue;
      const r: RecordedItem = recorded ?? {
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        endReason: item.endReason,
        cameOffC: item.cameOffC,
        reachedTargetAt: item.reachedTargetAt,
      };
      if (!recorded) this.store.setItemRecorded(item.id, r);
      this.store.updateItem(item.id, trimItem(item, r, recSpan, win, readings));
    }
    this.store.updateSession(s.id, { startedAt: win.from, endedAt: win.to });
  }

  private retitle(id: number): void {
    const s = this.store.session(id) as Session;
    if (s.titleCustom) return;
    const items = this.store.sessionItems(id).filter(inWindow);
    const title = sessionTitle(items, heldPitTarget(this.store.targets(id), this.window(s)));
    if (title !== s.title) this.store.updateSession(id, { title });
  }

  private recorded(s: Session): CookDetail["recorded"] {
    return this.store.sessionRecorded(s.id) ?? { startedAt: s.startedAt, endedAt: s.endedAt };
  }

  private window(s: Session): Span {
    return { from: s.startedAt, to: s.endedAt ?? this.clock.now() };
  }

  private spark(win: Span) {
    const bucketMs = Math.max(60_000, Math.ceil((win.to - win.from) / HISTORY.sparkPoints));
    return this.store.readingsBucketed(win.from, win.to, bucketMs);
  }
}
