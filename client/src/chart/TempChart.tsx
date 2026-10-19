// The Temperature card on Live cook: pit and probes over time with dashed targets, a range
// switch (1h / 3h / 6h / All) and chips that toggle each series (design/canvas/Main.dc.html).

import type { Reading } from "@ember/shared";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { f } from "../format.ts";
import { buildChart, type ChartInput, type SeriesId } from "./chart.ts";

export interface SeriesDef {
  id: SeriesId;
  name: string;
  color: string;
  curC: number | null;
  targetC: number | null;
}

const RANGES: { id: ChartInput["range"]; label: string; ms: number }[] = [
  { id: "1h", label: "1h", ms: 3_600_000 },
  { id: "3h", label: "3h", ms: 3 * 3_600_000 },
  { id: "6h", label: "6h", ms: 6 * 3_600_000 },
  { id: "all", label: "All", ms: 0 },
];

const HEIGHT = 200;

export function TempChart({
  readings,
  version,
  start,
  now,
  series,
}: {
  readings: Reading[];
  /** Changes whenever `readings` grows. */
  version: number;
  start: number;
  now: number;
  series: SeriesDef[];
}) {
  const [range, setRange] = useState<ChartInput["range"]>("all");
  const [hidden, setHidden] = useState<Set<SeriesId>>(new Set());
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(358);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const span = RANGES.find((r) => r.id === range)?.ms ?? 0;
  // Snap "now" to the newest reading so the line ends at the right edge.
  const to = Math.max(readings.at(-1)?.ts ?? now, start + 60_000);
  const from = range === "all" ? start : to - span;
  const visible = series.filter((s) => !hidden.has(s.id));
  const key = visible.map((s) => `${s.id}:${s.targetC}`).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `key` stand in for readings and series
  const chart = useMemo(
    () =>
      buildChart({
        readings,
        from,
        to,
        width,
        height: HEIGHT,
        range,
        series: visible.map((s) => ({ id: s.id, targetC: s.targetC })),
      }),
    [version, key, from, to, width, range],
  );
  const color = Object.fromEntries(series.map((s) => [s.id, s.color])) as Record<SeriesId, string>;
  // Draw probes under the pit, P3 lowest, as the design does.
  const order = [...chart.series].reverse();

  return (
    <section
      className="card"
      style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 16px",
        }}
      >
        <h2 className="h2">Temperature</h2>
        <fieldset
          aria-label="Time range"
          style={{
            display: "flex",
            background: "var(--surface-sunk)",
            borderRadius: 10,
            padding: 3,
            gap: 2,
            border: 0,
            margin: 0,
          }}
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              style={{
                border: 0,
                minWidth: 44,
                height: 32,
                padding: "0 10px",
                borderRadius: 8,
                fontSize: 13,
                background: range === r.id ? "var(--line)" : "transparent",
                color: range === r.id ? "var(--text)" : "var(--text-2)",
              }}
            >
              {r.label}
            </button>
          ))}
        </fieldset>
      </div>

      <div ref={wrap} style={{ position: "relative", height: 222 }}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label="Pit and probe temperatures over time, with dashed target lines"
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
          {order.map(
            (s) =>
              s.ty !== null && (
                <line
                  key={`t-${s.id}`}
                  x1={0}
                  x2={width}
                  y1={s.ty}
                  y2={s.ty}
                  stroke={color[s.id]}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                  opacity={0.7}
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
          {order.map(
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
        </svg>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 206,
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
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 16px" }}>
        {series.map((s) => {
          const off = hidden.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={!off}
              onClick={() => {
                const next = new Set(hidden);
                if (off) next.delete(s.id);
                else next.add(s.id);
                setHidden(next);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 36,
                padding: "0 12px",
                borderRadius: 999,
                fontSize: 13,
                maxWidth: "100%",
                border: `1px solid ${off ? "var(--line)" : "var(--line-2)"}`,
                background: off ? "transparent" : "var(--surface-2)",
                color: off ? "var(--text-3)" : "var(--text)",
              }}
            >
              <span className="dot" style={{ background: off ? "var(--muted-dot)" : s.color }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.name}
              </span>
              <span className="muted">{s.curC === null ? "—" : `${f(s.curC)}°`}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
