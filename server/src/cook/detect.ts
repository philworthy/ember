// Pure detection rules for the cook engine (docs/brief.md › Behaviour): an item reaching its
// target or coming off, the pit falling, the stall, item stats and the v1 estimate. No IO; the
// thresholds come from config.ts.

import type { Estimate, ItemStats, PitStatus, Reading } from "@ember/shared";
import { COOK } from "../config.ts";

export interface Sample {
  ts: number;
  c: number | null;
}

type Cfg = typeof COOK;

// ---- Items, live ----

/** Per-item state for spotting "reached target" and "came off" one reading at a time. */
export interface ItemTrack {
  targetC: number;
  reached: boolean;
  /** Highest reading since the item started (armed once it passes COOK.cameOff.armAboveC). */
  maxC: number | null;
  /** Valid readings inside the came-off window, oldest first. */
  recent: { ts: number; c: number }[];
  /** First of the current run of null readings. */
  nullSince: number | null;
  lastValid: { ts: number; c: number } | null;
}

export function newTrack(targetC: number, reached = false, maxC: number | null = null): ItemTrack {
  return { targetC, reached, maxC, recent: [], nullSince: null, lastValid: null };
}

export type TrackOutcome =
  | { kind: "reached"; ts: number; c: number }
  | { kind: "cameOff"; reason: "removed" | "unplugged"; ts: number; c: number | null };

/**
 * Feed one probe reading to an item's track (mutates it). An item comes off when the probe reads
 * null for 30 s (unplugged; it came off at the last valid reading), or when, after passing
 * 140 °F, it drops 15 °F within 2 min (removed from the meat; it came off at the peak).
 */
export function trackReading(
  t: ItemTrack,
  ts: number,
  c: number | null,
  cfg: Cfg = COOK,
): TrackOutcome[] {
  if (c === null) {
    t.nullSince ??= ts;
    if (ts - t.nullSince >= cfg.unpluggedAfterMs) {
      const at = t.lastValid ?? { ts: t.nullSince, c: null };
      return [{ kind: "cameOff", reason: "unplugged", ts: at.ts, c: at.c }];
    }
    return [];
  }
  t.nullSince = null;
  t.lastValid = { ts, c };
  t.maxC = t.maxC === null ? c : Math.max(t.maxC, c);
  t.recent.push({ ts, c });
  while (t.recent.length && (t.recent[0] as { ts: number }).ts < ts - cfg.cameOff.windowMs) {
    t.recent.shift();
  }

  const out: TrackOutcome[] = [];
  if (!t.reached && c >= t.targetC) {
    t.reached = true;
    out.push({ kind: "reached", ts, c });
  }
  if (t.maxC >= cfg.cameOff.armAboveC) {
    let peak = t.recent[0] as { ts: number; c: number };
    for (const s of t.recent) if (s.c > peak.c) peak = s;
    if (peak.c - c >= cfg.cameOff.dropC) {
      out.push({ kind: "cameOff", reason: "removed", ts: peak.ts, c: peak.c });
    }
  }
  return out;
}

// ---- Pit ----

/**
 * The pit has been falling for 15 minutes: over the last 15 min of readings it dropped at least
 * 10 °F and never rose meaningfully above where the window started.
 */
export function pitFalling(pit: Sample[], cfg: Cfg = COOK): boolean {
  const valid = pit.filter((s): s is { ts: number; c: number } => s.c !== null);
  const last = valid.at(-1);
  if (!last) return false;
  const { pitFallingMs, pitFallingMinDropC, pitRiseToleranceC } = cfg.looksDone;
  const window = valid.filter((s) => s.ts >= last.ts - pitFallingMs);
  const first = window[0] as { ts: number; c: number };
  // A poll's worth of slack, so a 15-min window of 5 s readings counts.
  if (last.ts - first.ts < pitFallingMs - 10_000) return false;
  if (first.c - last.c < pitFallingMinDropC) return false;
  return window.every((s) => s.c - first.c <= pitRiseToleranceC);
}

export function pitStatus(
  pitC: number | null,
  targetC: number | null,
  active: boolean,
  cfg: Cfg = COOK,
): PitStatus {
  if (!active || pitC === null || targetC === null) return active ? "heating" : "idle";
  if (pitC < targetC - cfg.holdingBandC) return "heating";
  if (pitC > targetC + cfg.holdingBandC) return "cooling";
  return "holding";
}

// ---- Estimates ----

/** Least-squares slope in °C per hour. */
function slopePerHour(pts: { ts: number; c: number }[]): number {
  const n = pts.length;
  const t0 = (pts[0] as { ts: number }).ts;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const x = (p.ts - t0) / 3_600_000;
    sx += x;
    sy += p.c;
    sxx += x * x;
    sxy += x * p.c;
  }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

/**
 * v1 estimate: project the rate of rise over the last 25 min to the target. Flat or falling
 * (the stall) shows "Stalled"; too little data, or already there, shows nothing.
 */
export function estimate(probe: Sample[], targetC: number, now: number, cfg: Cfg = COOK): Estimate {
  const { windowMs, minSpanMs, flatBelowCPerH } = cfg.estimate;
  const pts = probe.filter(
    (s): s is { ts: number; c: number } => s.c !== null && s.ts >= now - windowMs,
  );
  const first = pts[0];
  const last = pts.at(-1);
  if (!first || !last || last.ts - first.ts < minSpanMs) return null;
  if (last.c >= targetC) return null;
  const rate = slopePerHour(pts);
  if (rate < flatBelowCPerH) return { kind: "stalled" };
  return { kind: "eta", atMs: Math.round(last.ts + ((targetC - last.c) / rate) * 3_600_000) };
}

// ---- Stats, at item end ----

export interface Stall {
  startAt: number;
  endAt: number;
  startC: number;
  endC: number;
}

/**
 * The stall: the longest stretch above 140 °F where the probe rose slower than 5 °F/h (measured
 * across a centred 30-min window, from 5-min averages at each end) for at least 45 min.
 */
export function findStall(probe: Sample[], cfg: Cfg = COOK): Stall | null {
  const pts = probe.filter((s): s is { ts: number; c: number } => s.c !== null);
  const first = pts[0];
  if (!first) return null;
  const MIN = 60_000;
  const m0 = Math.floor(first.ts / MIN);
  const sums: number[] = [];
  const counts: number[] = [];
  for (const p of pts) {
    const m = Math.floor(p.ts / MIN) - m0;
    sums[m] = (sums[m] ?? 0) + p.c;
    counts[m] = (counts[m] ?? 0) + 1;
  }
  const minutes = sums.length;
  const at = (m: number) => (counts[m] ? (sums[m] as number) / (counts[m] as number) : undefined);
  const mean = (from: number, to: number) => {
    let s = 0;
    let n = 0;
    for (let m = from; m <= to; m++) {
      const v = at(m);
      if (v !== undefined) {
        s += v;
        n++;
      }
    }
    return n ? s / n : undefined;
  };

  const half = Math.round(cfg.stall.slopeWindowMs / 2 / MIN);
  const edge = 5;
  const spanH = (2 * half - edge) / 60;
  let best: { from: number; to: number } | null = null;
  let runStart: number | null = null;
  const close = (end: number) => {
    if (runStart !== null && (!best || end - runStart > best.to - best.from)) {
      best = { from: runStart, to: end };
    }
    runStart = null;
  };
  for (let m = 0; m < minutes; m++) {
    const v = at(m);
    const before = mean(m - half, m - half + edge);
    const after = mean(m + half - edge, m + half);
    const stalled =
      v !== undefined &&
      before !== undefined &&
      after !== undefined &&
      v >= cfg.stall.minTempC &&
      (after - before) / spanH < cfg.stall.maxRateCPerH;
    if (stalled) runStart ??= m;
    else close(m - 1);
  }
  close(minutes - 1);

  const run = best as { from: number; to: number } | null;
  if (!run || (run.to - run.from) * MIN < cfg.stall.minDurationMs) return null;
  return {
    startAt: (m0 + run.from) * MIN,
    endAt: (m0 + run.to) * MIN,
    startC: at(run.from) as number,
    endC: at(run.to) as number,
  };
}

const SLOT_KEY = { 1: "t1C", 2: "t2C", 3: "t3C" } as const;

/** Stats saved when an item ends, from the readings over its time on the probe. */
export function itemStats(
  readings: Reading[],
  item: { slot: 1 | 2 | 3; startedAt: number; reachedTargetAt: number | null },
  cfg: Cfg = COOK,
): ItemStats {
  const key = SLOT_KEY[item.slot];
  const pits = readings.map((r) => r.pitC).filter((c): c is number => c !== null);
  const stall = findStall(
    readings.map((r) => ({ ts: r.ts, c: r[key] })),
    cfg,
  );
  return {
    timeToTargetMs: item.reachedTargetAt === null ? null : item.reachedTargetAt - item.startedAt,
    stallStartAt: stall?.startAt ?? null,
    stallEndAt: stall?.endAt ?? null,
    stallStartC: stall?.startC ?? null,
    stallEndC: stall?.endC ?? null,
    avgPitC: pits.length ? pits.reduce((a, b) => a + b, 0) / pits.length : null,
  };
}
