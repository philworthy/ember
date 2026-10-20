// Past cook (design/canvas/HistoryDetail.dc.html): the whole recording with the stall shaded and
// the time outside the cook dimmed, Adjust start & end, stats for the pit and each food, notes,
// and Cook this again. A trim only moves the cook's window; the server recalculates the stats.

import {
  type CookDetail,
  foodLabel,
  type HistoryItem,
  type ProbeSlot,
  type Reading,
  type Span,
} from "@ember/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { ChartPlot, useWidth } from "../chart/ChartPlot.tsx";
import { buildChart, type SeriesId } from "../chart/chart.ts";
import { clock, day, deg, degDelta, duration, f, pitDeg } from "../format.ts";
import type { Snapshot } from "../live.ts";
import { goHome, navigate } from "../router.ts";
import { SheetHeader, SLOT_COLOR } from "../ui/parts.tsx";
import { toast } from "../ui/toast.tsx";

const MIN = 60_000;
const HOUR = 60 * MIN;
const HEIGHT = 200;
/** The server answers at most 48 h of readings at once. */
const MAX_READINGS_MS = 48 * HOUR;
/** Adjust start & end moves in these steps, and keeps start and end this far apart. */
const STEP_MS = 5 * MIN;
const MIN_GAP_MS = 30 * MIN;

export function PastCook({ id, snap }: { id: number; snap: Snapshot }) {
  const [detail, setDetail] = useState<CookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);

  useEffect(() => {
    void api.cook(id).then((r) => {
      if (!r.ok) return setError(r.error);
      // The open cook lives on Live cook.
      if (r.data.session.endedAt === null) return navigate({ name: "home" }, { replace: true });
      setDetail(r.data);
    });
  }, [id]);

  const from = detail?.bounds.from;
  const to = detail?.bounds.to;
  useEffect(() => {
    if (from === undefined || to === undefined) return;
    void api.readings(Math.max(from, to - MAX_READINGS_MS), to).then((r) => {
      if (r.ok) setReadings(r.data);
    });
  }, [from, to]);

  if (!detail) {
    return (
      <main className="screen">
        <SheetHeader title="" back />
        <p className="muted" style={{ textAlign: "center", marginTop: 40 }}>
          {error ?? "Loading…"}
        </p>
      </main>
    );
  }
  return (
    <Loaded
      key={id}
      detail={detail}
      readings={readings}
      cooking={Boolean(snap.live?.session)}
      onChange={setDetail}
    />
  );
}

function Loaded({
  detail,
  readings,
  cooking,
  onChange,
}: {
  detail: CookDetail;
  readings: Reading[];
  cooking: boolean;
  onChange: (d: CookDetail) => void;
}) {
  const s = detail.session;
  const saved: Span = { from: s.startedAt, to: s.endedAt as number };
  const [trim, setTrim] = useState<Span | null>(null);
  const win = trim ?? saved;
  const items = detail.items.filter((i) => i.inWindow);

  const sub = [
    day(win.from),
    duration(win.to - win.from),
    detail.pitTargetC === null ? null : `Pit ${pitDeg(detail.pitTargetC)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  async function save() {
    if (!trim) return;
    if (trim.from === saved.from && trim.to === saved.to) {
      setTrim(null);
      return;
    }
    const r = await api.editCook(s.id, { startedAt: trim.from, endedAt: trim.to });
    if (!r.ok) {
      toast(r.error);
      return;
    }
    onChange(r.data);
    setTrim(null);
  }

  async function cookAgain() {
    const r = await api.cookAgain(s.id);
    if (!r.ok) return;
    toast(`Set up like ${s.title}. Check the probes, then Start cook.`);
    goHome();
  }

  return (
    <main className="screen">
      <SheetHeader title="" back />
      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 4px" }}>
        <Title detail={detail} onChange={onChange} />
        <span style={{ fontSize: 14 }} className="muted">
          {sub}
        </span>
      </div>

      <section
        className="card"
        style={{ padding: "16px 0 14px", display: "flex", flexDirection: "column", gap: 10 }}
      >
        <Graph detail={detail} readings={readings} win={win} trimming={trim !== null} />
        <Legend items={items} />
        {trim === null ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "6px 16px 0",
              borderTop: "1px solid var(--surface-2)",
              marginTop: 4,
            }}
          >
            <span className="muted" style={{ fontSize: 13 }}>
              {clock(saved.from)} – {clock(saved.to)}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setTrim(saved)}>
              Adjust start &amp; end
            </button>
          </div>
        ) : (
          <TrimControls
            bounds={detail.bounds}
            win={trim}
            minGap={Math.min(MIN_GAP_MS, saved.to - saved.from)}
            onChange={setTrim}
            onReset={() => setTrim(saved)}
            onSave={() => void save()}
          />
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <PitCard detail={detail} />
        {detail.items.map((i) => (
          <ItemCard key={i.id} item={i} />
        ))}
      </section>

      <Notes detail={detail} />

      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          className="btn btn-lg"
          disabled={cooking}
          style={cooking ? { opacity: 0.5 } : undefined}
          onClick={() => void cookAgain()}
        >
          Cook this again
        </button>
        {cooking && (
          <span className="label" style={{ textAlign: "center" }}>
            Finish the current cook first
          </span>
        )}
      </div>
    </main>
  );
}

/** The title; tap to rename, and clear it to go back to the one Ember makes from the foods. */
function Title({ detail, onChange }: { detail: CookDetail; onChange: (d: CookDetail) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(detail.session.title);
  const style = {
    margin: 0,
    fontSize: 28,
    fontWeight: 500,
    letterSpacing: "-0.02em",
    lineHeight: 1.2,
  } as const;

  async function save() {
    setEditing(false);
    const title = text.trim();
    if (title === detail.session.title) return;
    const r = await api.editCook(detail.session.id, { title: title || null });
    if (!r.ok) {
      toast(r.error);
      return;
    }
    onChange(r.data);
    setText(r.data.session.title);
  }

  if (editing) {
    return (
      <input
        aria-label="Cook name"
        // biome-ignore lint/a11y/noAutofocus: opened by tapping the title
        autoFocus
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(detail.session.title);
            setEditing(false);
          }
        }}
        style={{
          ...style,
          width: "100%",
          boxSizing: "border-box",
          background: "transparent",
          color: "var(--text)",
          border: 0,
          borderBottom: "1px solid var(--line-2)",
          padding: 0,
          fontFamily: "inherit",
        }}
      />
    );
  }
  return (
    <h1 style={style}>
      <button
        type="button"
        aria-label={`${detail.session.title}, rename`}
        onClick={() => {
          setText(detail.session.title);
          setEditing(true);
        }}
        style={{
          all: "unset",
          cursor: "text",
          display: "block",
          overflowWrap: "anywhere",
        }}
      >
        {detail.session.title}
      </button>
    </h1>
  );
}

/** Pit plus each probe that had food in the window (its last food, if a probe was reused). */
function seriesOf(
  items: HistoryItem[],
): { id: SeriesId; slot: ProbeSlot | null; item?: HistoryItem }[] {
  const bySlot = new Map<ProbeSlot, HistoryItem>();
  for (const i of items) bySlot.set(i.slot, i);
  return [
    { id: "pit", slot: null },
    ...[...bySlot.entries()]
      .sort(([a], [b]) => a - b)
      .map(([slot, item]) => ({ id: `p${slot}` as SeriesId, slot, item })),
  ];
}

const colorOf = (slot: ProbeSlot | null) => (slot === null ? "var(--pit)" : SLOT_COLOR[slot]);

function Graph({
  detail,
  readings,
  win,
  trimming,
}: {
  detail: CookDetail;
  readings: Reading[];
  win: Span;
  trimming: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const { bounds } = detail;
  const items = detail.items.filter((i) => i.inWindow);
  const series = seriesOf(items);
  const key = series.map((x) => `${x.id}:${x.item?.targetC}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands in for `series`
  const chart = useMemo(
    () =>
      buildChart({
        readings,
        from: bounds.from,
        to: bounds.to,
        width,
        height: HEIGHT,
        range: "span",
        series: series.map((x) => ({ id: x.id, targetC: x.item?.targetC ?? null })),
      }),
    [readings, bounds.from, bounds.to, width, key],
  );
  const color = Object.fromEntries(series.map((x) => [x.id, colorOf(x.slot)])) as Record<
    SeriesId,
    string
  >;
  const span = Math.max(1, bounds.to - bounds.from);
  const x = (ts: number) => ((ts - bounds.from) / span) * chart.plotW;
  const sx = x(win.from);
  const ex = x(win.to);

  const stalls = items.filter((i) => i.stats?.stallStartAt != null && i.stats.stallEndAt != null);
  const under = stalls.map((i) => {
    const a = x(i.stats?.stallStartAt as number);
    const b = x(i.stats?.stallEndAt as number);
    return (
      <rect
        key={`stall-${i.id}`}
        x={a}
        y={0}
        width={Math.max(0, b - a)}
        height={HEIGHT}
        fill={SLOT_COLOR[i.slot]}
        opacity={0.07}
      />
    );
  });
  const over: ReactNode = (
    <>
      <rect
        x={0}
        y={0}
        width={Math.max(0, sx)}
        height={HEIGHT}
        fill="var(--surface)"
        opacity={0.78}
      />
      <rect
        x={ex}
        y={0}
        width={Math.max(0, width - ex)}
        height={HEIGHT}
        fill="var(--surface)"
        opacity={0.78}
      />
      {trimming && (
        <>
          <line x1={sx} x2={sx} y1={0} y2={HEIGHT} stroke="var(--text)" strokeWidth={1.5} />
          <line x1={ex} x2={ex} y1={0} y2={HEIGHT} stroke="var(--text)" strokeWidth={1.5} />
        </>
      )}
    </>
  );

  return (
    <div ref={wrap} style={{ position: "relative", height: HEIGHT + 22 }}>
      <ChartPlot
        chart={chart}
        width={width}
        height={HEIGHT}
        color={color}
        dots={false}
        targetColor="var(--text-2)"
        label="Pit and probe temperatures across the whole recording"
        under={under}
        over={over}
      />
    </div>
  );
}

function Legend({ items }: { items: HistoryItem[] }) {
  const series = seriesOf(items);
  const stall = items.some((i) => i.stats?.stallStartAt != null);
  return (
    <div
      className="muted"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 14px",
        padding: "0 16px",
        fontSize: 12,
      }}
    >
      {series.map((x) => (
        <span key={x.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="dot" style={{ background: colorOf(x.slot) }} />
          {x.item ? foodLabel(x.item.food, x.item.slot).short : "Pit"}
        </span>
      ))}
      {stall && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 12,
              height: 8,
              borderRadius: 2,
              background: "var(--p1)",
              opacity: 0.25,
            }}
          />
          Stall
        </span>
      )}
    </div>
  );
}

function TrimControls({
  bounds,
  win,
  minGap,
  onChange,
  onReset,
  onSave,
}: {
  bounds: Span;
  win: Span;
  minGap: number;
  onChange: (w: Span) => void;
  onReset: () => void;
  onSave: () => void;
}) {
  // Snap to 5-minute steps, but never past the readings at either end.
  const snap = (v: number) =>
    Math.min(bounds.to, Math.max(bounds.from, Math.round(v / STEP_MS) * STEP_MS));
  const row = { display: "flex", justifyContent: "space-between", fontSize: 13 } as const;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "10px 16px 0",
        borderTop: "1px solid var(--surface-2)",
        marginTop: 4,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={row}>
          <label htmlFor="trim-start" className="muted">
            Start
          </label>
          <span>{clock(win.from)}</span>
        </div>
        <input
          id="trim-start"
          type="range"
          className="slider"
          min={bounds.from}
          max={bounds.to}
          step={1000}
          value={win.from}
          onChange={(e) =>
            onChange({ ...win, from: Math.min(snap(Number(e.target.value)), win.to - minGap) })
          }
          style={{ height: 28, accentColor: "var(--text)" }}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={row}>
          <label htmlFor="trim-end" className="muted">
            End
          </label>
          <span>{clock(win.to)}</span>
        </div>
        <input
          id="trim-end"
          type="range"
          className="slider"
          min={bounds.from}
          max={bounds.to}
          step={1000}
          value={win.to}
          onChange={(e) =>
            onChange({ ...win, to: Math.max(snap(Number(e.target.value)), win.from + minGap) })
          }
          style={{ height: 28, accentColor: "var(--text)" }}
        />
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>
        Readings are recorded the whole time the grill is on, so you can widen this as well as
        narrow it.
      </p>
      <div className="grid-2" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn"
          style={{ height: 44, borderRadius: 12 }}
          onClick={onReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="btn"
          style={{
            height: 44,
            borderRadius: 12,
            border: 0,
            background: "var(--text)",
            color: "var(--bg)",
            fontWeight: 600,
          }}
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function StatCard({
  color,
  name,
  meta,
  cells,
}: {
  color: string;
  name: string;
  meta: string;
  cells: { label: string; value: string }[];
}) {
  return (
    <div
      className="card"
      style={{
        borderRadius: 18,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, minWidth: 0 }}>
          <span className="dot" style={{ background: color }} />
          {name}
        </span>
        <span className="label" style={{ whiteSpace: "nowrap" }}>
          {meta}
        </span>
      </div>
      <div className="grid-2">
        {cells.map((c) => (
          <div key={c.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="label">{c.label}</span>
            <span style={{ fontSize: 18 }}>{c.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PitCard({ detail }: { detail: CookDetail }) {
  const s = detail.session;
  const fireUp = detail.fireUps.find(
    (x) => x.startedAt >= s.startedAt && x.startedAt <= (s.endedAt as number),
  );
  return (
    <StatCard
      color="var(--pit)"
      name="Pit"
      meta={fireUp ? `Fire it up ${fireUp.minutes} min` : ""}
      cells={[
        { label: "Average", value: deg(detail.pit.avgC) },
        { label: "Held within", value: degDelta(detail.pit.heldWithinC) },
      ]}
    />
  );
}

function ItemCard({ item }: { item: HistoryItem }) {
  const { name } = foodLabel(item.food, item.slot);
  const category = item.food && "path" in item.food ? item.food.path[0] : null;
  const meta = [category, item.weightLb === null ? null : `${item.weightLb} lb`]
    .filter(Boolean)
    .join(" · ");
  if (!item.inWindow) {
    return (
      <StatCard
        color={SLOT_COLOR[item.slot]}
        name={name}
        meta={meta}
        cells={[{ label: "Outside this cook", value: "—" }]}
      />
    );
  }
  const st = item.stats;
  const on = (item.endedAt as number) - item.startedAt;
  const first =
    st?.timeToTargetMs != null
      ? { label: `Reached ${deg(item.targetC)} in`, value: duration(st.timeToTargetMs) }
      : item.cameOffC !== null
        ? { label: `Came off at ${deg(item.cameOffC)} after`, value: duration(on) }
        : { label: "On for", value: duration(on) };
  const stall =
    st?.stallStartAt != null && st.stallEndAt != null
      ? {
          label: `Stall ${f(st.stallStartC)}–${deg(st.stallEndC)}`,
          value: duration(st.stallEndAt - st.stallStartAt),
        }
      : { label: "Stall", value: "None" };
  return <StatCard color={SLOT_COLOR[item.slot]} name={name} meta={meta} cells={[first, stall]} />;
}

/** Notes save a second after typing stops, and when the box loses focus. */
function Notes({ detail }: { detail: CookDetail }) {
  const id = detail.session.id;
  const [text, setText] = useState(detail.session.notes);
  const [status, setStatus] = useState<"" | "saving" | "saved">("");
  const savedText = useRef(detail.session.notes);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function save(value: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value === savedText.current) return;
    setStatus("saving");
    const r = await api.editCook(id, { notes: value });
    if (!r.ok) {
      setStatus("");
      toast(r.error);
      return;
    }
    savedText.current = value;
    setStatus("saved");
  }

  // Save what's typed when leaving the screen.
  const latest = useRef(text);
  latest.current = text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on leaving
  useEffect(
    () => () => {
      if (timer.current) void save(latest.current);
    },
    [],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px" }}>
        <label htmlFor="notes" className="label">
          Notes
        </label>
        <span className="faint" style={{ fontSize: 12 }}>
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </div>
      <textarea
        id="notes"
        rows={3}
        maxLength={4000}
        placeholder="Wood, wrap, rest, what you'd change next time"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setStatus("");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(v), 1000);
        }}
        onBlur={() => void save(text)}
        style={{
          boxSizing: "border-box",
          width: "100%",
          borderRadius: 14,
          border: "1px solid var(--line)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 15,
          lineHeight: 1.4,
          padding: "12px 14px",
          resize: "none",
          fontFamily: "inherit",
        }}
      />
    </div>
  );
}
