import { describe, expect, it } from "vitest";
import { cDeltaToF, cToDisplayF, cToF, fDeltaToC, fToC, fToDeviceC } from "./units.ts";

describe("units", () => {
  it("converts °C to °F", () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(cToF(121)).toBeCloseTo(249.8);
  });

  it("converts °F to °C", () => {
    expect(fToC(32)).toBe(0);
    expect(fToC(212)).toBe(100);
  });

  it("rounds to integer °C for the wire", () => {
    expect(fToDeviceC(225)).toBe(107); // low & slow preset
    expect(fToDeviceC(250)).toBe(121);
    expect(fToDeviceC(500)).toBe(260);
    expect(fToDeviceC(700)).toBe(371); // pizza
  });

  it("rounds to whole °F for display", () => {
    expect(cToDisplayF(121)).toBe(250);
    expect(cToDisplayF(96)).toBe(205);
  });

  it("converts differences without the 32° offset", () => {
    expect(fDeltaToC(9)).toBe(5);
    expect(fDeltaToC(15)).toBeCloseTo(8.33, 2);
    expect(cDeltaToF(5)).toBe(9);
  });
});
