// The graph itself, shared by Live cook's Temperature card and Past cook: gridlines, dashed
// targets, the lines with end dots, and the time ticks below. Past cook adds layers under the
// lines (the stall) and over them (the dimmed ends and the trim handles).

import { type ReactNode, type RefObject, useLayoutEffect, useState } from "react";
import type { ChartOut, SeriesId } from "./chart.ts";

/** The element's width, kept current as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>, initial = 358): number {
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function ChartPlot({
  chart,
  width,
  height,
  color,
  label,
  targetColor,
  dots = true,
  under,
  over,
}: {
  chart: ChartOut;
  width: number;
  height: number;
  color: Record<SeriesId, string>;
  label: string;
  /** One colour for every target line (Past cook); otherwise each series' own. */
  targetColor?: string;
  dots?: boolean;
  under?: ReactNode;
  over?: ReactNode;
}) {
  // Draw probes under the pit, P3 lowest, as the design does.
  const order = [...chart.series].reverse();
  return (
    <>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        style={{ display: "block", overflow: "visible" }}
      >
        {chart.grid.map((g) => (
          <g key={g.label}>
            <line x1={0} x2={width} y1={g.y} y2={g.y} stroke="var(--grid)" strokeWidth={1} />
            <text
              x={16}
              y={g.y - 4}
              fill="var(--text-3)"
              style={{ fontFamily: "var(--mono)", fontSize: 10 }}
            >
              {g.label}
            </text>
          </g>
        ))}
        {under}
        {order.map(
          (s) =>
            s.ty !== null && (
              <line
                key={`t-${s.id}`}
                x1={0}
                x2={width}
                y1={s.ty}
                y2={s.ty}
                stroke={targetColor ?? color[s.id]}
                strokeWidth={1}
                strokeDasharray="3 4"
                opacity={targetColor ? 0.6 : 0.7}
              />
            ),
        )}
        {order.map((s) => (
          <path
            key={`l-${s.id}`}
            d={s.d}
            fill="none"
            stroke={color[s.id]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {dots &&
          order.map(
            (s) =>
              s.end && (
                <circle
                  key={`e-${s.id}`}
                  cx={s.end.x}
                  cy={s.end.y}
                  r={4}
                  fill={color[s.id]}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ),
          )}
        {over}
      </svg>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: height + 6,
          height: 16,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-3)",
        }}
      >
        {chart.xTicks.map((t) => (
          <span
            key={`${t.label}-${t.x}`}
            style={{
              position: "absolute",
              top: 0,
              left: t.x,
              whiteSpace: "nowrap",
              transform:
                t.align === "start"
                  ? "none"
                  : t.align === "end"
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </>
  );
}
