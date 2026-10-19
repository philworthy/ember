import { describe, expect, it } from "vitest";
import { decodeData, parseQs } from "./protocol.ts";
import { checkReading, snapshot } from "./sanity.ts";

const T = 1_792_368_620;
const reading = (time: number, pt: number, t1 = pt) =>
  decodeData(parseQs(`time=${time}&acs=0&pt=${pt}&t1=${t1}&t2=400&t3=400&dc=0&tpt=0`));

describe("checkReading", () => {
  it("drops readings while the clock is unset (seconds since boot)", () => {
    expect(checkReading(reading(29, 126), 0, null)).toEqual({ ok: false, reason: "clock-unset" });
  });

  it("drops a jump of more than 50 °C within 10 s", () => {
    const prev = snapshot(reading(T, 23), 0);
    expect(checkReading(reading(T + 5, 84), 5_000, prev)).toEqual({ ok: false, reason: "jump" });
    expect(checkReading(reading(T + 5, 73), 5_000, prev)).toEqual({ ok: true });
  });

  it("checks every probe, not just the pit", () => {
    const prev = snapshot(reading(T, 107, 60), 0);
    expect(checkReading(reading(T + 5, 107, 3), 5_000, prev).ok).toBe(false);
  });

  it("keeps the same change after a gap longer than 10 s", () => {
    const prev = snapshot(reading(T, 23), 0);
    expect(checkReading(reading(T + 30, 84), 30_000, prev)).toEqual({ ok: true });
  });

  it("ignores probes that come and go (null is not a jump)", () => {
    const prev = snapshot(reading(T, 23, 400), 0);
    expect(checkReading(reading(T + 5, 23, 90), 5_000, prev)).toEqual({ ok: true });
  });
});
