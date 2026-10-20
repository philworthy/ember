// A History card's small graph (design/canvas/History.dc.html): pit and the probes that had food,
// from the server's averaged points. No grid, labels or dots.

import type { ProbeSlot, Span, SparkPoint } from "@ember/shared";
import { useMemo, useRef } from "react";
import { SLOT_COLOR } from "../ui/parts.tsx";
import { useWidth } from "./ChartPlot.tsx";
import { buildChart, type SeriesId } from "./chart.ts";

const HEIGHT = 36;

export function Sparkline({
  points,
  slots,
  span,
}: {
  points: SparkPoint[];
  slots: ProbeSlot[];
  span: Span;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap, 326);
  const ids: SeriesId[] = ["pit", ...slots.map((s) => `p${s}` as SeriesId)];
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands in for `ids`
  const chart = useMemo(() => {
    const step =
      points.length > 1 ? (points[1] as SparkPoint).ts - (points[0] as SparkPoint).ts : 0;
    return buildChart({
      readings: points,
      from: span.from,
      to: span.to,
      width,
      height: HEIGHT,
      range: "span",
      gapMs: Math.max(30_000, 3 * step),
      series: ids.map((id) => ({ id, targetC: null })),
    });
  }, [points, span.from, span.to, width, key]);
  return (
    <div ref={wrap} style={{ height: HEIGHT }}>
      <svg width={width} height={HEIGHT} aria-hidden="true" style={{ display: "block" }}>
        {[...chart.series].reverse().map((s) => (
          <path
            key={s.id}
            d={s.d}
            fill="none"
            stroke={s.id === "pit" ? "var(--pit)" : SLOT_COLOR[Number(s.id[1]) as ProbeSlot]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            opacity={s.id === "pit" ? 1 : 0.85}
          />
        ))}
      </svg>
    </div>
  );
}
