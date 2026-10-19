import type { Reading } from "@ember/shared";
import { fToC } from "@ember/shared";
import { describe, expect, it } from "vitest";
import { bucket, buildChart, xTicks, yScale } from "./chart.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const reading = (ts: number, pitF: number, t1F: number | null = null): Reading => ({
  ts,
  pitC: fToC(pitF),
  t1C: t1F === null ? null : fToC(t1F),
  t2C: null,
  t3C: null,
  fanPct: 20,
  cookActive: true,
  targetPitC: 121,
  raw: {},
});

describe("bucket", () => {
  it("averages readings into columns; empty columns are undefined, unplugged ones null", () => {
    const rs = [reading(0, 200, 100), reading(5_000, 210, 100), reading(50_000, 220, null)];
    const pit = bucket(rs, "pitC", 0, 60_000, 6);
    expect(pit.values[0]).toBeCloseTo(fToC(205));
    expect(pit.values.slice(1, 5)).toEqual([undefined, undefined, undefined, undefined]);
    expect(pit.values[5]).toBeCloseTo(fToC(220));
    expect(pit.breaks[5]).toBe(true);
    expect(bucket(rs, "t1C", 0, 60_000, 6).values[5]).toBeNull();
  });

  it("keeps a line whole when columns are narrower than the poll interval", () => {
    const rs = [];
    for (let t = 0; t <= 10 * MIN; t += 5_000) rs.push(reading(t, 250));
    const out = buildChart({
      readings: rs,
      from: 0,
      to: 10 * MIN,
      width: 358,
      height: 200,
      range: "all",
      series: [{ id: "pit", targetC: null }],
    });
    expect(out.series[0]?.d.match(/M/g)).toHaveLength(1);
  });

  it("marks gaps longer than 30 s even when the columns are wide", () => {
    const rs = [];
    for (let t = 0; t < HOUR; t += 5_000)
      if (t < 20 * MIN || t > 30 * MIN) rs.push(reading(t, 250));
    const { values, breaks } = bucket(rs, "pitC", 0, HOUR, 10);
    expect(values.filter((v) => v === undefined)).toHaveLength(1);
    expect(breaks.filter(Boolean)).toHaveLength(1);
  });
});

describe("yScale", () => {
  it("snaps to 50° gridlines with some headroom", () => {
    expect(yScale([40, 250])).toEqual({ lo: 0, hi: 300, step: 50 });
    expect(yScale([180, 203])).toEqual({ lo: 150, hi: 250, step: 50 });
  });
  it("uses 100° steps for a pizza cook", () => {
    expect(yScale([60, 700])).toEqual({ lo: 0, hi: 800, step: 100 });
  });
  it("has a default when empty", () => {
    expect(yScale([])).toEqual({ lo: 0, hi: 300, step: 50 });
  });
});

describe("xTicks", () => {
  it("labels hours since the start for All, ending at now", () => {
    const labels = xTicks("all", 0, 6 * HOUR + 40 * MIN, 354).map((t) => t.label);
    expect(labels).toEqual(["0h", "2h", "4h", "6h", "now"]);
  });
  it("drops a tick that would collide with now", () => {
    const labels = xTicks("all", 0, 6 * HOUR + 5 * MIN, 354).map((t) => t.label);
    expect(labels).toEqual(["0h", "2h", "4h", "now"]);
  });
  it("counts back from now for a range", () => {
    const labels = xTicks("1h", 0, HOUR, 354).map((t) => t.label);
    expect(labels).toEqual(["-1h", "-45m", "-30m", "-15m", "now"]);
  });
});

describe("buildChart", () => {
  it("draws lines, targets and end dots", () => {
    const rs = [];
    for (let t = 0; t <= HOUR; t += 5_000) rs.push(reading(t, 250, t < 10 * MIN ? null : 150));
    const out = buildChart({
      readings: rs,
      from: 0,
      to: HOUR,
      width: 358,
      height: 200,
      range: "all",
      series: [
        { id: "pit", targetC: fToC(250) },
        { id: "p1", targetC: fToC(203) },
      ],
    });
    const [pit, p1] = out.series;
    expect(pit?.d.startsWith("M")).toBe(true);
    expect(pit?.d.match(/M/g)).toHaveLength(1);
    expect(pit?.end?.x).toBe(354);
    expect(p1?.d.match(/M/g)).toHaveLength(1);
    expect(p1?.ty).toBeGreaterThan(pit?.ty ?? 0);
    expect(out.grid.map((g) => g.label)).toEqual(["150", "200", "250"]);
  });
});
