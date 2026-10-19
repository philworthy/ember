// Targets (design/canvas/SetTarget.dc.html): Pit / P1–P3 tabs, a big value with −/+ and a slider,
// pit presets, and the food on each probe. Values are picked in °F and sent as °C.

import {
  cToDisplayF,
  cToF,
  foodLabel,
  fToC,
  fToDeviceC,
  type Item,
  type LiveState,
  type ProbeSetup,
  type ProbeSlot,
} from "@ember/shared";
import { useState } from "react";
import { api } from "../api.ts";
import { f, PIT_PRESETS } from "../format.ts";
import type { Snapshot } from "../live.ts";
import { goBack, navigate, type TargetTab } from "../router.ts";
import { ChevronIcon, WarnIcon } from "../ui/icons.tsx";
import { ConfirmSheet, SheetHeader, SLOT_COLOR, StepButton } from "../ui/parts.tsx";

const TABS: { tab: TargetTab; label: string; color: string }[] = [
  { tab: "pit", label: "Pit", color: "var(--pit)" },
  { tab: 1, label: "P1", color: SLOT_COLOR[1] },
  { tab: 2, label: "P2", color: SLOT_COLOR[2] },
  { tab: 3, label: "P3", color: SLOT_COLOR[3] },
];

const PIT = { min: 150, max: 700, step: 5 };
const PROBE = { min: 100, max: 220, step: 1 };
const DEFAULT_PROBE_F = 203;

/** What's on a probe now: the active item, or the setup for the next cook. */
export function probeFood(live: LiveState, slot: ProbeSlot): Item | ProbeSetup | null {
  const p = live.probes[slot - 1];
  if (!p) return null;
  if (p.item && p.item.endedAt === null) return p.item;
  return p.setup;
}

export function Targets({ snap, tab }: { snap: Snapshot; tab: TargetTab }) {
  const live = snap.live as LiveState;
  const [drafts, setDrafts] = useState<Partial<Record<TargetTab, number>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPit = tab === "pit";
  const range = isPit ? PIT : PROBE;
  const food = isPit ? null : probeFood(live, tab);
  const initial = isPit
    ? Math.round(cToF(live.cook.pitTargetC) / PIT.step) * PIT.step
    : food
      ? cToDisplayF(food.targetC)
      : DEFAULT_PROBE_F;
  const val = drafts[tab] ?? initial;
  const color = TABS.find((t) => t.tab === tab)?.color ?? "var(--pit)";
  const setVal = (v: number) => {
    setError(null);
    setDrafts((d) => ({
      ...d,
      [tab]: Math.max(range.min, Math.min(range.max, Math.round(v / range.step) * range.step)),
    }));
  };

  const name = isPit ? "Pit" : foodLabel(food?.food ?? null, tab).name;
  const curC = isPit ? (live.reading?.pitC ?? null) : (live.probes[tab - 1]?.tempC ?? null);
  const caption =
    curC === null
      ? isPit
        ? "No pit reading"
        : `Probe ${tab} isn't plugged in`
      : `${name} is ${f(curC)}° now`;

  const submit = async () => {
    setBusy(true);
    const r = isPit
      ? await api.setPit(fToDeviceC(val), { quiet: true })
      : await api.setProbeTarget(tab, fToC(val), { quiet: true });
    setBusy(false);
    if (r.ok) goBack();
    else setError(r.error);
  };

  return (
    <main
      className="screen"
      style={{ gap: 18, paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}
    >
      <SheetHeader title="Targets" />

      <fieldset
        aria-label="Choose what to set"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 4,
          background: "var(--surface)",
          borderRadius: 14,
          padding: 4,
          border: 0,
          margin: 0,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            aria-pressed={t.tab === tab}
            onClick={() => {
              setError(null);
              navigate({ name: "targets", tab: t.tab }, { replace: true });
            }}
            style={{
              height: 44,
              border: 0,
              borderRadius: 10,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: t.tab === tab ? "var(--line)" : "transparent",
              color: t.tab === tab ? "var(--text)" : "var(--text-2)",
            }}
          >
            <span className="dot" style={{ width: 7, height: 7, background: t.color }} />
            {t.label}
          </button>
        ))}
      </fieldset>

      {!isPit && <FoodCard slot={tab} food={food} live={live} />}

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <StepButton
            kind="dec"
            label={`Lower by ${range.step} degrees`}
            onStep={() => setVal(val - range.step)}
          />
          <div className="big" style={{ fontSize: 88 }} aria-live="polite">
            {val}
            <span style={{ fontSize: 40, color: "var(--text-2)", verticalAlign: "top" }}>°</span>
          </div>
          <StepButton
            kind="inc"
            label={`Raise by ${range.step} degrees`}
            onStep={() => setVal(val + range.step)}
          />
        </div>
        <div style={{ fontSize: 13, color: "var(--text-2)" }}>{caption}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="target-slider" className="sr-only">
          Target temperature
        </label>
        <input
          id="target-slider"
          className="slider"
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={val}
          onChange={(e) => setVal(Number(e.target.value))}
          style={{ accentColor: color }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          <span>{range.min}°</span>
          <span>{range.max}°</span>
        </div>
      </div>

      {isPit && (
        <div className="grid-2" style={{ gap: 8 }}>
          {PIT_PRESETS.map(([label, temp]) => (
            <button
              key={label}
              type="button"
              aria-pressed={temp === val}
              onClick={() => setVal(temp)}
              style={{
                height: 52,
                borderRadius: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 14px",
                fontSize: 14,
                background: "var(--surface)",
                color: "var(--text)",
                border: `1px solid ${temp === val ? color : "var(--surface-2)"}`,
              }}
            >
              <span>{label}</span>
              <span className="muted">{temp}°</span>
            </button>
          ))}
        </div>
      )}

      {isPit && val > 500 && (
        <div
          role="note"
          className="notice notice-warn"
          style={{ gap: 10, borderRadius: 14, padding: "12px 14px" }}
        >
          <WarnIcon size={18} color="var(--warn-fg)" style={{ marginTop: 1 }} />
          <span style={{ fontSize: 13, lineHeight: 1.45, color: "var(--warn-text)" }}>
            Above 500° the iKamand can't hold a set point. It runs the fan flat out, and you control
            the heat with the top vent.
          </span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {error && (
          <p
            role="alert"
            style={{ margin: 0, fontSize: 13, color: "var(--warn-fg)", textAlign: "center" }}
          >
            {error}
          </p>
        )}
        {!isPit && (
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)", textAlign: "center" }}>
            You’ll get a notification when it reaches {val}°.
          </p>
        )}
        <button
          type="button"
          className="btn btn-lg btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          Set {name.toLowerCase()} to {val}°
        </button>
      </div>
    </main>
  );
}

function FoodCard({
  slot,
  food,
  live,
}: {
  slot: ProbeSlot;
  food: Item | ProbeSetup | null;
  live: LiveState;
}) {
  const f = food?.food ?? null;
  const meta = !f
    ? "Pick a food for its pull-at temperature"
    : [
        "custom" in f ? "Custom" : f.path.slice(0, -1).join(" › "),
        food?.weightLb ? `${food.weightLb} lb` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const canClear = food !== null;
  const inSession = live.session !== null;
  const [confirm, setConfirm] = useState(false);
  const name = foodLabel(f, slot).name;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        onClick={() => navigate({ name: "food", slot })}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          minHeight: 64,
          padding: "10px 16px",
          borderRadius: 16,
          background: "var(--surface)",
          border: 0,
          color: "var(--text)",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span className="label">Probe {slot}</span>
          <span style={{ fontSize: 16, fontWeight: 500 }}>{f ? name : "No food yet"}</span>
          {meta && <span className="label">{meta}</span>}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--text-2)",
          }}
        >
          {f ? "Change" : "Choose"}
          <ChevronIcon size={16} color="var(--text-3)" />
        </span>
      </button>
      {canClear && (
        <button
          type="button"
          onClick={() => (inSession ? setConfirm(true) : void api.clearProbe(slot))}
          style={{
            alignSelf: "flex-end",
            border: 0,
            background: "transparent",
            color: "var(--text-2)",
            fontSize: 13,
            height: 32,
            padding: "0 4px",
          }}
        >
          {inSession ? "Take it off this probe" : "Clear"}
        </button>
      )}
      {confirm && (
        <ConfirmSheet
          title={`Take ${name} off probe ${slot}?`}
          body="It's done in this cook: Ember saves its stats and stops tracking it."
          confirm="Take it off"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void api.clearProbe(slot);
          }}
        />
      )}
    </div>
  );
}
