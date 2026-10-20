// The graphs' maths, kept pure so it can be tested: bucket readings into pixel columns, scale
// to °F, and lay out gridlines and time ticks the way design/canvas/Main.dc.html and
// HistoryDetail.dc.html do. Live cook, Past cook and History's small graphs all use it.

import { cToF, duration, type Reading } from "@ember/shared";

/** What a graph needs from a reading (History's small graphs send only these). */
export type ChartReading = Pick<Reading, "ts" | "pitC" | "t1C" | "t2C" | "t3C">;

export type SeriesId = "pit" | "p1" | "p2" | "p3";

export const SERIES_KEY: Record<SeriesId, "pitC" | "t1C" | "t2C" | "t3C"> = {
  pit: "pitC",
  p1: "t1C",
  p2: "t2C",
  p3: "t3C",
};

export interface SeriesInput {
  id: SeriesId;
  /** Target in °C (a dashed line), if any. */
  targetC: number | null;
}

export interface ChartInput {
  readings: ChartReading[];
  from: number;
  to: number;
  width: number;
  height: number;
  series: SeriesInput[];
  /**
   * "all" labels hours since `from`, ending at "now"; "span" does the same for a past cook,
   * ending at its length. Otherwise ticks count back from `to`.
   */
  range: "1h" | "3h" | "6h" | "all" | "span";
  /** Readings further apart than this break the line (default 30 s: the device was offline). */
  gapMs?: number;
}

export interface ChartSeries {
  id: SeriesId;
  d: string;
  /** Target line y, or null. */
  ty: number | null;
  /** Last point, for the end dot. */
  end: { x: number; y: number } | null;
}

export interface ChartOut {
  /** Width of the plot, left of the end-dot padding: x = (ts - from) / (to - from) * plotW. */
  plotW: number;
  grid: { y: number; label: string }[];
  series: ChartSeries[];
  xTicks: { x: number; label: string; align: "start" | "middle" | "end" }[];
}

const GAP_MS = 30_000;
/** Room on the right for the end dots. */
const PAD_RIGHT = 4;

/**
 * Average each series into pixel columns (one value per ~1.5 px), so a 10-hour cook is ~240
 * points, not 7,000. A column whose readings are all null (probe unplugged) is null and breaks
 * the line; a column with no readings at all (narrower than the 5 s poll) is undefined and the
 * line carries on across it. `breaks[i]` marks a gap in the data (the device offline) just
 * before column i.
 */
export function bucket(
  readings: ChartReading[],
  key: (typeof SERIES_KEY)[SeriesId],
  from: number,
  to: number,
  columns: number,
  gapMs = GAP_MS,
): { values: (number | null | undefined)[]; breaks: boolean[] } {
  const values: (number | null | undefined)[] = new Array(columns).fill(undefined);
  const seen: boolean[] = new Array(columns).fill(false);
  const breaks: boolean[] = new Array(columns).fill(false);
  const sums = new Array(columns).fill(0);
  const counts = new Array(columns).fill(0);
  const span = Math.max(1, to - from);
  let prev: { ts: number; col: number } | null = null;
  for (const r of readings) {
    if (r.ts < from || r.ts > to) continue;
    const col = Math.min(columns - 1, Math.floor(((r.ts - from) / span) * columns));
    if (prev && r.ts - prev.ts > gapMs && col > prev.col) breaks[col] = true;
    prev = { ts: r.ts, col };
    seen[col] = true;
    const v = r[key];
    if (v === null) continue;
    sums[col] += v;
    counts[col]++;
  }
  for (let i = 0; i < columns; i++) {
    if (counts[i] > 0) values[i] = sums[i] / counts[i];
    else if (seen[i]) values[i] = null;
  }
  return { values, breaks };
}

/** Gridline step and range in °F covering every value given. */
export function yScale(valuesF: number[]): { lo: number; hi: number; step: number } {
  if (!valuesF.length) return { lo: 0, hi: 300, step: 50 };
  const min = Math.min(...valuesF);
  const max = Math.max(...valuesF);
  let step = 50;
  let lo = Math.max(0, Math.floor((min - 10) / step) * step);
  let hi = Math.ceil((max + 10) / step) * step;
  if (hi - lo > 400) {
    step = 100;
    lo = Math.max(0, Math.floor((min - 10) / step) * step);
    hi = Math.ceil((max + 10) / step) * step;
  }
  if (hi - lo < 2 * step) hi = lo + 2 * step;
  return { lo, hi, step };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function agoLabel(ms: number): string {
  if (ms === 0) return "now";
  return ms >= HOUR ? `-${ms / HOUR}h` : `-${ms / MIN}m`;
}

function sinceLabel(ms: number): string {
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms < HOUR) return `${ms / MIN}m`;
  return `${Math.floor(ms / HOUR)}h${String((ms % HOUR) / MIN).padStart(2, "0")}`;
}

export function xTicks(
  range: ChartInput["range"],
  from: number,
  to: number,
  plotW: number,
): ChartOut["xTicks"] {
  const span = Math.max(1, to - from);
  const x = (t: number) => ((t - from) / span) * plotW;
  const ticks: ChartOut["xTicks"] = [];
  if (range === "all" || range === "span") {
    const end = range === "all" ? "now" : duration(span);
    const steps = [15, 30, 60, 120, 180, 240, 360, 720, 1440].map((m) => m * MIN);
    const every = steps.find((s) => span / s <= 4) ?? 1440 * MIN;
    for (let t = 0; from + t < to; t += every) {
      // Keep clear of the end label.
      if (t > 0 && x(from + t) > plotW - 12 - 6 * end.length) break;
      ticks.push({ x: x(from + t), label: sinceLabel(t), align: t === 0 ? "start" : "middle" });
    }
    ticks.push({ x: plotW, label: end, align: "end" });
    return ticks;
  }
  const every = range === "1h" ? 15 * MIN : range === "6h" ? 2 * HOUR : HOUR;
  for (let ago = 0; to - ago >= from - 1; ago += every) {
    const t = to - ago;
    ticks.push({
      x: x(t),
      label: agoLabel(ago),
      align: ago === 0 ? "end" : t - every < from - 1 ? "start" : "middle",
    });
  }
  return ticks.reverse();
}

export function buildChart(input: ChartInput): ChartOut {
  const { readings, from, to, width, height, series } = input;
  const plotW = Math.max(10, width - PAD_RIGHT);
  const columns = Math.max(10, Math.round(plotW / 1.5));
  const buckets = series.map((s) =>
    bucket(readings, SERIES_KEY[s.id], from, to, columns, input.gapMs),
  );

  const valuesF: number[] = [];
  for (const b of buckets) {
    for (const v of b.values) if (v !== null && v !== undefined) valuesF.push(cToF(v));
  }
  for (const s of series) if (s.targetC !== null) valuesF.push(cToF(s.targetC));
  const { lo, hi, step } = yScale(valuesF);
  const y = (f: number) => height - ((f - lo) / (hi - lo)) * height;
  const colX = (i: number) => ((i + 0.5) / columns) * plotW;

  const out: ChartSeries[] = series.map((s, si) => {
    const b = buckets[si] as ReturnType<typeof bucket>;
    let d = "";
    let pen = false;
    let end: ChartSeries["end"] = null;
    for (let i = 0; i < columns; i++) {
      const v = b.values[i];
      if (b.breaks[i]) pen = false;
      if (v === undefined) continue;
      if (v === null) {
        pen = false;
        continue;
      }
      const px = colX(i);
      const py = y(cToF(v));
      d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
      pen = true;
      end = { x: px, y: py };
    }
    // The newest point sits at the right edge, where the end dot is drawn.
    if (end && end.x > plotW - 3 * (plotW / columns)) end = { x: plotW, y: end.y };
    return { id: s.id, d, ty: s.targetC === null ? null : y(cToF(s.targetC)), end };
  });

  const grid: ChartOut["grid"] = [];
  for (let f = lo + step; f < hi; f += step) grid.push({ y: y(f), label: String(f) });

  return { plotW, grid, series: out, xTicks: xTicks(input.range, from, to, plotW) };
}
