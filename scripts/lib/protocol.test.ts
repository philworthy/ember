import { describe, expect, it } from "vitest";
import {
  decodeData,
  encodeForm,
  grillStartA,
  grillStartB,
  grillStop,
  parseQs,
  parseRawPairs,
  startCook,
  stopCook,
} from "./protocol.ts";

const NOW = 1_792_263_375;

describe("parseQs", () => {
  it("parses a data response into strings", () => {
    expect(parseQs("acs=1&tpt=121&pt=118&t1=64&csid=\n")).toEqual({
      acs: "1",
      tpt: "121",
      pt: "118",
      t1: "64",
      csid: "",
    });
  });

  it("keeps the first value of a repeated key", () => {
    expect(parseQs("a=1&a=2")).toEqual({ a: "1" });
  });
});

describe("decodeData", () => {
  const base = { time: String(NOW), acs: "1", tpt: "121", pt: "118", dc: "34" };

  it("maps both sentinels to null", () => {
    const d = decodeData({ ...base, t1: "400", t2: "-400", t3: "64" });
    expect([d.t1C, d.t2C, d.t3C]).toEqual([null, null, 64]);
  });

  it("maps a pit sentinel to null and treats a missing probe as null", () => {
    const d = decodeData({ ...base, pt: "-400" });
    expect(d.pitC).toBeNull();
    expect(d.t1C).toBeNull();
  });

  it("marks readings invalid while the device clock is unset", () => {
    expect(decodeData({ ...base, time: "12" }).valid).toBe(false);
    expect(decodeData({ ...base, time: "39" }).valid).toBe(false);
    expect(decodeData({ ...base, time: "40" }).valid).toBe(true);
    expect(decodeData({ ...base, time: undefined as unknown as string }).valid).toBe(false);
  });

  it("decodes the core fields", () => {
    const d = decodeData(base);
    expect(d).toMatchObject({ cookActive: true, targetPitC: 121, pitC: 118, fanPct: 34 });
  });

  it("collects unknown fields", () => {
    const d = decodeData({ ...base, rm: "2", zz: "9" });
    expect(d.rm).toBe("2");
    expect(d.other).toEqual({ zz: "9" });
  });
});

describe("command payloads match docs/protocol.md", () => {
  it("start cook", () => {
    expect(encodeForm(startCook(121, NOW))).toBe(
      `acs=1&csid=&tpt=121&sce=${NOW + 86400}&p=0&tft=0&as=0&ct=${NOW}`,
    );
  });

  it("start cook with a device food-probe target (CLI testing only)", () => {
    expect(startCook(107, NOW, { slot: 1, tftC: 30 })).toMatchObject({ p: 1, tft: 30 });
  });

  it("stop cook", () => {
    expect(encodeForm(stopCook(NOW))).toBe(`acs=0&csid=&tpt=0&sce=0&p=0&tft=0&as=0&ct=${NOW}`);
  });

  it("grill method A start and stop", () => {
    expect(grillStartA(10, NOW)).toEqual({ ag: 1, sge: NOW + 600, ct: NOW });
    expect(grillStop("a", NOW)).toEqual({ ag: 0, sge: 0, ct: NOW });
  });

  it("grill method B is a 260 °C cook with a short sce, stopped by stop cook", () => {
    expect(grillStartB(20, NOW)).toEqual({ ...startCook(260, NOW), sce: NOW + 1200 });
    expect(grillStop("b", NOW)).toEqual(stopCook(NOW));
  });

  it("never schedules sce more than 24 h ahead", () => {
    expect(Number(startCook(107, NOW).sce) - NOW).toBeLessThanOrEqual(86400);
  });
});

describe("parseRawPairs", () => {
  it("keeps order, allows empty values and adds ct", () => {
    expect(parseRawPairs(["acs=1", "csid=", "tpt=107"], NOW)).toEqual({
      acs: "1",
      csid: "",
      tpt: "107",
      ct: NOW,
    });
  });

  it("does not override an explicit ct", () => {
    expect(parseRawPairs(["ct=5"], NOW)).toEqual({ ct: "5" });
  });

  it("rejects malformed pairs", () => {
    expect(() => parseRawPairs(["acs"], NOW)).toThrow();
    expect(() => parseRawPairs(["=1"], NOW)).toThrow();
  });
});
