import { fDeltaToC, fToC } from "@ember/shared";
import { describe, expect, it } from "vitest";
import {
  estimate,
  findStall,
  itemStats,
  newTrack,
  pitFalling,
  pitStatus,
  type Sample,
  trackReading,
} from "./detect.ts";

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;

/** Feed a series of °F readings, 5 s apart, and collect the outcomes. */
function feed(temps: (number | null)[], targetF = 203) {
  const t = newTrack(fToC(targetF));
  return temps.flatMap((f, i) => trackReading(t, i * 5 * S, f === null ? null : fToC(f)));
}

describe("item track", () => {
  it("reaches the target once", () => {
    const out = feed([200, 202, 203, 204, 202, 204], 203);
    expect(out.filter((o) => o.kind === "reached").map((o) => o.ts)).toEqual([10 * S]);
  });

  it("comes off when it drops 15 °F within 2 min after passing 140 °F, at the peak", () => {
    const out = feed([150, 160, 165, 160, 155, 149]);
    expect(out).toEqual([{ kind: "cameOff", reason: "removed", ts: 10 * S, c: fToC(165) }]);
  });

  it("ignores a 15 °F drop below 140 °F and slow drops", () => {
    expect(feed([120, 135, 119])).toEqual([]);
    // 16 °F over 3 min: never 15 within any 2-min window
    const slow = Array.from({ length: 37 }, (_, i) => 160 - (16 * i) / 36);
    expect(feed(slow)).toEqual([]);
  });

  it("ignores ±1 °C probe noise", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 180 + (i % 2 ? 1.8 : -1.8));
    expect(feed(noisy)).toEqual([]);
  });

  it("comes off when unplugged for 30 s, at the last valid reading", () => {
    // Nulls from 10 s; 35 s is 25 s of nulls, 40 s is 30 s.
    expect(feed([150, 151, null, null, null, null, null, null])).toEqual([]);
    expect(feed([150, 151, null, null, null, null, null, null, null])).toEqual([
      { kind: "cameOff", reason: "unplugged", ts: 5 * S, c: fToC(151) },
    ]);
  });

  it("a probe that comes back resets the unplug clock", () => {
    expect(feed([150, null, null, null, null, 150, null, null, null, null, null])).toEqual([]);
  });
});

describe("pit", () => {
  const series = (fn: (min: number) => number, minutes: number): Sample[] =>
    Array.from({ length: minutes * 12 + 1 }, (_, i) => ({ ts: i * 5 * S, c: fn(i / 12) }));

  it("is falling after 15 min of a ≥ 10 °F drop", () => {
    expect(pitFalling(series((m) => 110 - m * 0.5, 15))).toBe(true);
    expect(pitFalling(series((m) => 110 - m * 0.5, 14))).toBe(false); // not long enough
    expect(pitFalling(series((m) => 110 - m * 0.2, 15))).toBe(false); // 3 °C: too little
    // Fell, then climbed back above where it started: not falling.
    expect(pitFalling(series((m) => (m < 10 ? 110 + m : 120 - (m - 10) * 4), 15))).toBe(false);
  });

  it("status follows the holding band", () => {
    expect(pitStatus(107, 107, true)).toBe("holding");
    expect(pitStatus(107 - fDeltaToC(11), 107, true)).toBe("heating");
    expect(pitStatus(107 + fDeltaToC(11), 107, true)).toBe("cooling");
    expect(pitStatus(107, null, false)).toBe("idle");
    expect(pitStatus(150, null, true)).toBe("heating"); // Fire it up
  });
});

describe("estimate", () => {
  const rising = (ratePerH: number, mins: number, from = 50): Sample[] =>
    Array.from({ length: mins * 12 + 1 }, (_, i) => ({
      ts: i * 5 * S,
      c: from + (ratePerH * i * 5 * S) / HOUR,
    }));

  it("projects the rate of rise to the target", () => {
    const pts = rising(10, 25); // 50 → 54.2 °C at 10 °C/h
    const e = estimate(pts, 95, 25 * MIN);
    expect(e?.kind).toBe("eta");
    if (e?.kind === "eta") expect(e.atMs).toBeCloseTo(25 * MIN + ((95 - 54.1667) / 10) * HOUR, -4);
  });

  it("says stalled when flat or falling, and nothing with too little data or at target", () => {
    expect(estimate(rising(1, 25), 95, 25 * MIN)).toEqual({ kind: "stalled" });
    expect(estimate(rising(-2, 25), 95, 25 * MIN)).toEqual({ kind: "stalled" });
    expect(estimate(rising(10, 10), 95, 10 * MIN)).toBeNull();
    expect(estimate(rising(10, 25, 96), 95, 25 * MIN)).toBeNull();
  });
});

describe("stall and stats", () => {
  // 40 → 68 °C over 4 h, flat-ish to 72 °C for 3 h, then up to 95 °C over 3 h.
  const curve = (h: number) =>
    h < 4 ? 40 + 7 * h : h < 7 ? 68 + (4 / 3) * (h - 4) : 72 + (23 / 3) * (h - 7);
  const pts: Sample[] = Array.from({ length: 10 * 720 }, (_, i) => ({
    ts: i * 5 * S,
    c: Math.round(curve((i * 5) / 3600) + ((i * 7919) % 3) - 1), // integer °C with ±1 noise
  }));

  it("finds the plateau", () => {
    const stall = findStall(pts);
    expect(stall).not.toBeNull();
    expect((stall?.startAt ?? 0) / HOUR).toBeCloseTo(4, 0);
    expect((stall?.endAt ?? 0) / HOUR).toBeCloseTo(7, 0);
    expect(stall?.startC).toBeCloseTo(68, -0.5);
    expect(stall?.endC).toBeCloseTo(72, -0.5);
  });

  it("finds none in a steady climb or below 140 °F", () => {
    expect(findStall(pts.map((p) => ({ ...p, c: 40 + (p.ts / HOUR) * 6 })))).toBeNull();
    expect(findStall(pts.map((p) => ({ ...p, c: 50 })))).toBeNull();
  });

  it("summarises an item", () => {
    const readings = pts.map((p) => ({
      ts: p.ts,
      pitC: 107,
      t1C: p.c,
      t2C: null,
      t3C: null,
      fanPct: 30,
      cookActive: true,
      targetPitC: 107,
      raw: {},
    }));
    const stats = itemStats(readings, { slot: 1, startedAt: 0, reachedTargetAt: 9 * HOUR });
    expect(stats.timeToTargetMs).toBe(9 * HOUR);
    expect(stats.avgPitC).toBe(107);
    expect(stats.stallStartAt).not.toBeNull();
    expect(itemStats(readings, { slot: 2, startedAt: 0, reachedTargetAt: null })).toMatchObject({
      timeToTargetMs: null,
      stallStartAt: null,
    });
  });
});
