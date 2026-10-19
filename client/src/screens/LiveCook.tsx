// Live cook (design/canvas/Main.dc.html), including its ending states: a probe that came off
// (MainItemOff) and "Looks like you're done" (MainDone). Shown while a session is open.

import {
  foodLabel,
  type Item,
  type LiveProbe,
  type LiveState,
  type ProbeSlot,
  type Reading,
} from "@ember/shared";
import { type ReactNode, useMemo, useState } from "react";
import { api } from "../api.ts";
import type { SeriesDef } from "../chart/TempChart.tsx";
import { TempChart } from "../chart/TempChart.tsx";
import { deg, duration, f } from "../format.ts";
import { type Snapshot, useHistory } from "../live.ts";
import { navigate } from "../router.ts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  CheckIcon,
  CloseIcon,
  FlameIcon,
  InfoIcon,
  PencilIcon,
  StopIcon,
} from "../ui/icons.tsx";
import { AppHeader, ConfirmSheet, LinkNotices, SLOT_COLOR } from "../ui/parts.tsx";

const SLOT_KEY = { 1: "t1C", 2: "t2C", 3: "t3C" } as const;

export function LiveCook({ snap, now }: { snap: Snapshot; now: number }) {
  const live = snap.live as LiveState;
  const session = live.session as NonNullable<LiveState["session"]>;
  const { readings, version } = useHistory(session.startedAt);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const series: SeriesDef[] = [
    {
      id: "pit",
      name: "Pit",
      color: "var(--pit)",
      curC: live.reading?.pitC ?? null,
      targetC: live.cook.active ? live.cook.pitTargetC : null,
    },
  ];
  for (const p of live.probes) {
    if (!p.item && p.tempC === null && !hasReadings(readings, p.slot)) continue;
    series.push({
      id: `p${p.slot}` as SeriesDef["id"],
      name: foodLabel(p.item?.food ?? null, p.slot).short,
      color: SLOT_COLOR[p.slot],
      curC: p.tempC,
      targetC: p.item && p.item.endedAt === null ? p.item.targetC : null,
    });
  }

  return (
    <main className="screen">
      <AppHeader snap={snap} now={now} />
      <LinkNotices snap={snap} now={now} />
      <SessionNotices live={live} now={now} />
      {session.looksDoneAt !== null && <LooksDone live={live} now={now} />}
      <PitCard live={live} />
      <TempChart
        readings={readings}
        version={version}
        start={session.startedAt}
        now={now}
        series={series}
      />
      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 className="h2" style={{ margin: "4px 4px 0" }}>
          Probes
        </h2>
        {live.probes.map((p) => (
          <ProbeCard key={p.slot} probe={p} now={now} readings={readings} version={version} />
        ))}
      </section>
      <CookButtons live={live} onEnd={() => setConfirmEnd(true)} />
      {confirmEnd && (
        <ConfirmSheet
          title="End this cook?"
          body="Turns the fan off and saves the cook to History."
          confirm="End cook"
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            void api.end();
          }}
        />
      )}
    </main>
  );
}

function hasReadings(readings: Reading[], slot: ProbeSlot): boolean {
  const key = SLOT_KEY[slot];
  return readings.some((r) => r[key] !== null);
}

// ---------------------------------------------------------------- notices

const dismissKey = (kind: string, id: number) => `ember.dismissed.${kind}.${id}`;
function isDismissed(kind: string, id: number): boolean {
  try {
    return localStorage.getItem(dismissKey(kind, id)) === "1";
  } catch {
    return false;
  }
}

function SessionNotices({ live, now }: { live: LiveState; now: number }) {
  const session = live.session as NonNullable<LiveState["session"]>;
  const [, rerender] = useState(0);
  const dismiss = (kind: string, id: number) => {
    try {
      localStorage.setItem(dismissKey(kind, id), "1");
    } catch {
      // Private mode: it just comes back next time.
    }
    rerender((n) => n + 1);
  };
  const notices: ReactNode[] = [];
  if (session.foundRunning && !isDismissed("found", session.id)) {
    const target = live.cook.pitTargetC;
    notices.push(
      <InfoNotice
        key="found"
        text={`Ember found the grill already cooking at ${deg(target)} and is tracking it as this cook.`}
        onDismiss={() => dismiss("found", session.id)}
      />,
    );
  }
  const foreign = live.link.foreignControlAt;
  if (foreign !== null && foreign >= session.startedAt && !isDismissed("foreign", foreign)) {
    notices.push(
      <InfoNotice
        key="foreign"
        text={`Another app changed the cook ${agoShort(now - foreign)}. Ember follows what the grill is doing now.`}
        onDismiss={() => dismiss("foreign", foreign)}
      />,
    );
  }
  return <>{notices}</>;
}

function agoShort(ms: number): string {
  return ms < 60_000 ? "just now" : `${duration(ms)} ago`;
}

function InfoNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div role="status" className="notice notice-info" style={{ padding: "12px 8px 12px 16px" }}>
      <InfoIcon color="var(--text-2)" style={{ marginTop: 1 }} />
      <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.45, flex: 1 }}>
        {text}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{ width: 36, height: 36, marginTop: -8 }}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

function LooksDone({ live, now }: { live: LiveState; now: number }) {
  const session = live.session as NonNullable<LiveState["session"]>;
  const hadFood = live.probes.some((p) => p.item);
  const mins =
    session.autoEndAt === null ? null : Math.max(1, Math.ceil((session.autoEndAt - now) / 60_000));
  const body = `${hadFood ? "All probes are out and the pit is cooling." : "The pit is cooling."}${
    mins === null ? "" : ` The cook ends by itself in ${mins} min.`
  }`;
  return (
    <div
      role="status"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--line-2)",
        borderRadius: 20,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <CheckCircleIcon color="var(--ok)" style={{ marginTop: 1 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>Looks like you're done</span>
          <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.45 }}>{body}</span>
        </span>
      </div>
      <div className="grid-2" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn"
          style={{ height: 44, borderRadius: 12, fontSize: 14 }}
          onClick={() => void api.keepGoing()}
        >
          Keep going
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ height: 44, borderRadius: 12, fontSize: 14 }}
          onClick={() => void api.end()}
        >
          End cook
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pit

function pitStatusLine(live: LiveState): { icon: ReactNode; text: string } {
  if (live.fireUp) return { icon: <FlameIcon size={14} color="var(--pit)" />, text: "Firing up" };
  switch (live.cook.status) {
    case "holding":
      return { icon: <CheckIcon size={14} color="var(--ok)" />, text: "Holding steady" };
    case "heating":
      return { icon: <ArrowUpIcon size={14} color="var(--pit)" />, text: "Heating up" };
    case "cooling":
      return { icon: <ArrowDownIcon size={14} color="var(--p2)" />, text: "Cooling down" };
    default:
      return live.session?.looksDoneAt
        ? { icon: <ArrowDownIcon size={14} color="var(--p2)" />, text: "Cooling" }
        : { icon: <StopIcon size={14} color="var(--text-2)" />, text: "Fan off" };
  }
}

function PitCard({ live }: { live: LiveState }) {
  const pit = live.reading?.pitC ?? null;
  const fan = live.reading?.fanPct ?? 0;
  const status = pitStatusLine(live);
  return (
    <section
      className="card"
      style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-2)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span className="dot" style={{ background: "var(--pit)" }} />
            Pit
          </div>
          <div className="big" style={{ fontSize: 88, marginTop: 10 }}>
            {f(pit)}
            <span
              style={{
                fontSize: 44,
                color: "var(--text-2)",
                verticalAlign: "top",
                marginLeft: 2,
              }}
            >
              °
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate({ name: "targets", tab: "pit" })}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 2,
            padding: "10px 14px",
            borderRadius: 14,
            background: "var(--surface-2)",
            border: 0,
            minHeight: 44,
            color: "var(--text)",
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            Target
            <PencilIcon size={12} />
          </span>
          <span style={{ fontSize: 26, fontWeight: 500, letterSpacing: "-0.02em" }}>
            {deg(live.cook.pitTargetC)}
          </span>
        </button>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 13,
          color: "var(--text-2)",
        }}
      >
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text)" }}
        >
          {status.icon}
          {status.text}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          Fan {fan}%
          <span
            style={{
              width: 48,
              height: 4,
              borderRadius: 2,
              background: "var(--line)",
              overflow: "hidden",
              display: "inline-block",
            }}
          >
            <span
              style={{
                display: "block",
                width: `${Math.min(100, Math.max(0, fan))}%`,
                height: 4,
                background: "var(--text-2)",
              }}
            />
          </span>
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- probes

function ProbeCard({
  probe,
  now,
  readings,
  version,
}: {
  probe: LiveProbe;
  now: number;
  readings: Reading[];
  version: number;
}) {
  const { item, slot } = probe;
  if (item && item.endedAt !== null) return <CameOffCard item={item} />;
  if (item) {
    return <ItemCard probe={probe} item={item} now={now} readings={readings} version={version} />;
  }
  const open = () => navigate({ name: "targets", tab: slot });
  if (probe.tempC === null) {
    return (
      <button
        type="button"
        onClick={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 52,
          padding: "0 16px",
          borderRadius: 18,
          background: "var(--surface-off)",
          border: "1px solid var(--surface-2)",
          color: "var(--text-3)",
          fontSize: 14,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="dot" style={{ background: "var(--muted-dot)" }} />
          Probe {slot}
        </span>
        <span style={{ fontSize: 13 }}>Not plugged in</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "var(--surface)",
        borderRadius: 18,
        padding: 16,
        border: 0,
        color: "var(--text)",
        textAlign: "left",
      }}
    >
      <ProbeHead slot={slot} name={`Probe ${slot}`} right="Set a target" />
      <span className="big" style={{ fontSize: 40, fontWeight: 400, letterSpacing: "-0.03em" }}>
        {deg(probe.tempC)}
      </span>
    </button>
  );
}

function ProbeHead({ slot, name, right }: { slot: ProbeSlot; name: string; right: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        width: "100%",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 14,
          color: "var(--text)",
          minWidth: 0,
        }}
      >
        <span className="dot" style={{ background: SLOT_COLOR[slot] }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <span className="faint">P{slot}</span>
      </span>
      <span style={{ fontSize: 13, color: "var(--text-2)", whiteSpace: "nowrap" }}>{right}</span>
    </div>
  );
}

function ItemCard({
  probe,
  item,
  now,
  readings,
  version,
}: {
  probe: LiveProbe;
  item: Item;
  now: number;
  readings: Reading[];
  version: number;
}) {
  const slot = probe.slot;
  const cur = probe.tempC;
  // Progress runs from the probe's temperature when the item started to its target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands in for readings
  const startC = useMemo(() => {
    const key = SLOT_KEY[slot];
    return readings.find((r) => r.ts >= item.startedAt && r[key] !== null)?.[key] ?? null;
  }, [version, slot, item.startedAt]);
  const base = startC !== null && startC < item.targetC - 1 ? startC : 0;
  const pct =
    cur === null ? 0 : Math.max(0, Math.min(100, ((cur - base) / (item.targetC - base)) * 100));
  const done = item.reachedTargetAt !== null || (cur !== null && cur >= item.targetC);
  const est = probe.estimate;
  const right = done ? (
    <span style={{ color: "var(--ok)" }}>Done</span>
  ) : cur === null ? (
    "Not reading"
  ) : est?.kind === "eta" ? (
    `est. ${duration(est.atMs - now)}`
  ) : est?.kind === "stalled" ? (
    "Stalled"
  ) : (
    ""
  );
  return (
    <button
      type="button"
      onClick={() => navigate({ name: "targets", tab: slot })}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "var(--surface)",
        borderRadius: 18,
        padding: 16,
        border: 0,
        color: "var(--text)",
        textAlign: "left",
      }}
    >
      <ProbeHead slot={slot} name={foodLabel(item.food, slot).name} right={right} />
      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="big" style={{ fontSize: 40, fontWeight: 400, letterSpacing: "-0.03em" }}>
          {deg(cur)}
        </span>
        <span style={{ fontSize: 15, color: "var(--text-2)" }}>of {deg(item.targetC)}</span>
      </span>
      <span
        style={{
          display: "block",
          width: "100%",
          height: 4,
          background: "var(--line)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            height: 4,
            borderRadius: 2,
            width: `${pct.toFixed(0)}%`,
            background: SLOT_COLOR[slot],
          }}
        />
      </span>
    </button>
  );
}

function CameOffCard({ item }: { item: Item }) {
  const after = duration((item.endedAt ?? item.startedAt) - item.startedAt);
  const text =
    item.cameOffC === null
      ? `Came off after ${after}`
      : `Came off at ${deg(item.cameOffC)} after ${after}`;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        background: "var(--surface-off)",
        border: "1px solid var(--surface-2)",
        borderRadius: 18,
        padding: "14px 16px",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
          <CheckIcon size={14} color="var(--ok)" width={2.25} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {foodLabel(item.food, item.slot).name}
          </span>
          <span className="faint">P{item.slot}</span>
        </span>
        <span style={{ fontSize: 13, color: "var(--text-2)" }}>{text}</span>
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => navigate({ name: "food", slot: item.slot })}
      >
        Reuse probe
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- buttons

function CookButtons({ live, onEnd }: { live: LiveState; onEnd: () => void }) {
  const fireUp = (
    <button type="button" className="btn" onClick={() => navigate({ name: "fireUp" })}>
      <FlameIcon size={18} color="var(--pit)" />
      Fire it up
    </button>
  );
  const end = (
    <button type="button" className="btn" onClick={onEnd}>
      <StopIcon size={16} />
      End cook
    </button>
  );
  if (live.cook.active) {
    return (
      <div className="grid-2">
        {fireUp}
        {end}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="grid-2">
        {fireUp}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void api.start(live.cook.pitTargetC)}
        >
          Resume at {deg(live.cook.pitTargetC)}
        </button>
      </div>
      {end}
    </div>
  );
}
