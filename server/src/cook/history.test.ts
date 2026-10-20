import { fToDeviceC, type Reading, type TargetChange } from "@ember/shared";
import { describe, expect, it } from "vitest";
import type { RecordedItem } from "../db/store.ts";
import { itemStats } from "./detect.ts";
import { heldPitTarget, pitStats, sessionTitle, trimItem } from "./history.ts";

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;

function reading(ts: number, pitC: number | null, t1C: number | null, cookActive = true): Reading {
  return { ts, pitC, t1C, t2C: null, t3C: null, fanPct: 0, cookActive, targetPitC: 107, raw: {} };
}

function pit(ts: number, targetC: number, id = ts): TargetChange {
  return { id, sessionId: 1, itemId: null, ts, subject: "pit", targetC, source: "user" };
}

/** A brisket-ish probe: up 15 °C/h to 70, a 2 h stall, then up 10 °C/h. Every 30 s for 11 h. */
function probeAt(ts: number): number {
  const h = ts / HOUR;
  if (h < 10 / 3) return 20 + 15 * h;
  if (h < 10 / 3 + 2) return 70;
  return 70 + 10 * (h - 10 / 3 - 2);
}
const READINGS = Array.from({ length: (11 * HOUR) / (30 * S) + 1 }, (_, i) =>
  reading(i * 30 * S, 107, Math.round(probeAt(i * 30 * S) * 10) / 10),
);
const TARGET = 95;
const REACHED = READINGS.find((r) => (r.t1C as number) >= TARGET)?.ts as number;
const SESSION = { from: 0, to: 10 * HOUR };
const ITEM = { slot: 1 as const, targetC: TARGET };
const REC: RecordedItem = {
  startedAt: 0,
  endedAt: 9 * HOUR,
  endReason: "removed",
  cameOffC: 96,
  reachedTargetAt: REACHED,
};
const trim = (win: { from: number; to: number }, rec = REC) =>
  trimItem(ITEM, rec, SESSION, win, READINGS);

describe("trimming an item", () => {
  it("keeps what the engine recorded when the window is the recorded one", () => {
    const t = trim(SESSION);
    expect(t).toMatchObject({ startedAt: 0, endedAt: 9 * HOUR, cameOffC: 96 });
    expect(t.reachedTargetAt).toBe(REACHED);
    const inItem = READINGS.filter((r) => r.ts <= 9 * HOUR);
    expect(t.stats).toEqual(itemStats(inItem, { slot: 1, startedAt: 0, reachedTargetAt: REACHED }));
    expect(t.stats.stallStartAt).not.toBeNull();
  });

  it("moves an item that started with the cook, and recalculates its stats", () => {
    const t = trim({ from: 4 * HOUR, to: SESSION.to });
    expect(t.startedAt).toBe(4 * HOUR);
    expect(t.stats.timeToTargetMs).toBe(REACHED - 4 * HOUR);
    expect(t.stats.stallStartAt).toBeGreaterThanOrEqual(4 * HOUR);
    expect(t.stats.stallEndAt).toBe(trim(SESSION).stats.stallEndAt);
  });

  it("clips its end, and it came off at the last reading", () => {
    const t = trim({ from: 0, to: 7 * HOUR });
    expect(t.endedAt).toBe(7 * HOUR);
    expect(t.reachedTargetAt).toBeNull();
    expect(t.stats.timeToTargetMs).toBeNull();
    expect(t.cameOffC).toBeCloseTo(probeAt(7 * HOUR), 1);
  });

  it("finds the target from the new start when it was reached before it", () => {
    const t = trim({ from: REACHED + 10 * MIN, to: SESSION.to });
    expect(t.reachedTargetAt).toBe(REACHED + 10 * MIN);
    expect(t.stats.timeToTargetMs).toBe(0);
  });

  it("widening back gives the original exactly", () => {
    trim({ from: 4 * HOUR, to: 7 * HOUR });
    expect(trim(SESSION)).toEqual(trim(SESSION));
    expect(trim(SESSION).stats).toEqual(
      itemStats(
        READINGS.filter((r) => r.ts <= 9 * HOUR),
        { slot: 1, startedAt: 0, reachedTargetAt: REACHED },
      ),
    );
  });

  it("leaves an item outside the window with no time and no stats", () => {
    const rec = { ...REC, startedAt: 5 * HOUR, endedAt: 6 * HOUR };
    const t = trim({ from: 6.5 * HOUR, to: SESSION.to }, rec);
    expect(t.endedAt).toBe(t.startedAt);
    expect(t.stats.timeToTargetMs).toBeNull();
    expect(t.stats.stallStartAt).toBeNull();
  });

  it("ends an item that ended with the cook with the new end", () => {
    const rec: RecordedItem = { ...REC, endReason: "session_end", endedAt: SESSION.to };
    const t = trim({ from: 0, to: 11 * HOUR }, rec);
    expect(t.endedAt).toBe(11 * HOUR);
    expect(t.cameOffC).toBeCloseTo(probeAt(11 * HOUR), 1);
  });

  it("keeps a mid-cook item's own start when the cook starts earlier", () => {
    const rec = { ...REC, startedAt: 2 * HOUR };
    expect(trim({ from: 0, to: SESSION.to }, rec).startedAt).toBe(2 * HOUR);
    expect(trim({ from: 3 * HOUR, to: SESSION.to }, rec).startedAt).toBe(3 * HOUR);
  });
});

describe("pit", () => {
  const P225 = fToDeviceC(225);
  const P500 = fToDeviceC(500);

  it("holds the target held longest, not a reverse sear's last few minutes", () => {
    const targets = [pit(0, P225), pit(6 * HOUR, P500)];
    expect(heldPitTarget(targets, { from: 0, to: 6 * HOUR + 15 * MIN })).toBe(P225);
    expect(heldPitTarget(targets, { from: 5.9 * HOUR, to: 7 * HOUR })).toBe(P500);
    expect(heldPitTarget([], { from: 0, to: HOUR })).toBeNull();
  });

  it("averages and measures the hold once the pit got there, and not after Stop", () => {
    const rs: Reading[] = [];
    // Heat-up from 20 °C over 30 min, then ±2 around the target for 2 h, then fan off and cooling.
    for (let t = 0; t <= 3 * HOUR; t += 30 * S) {
      let c: number;
      if (t < 30 * MIN) c = 20 + ((P225 - 20) * t) / (30 * MIN);
      else if (t < 150 * MIN) c = P225 + (Math.round(t / (30 * S)) % 2 ? 2 : -2);
      else c = P225 - ((t - 150 * MIN) / MIN) * 2;
      rs.push(reading(t, c, null, t < 150 * MIN));
    }
    const s = pitStats(rs, [pit(0, P225)]);
    expect(s.avgC).toBeCloseTo(P225, 0);
    expect(s.heldWithinC).toBe(2);
    expect(pitStats(rs, []).heldWithinC).toBeNull();
  });
});

describe("session title", () => {
  it("names the foods, or the pit target", () => {
    expect(
      sessionTitle(
        [
          { slot: 1, food: { path: ["Beef", "Brisket", "Flat"] } },
          { slot: 2, food: { path: ["Beef", "Brisket", "Point"] } },
          { slot: 3, food: { custom: "Wings" } },
        ],
        null,
      ),
    ).toBe("Brisket & Wings");
    expect(sessionTitle([], fToDeviceC(700))).toBe("700° cook");
    expect(sessionTitle([], null)).toBe("Cook");
  });
});
