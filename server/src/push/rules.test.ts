import { fDeltaToC, fToDeviceC } from "@ember/shared";
import { describe, expect, it } from "vitest";
import { OfflineWatch, PitDrift } from "./rules.ts";

const MIN = 60_000;
const T = fToDeviceC(250);
const prefs = { bandC: fDeltaToC(25), forMin: 10 };
const below = (f: number) => T - fDeltaToC(f);

/** Feed one pit reading per minute from `from` for `mins`; returns the alerts. */
function feed(d: PitDrift, from: number, mins: number, pitC: number, opts = {}) {
  const out = [];
  for (let m = 0; m < mins; m++) {
    const a = d.update({ now: from + m * MIN, pitC, holdC: T, quiet: false, ...opts }, prefs);
    if (a) out.push(a);
  }
  return out;
}

describe("PitDrift", () => {
  it("stays quiet while the pit climbs to a new target", () => {
    const d = new PitDrift();
    expect(feed(d, 0, 30, below(100))).toEqual([]);
  });

  it("fires once after 10 min more than 25° off, then re-arms back inside the band", () => {
    const d = new PitDrift();
    feed(d, 0, 5, T);
    expect(feed(d, 5 * MIN, 9, below(30))).toEqual([]);
    const fired = feed(d, 14 * MIN, 20, below(30));
    expect(fired).toEqual([{ pitC: below(30), targetC: T, sinceMs: 5 * MIN }]);
    // Back within 25° but outside the holding band: the timer resets, no new alert armed.
    feed(d, 34 * MIN, 2, below(20));
    expect(feed(d, 36 * MIN, 15, below(30))).toEqual([]);
    // Back to holding: the next excursion alerts again.
    feed(d, 51 * MIN, 2, T);
    expect(feed(d, 53 * MIN, 11, T + fDeltaToC(40))).toHaveLength(1);
  });

  it("disarms on a new target and while quiet or not holding", () => {
    const d = new PitDrift();
    feed(d, 0, 5, T);
    // The target goes up 50°: no alert while it heats.
    const higher = T + fDeltaToC(50);
    for (let m = 0; m < 20; m++) {
      expect(d.update({ now: (5 + m) * MIN, pitC: T, holdC: higher, quiet: false }, prefs)).toBe(
        null,
      );
    }
    const e = new PitDrift();
    feed(e, 0, 5, T);
    expect(feed(e, 5 * MIN, 20, below(40), { quiet: true })).toEqual([]);
    expect(feed(e, 25 * MIN, 20, below(40))).toEqual([]); // must reach target again first
    const f = new PitDrift();
    feed(f, 0, 5, T);
    expect(feed(f, 5 * MIN, 20, below(40), { holdC: null })).toEqual([]);
  });

  it("ignores missing readings without resetting the excursion", () => {
    const d = new PitDrift();
    feed(d, 0, 2, T);
    feed(d, 2 * MIN, 5, below(30));
    feed(d, 7 * MIN, 3, null as unknown as number);
    expect(feed(d, 10 * MIN, 3, below(30))).toHaveLength(1);
  });
});

describe("OfflineWatch", () => {
  const base = { sessionOpen: true, offline: true, online: false, lastSeenMs: 0 };

  it("fires once per outage, 2 min after the last reading", () => {
    const w = new OfflineWatch();
    expect(w.update({ ...base, now: 1.9 * MIN }, { forMin: 2 })).toBe(null);
    expect(w.update({ ...base, now: 2 * MIN }, { forMin: 2 })).toEqual({ lastSeenMs: 0 });
    expect(w.update({ ...base, now: 10 * MIN }, { forMin: 2 })).toBe(null);
    w.update({ ...base, now: 11 * MIN, offline: false, online: true }, { forMin: 2 });
    expect(w.update({ ...base, now: 20 * MIN, lastSeenMs: 15 * MIN }, { forMin: 2 })).toEqual({
      lastSeenMs: 15 * MIN,
    });
  });

  it("needs a session and the link to have given up", () => {
    const w = new OfflineWatch();
    expect(w.update({ ...base, now: 5 * MIN, sessionOpen: false }, { forMin: 2 })).toBe(null);
    expect(w.update({ ...base, now: 5 * MIN, offline: false }, { forMin: 2 })).toBe(null);
    expect(w.update({ ...base, now: 5 * MIN, lastSeenMs: null }, { forMin: 2 })).toBe(null);
  });
});
