// Fire it up (design/canvas/FireUp.dc.html): choose 10 / 20 / 30 min and "then hold", then a
// running state with a countdown ring, pit temperature and its rate of rise, fan and Stop.

import { cDeltaToF, type LiveState } from "@ember/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { countdown, deg } from "../format.ts";
import { type Snapshot, store } from "../live.ts";
import { goHome } from "../router.ts";
import { FlameIcon } from "../ui/icons.tsx";
import { SheetHeader, Toggle } from "../ui/parts.tsx";

const OPTIONS = [
  { min: 10, range: "For 200–400°" },
  { min: 20, range: "For 400–600°" },
  { min: 30, range: "For 600°+ searing" },
];

export function FireUp({ snap, now }: { snap: Snapshot; now: number }) {
  const live = snap.live as LiveState;
  const running = live.fireUp;
  const wasRunning = useRef(false);

  // When the timer ends (or another client stops it), go back to the cook or Idle.
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current) goHome();
  }, [running]);

  return (
    <main
      className="screen"
      style={{ gap: 20, paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}
    >
      <SheetHeader title="Fire it up" />
      {running ? <Running live={live} now={now} /> : <Choose live={live} />}
    </main>
  );
}

function Choose({ live }: { live: LiveState }) {
  const [dur, setDur] = useState(10);
  const [hold, setHold] = useState(true);
  const [busy, setBusy] = useState(false);
  const target = live.cook.pitTargetC;
  const cooking = live.session !== null && live.cook.active;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: "var(--text-2)" }}>
        Runs the fan at full speed to get the coals going. Pick a time for how hot you want the
        grill.
      </p>

      <fieldset
        aria-label="Duration"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          border: 0,
          margin: 0,
          padding: 0,
        }}
      >
        {OPTIONS.map((o) => {
          const on = o.min === dur;
          return (
            <button
              key={o.min}
              type="button"
              aria-pressed={on}
              onClick={() => setDur(o.min)}
              style={{
                height: 72,
                borderRadius: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 18px",
                background: "var(--surface)",
                color: "var(--text)",
                border: `1px solid ${on ? "var(--pit)" : "var(--surface-2)"}`,
                textAlign: "left",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}>
                  {o.min} min
                </span>
                <span style={{ fontSize: 13, color: "var(--text-2)" }}>{o.range}</span>
              </span>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: on ? "7px solid var(--pit)" : "2px solid var(--muted-dot)",
                }}
              />
            </button>
          );
        })}
      </fieldset>

      <button
        type="button"
        aria-pressed={hold}
        onClick={() => setHold(!hold)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 16px",
          borderRadius: 16,
          background: "var(--surface)",
          border: 0,
          color: "var(--text)",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 15 }}>Then hold pit at {deg(target)}</span>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {hold
              ? cooking
                ? "Goes back to holding when the timer ends"
                : "Starts the cook when the timer ends"
              : cooking
                ? "Turns the fan off when the timer ends"
                : "Stops when the timer ends"}
          </span>
        </span>
        <Toggle on={hold} />
      </button>

      <div style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-lg btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api.fireUp(dur, hold ? target : null);
          setBusy(false);
        }}
      >
        <FlameIcon size={18} width={2} />
        Start · {dur} min
      </button>
    </div>
  );
}

/** Pit rate of rise in °F/min over the last minute of frames, once there's enough to tell. */
function pitRate(): number | null {
  const frames = store.frames.filter((r) => r.pitC !== null);
  const last = frames.at(-1);
  if (!last) return null;
  const window = frames.filter((r) => r.ts >= last.ts - 60_000);
  const first = window[0];
  if (!first || last.ts - first.ts < 20_000) return null;
  return (
    cDeltaToF((last.pitC as number) - (first.pitC as number)) / ((last.ts - first.ts) / 60_000)
  );
}

function Running({ live, now }: { live: LiveState; now: number }) {
  const f = live.fireUp as NonNullable<LiveState["fireUp"]>;
  const total = f.minutes * 60_000;
  const left = Math.max(0, f.endsAtMs - now);
  const frac = Math.min(1, Math.max(0, 1 - left / total));
  const C = 2 * Math.PI * 110;
  const rate = pitRate();
  const [stopping, setStopping] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 28,
        flex: 1,
        paddingTop: 24,
      }}
    >
      <div style={{ position: "relative", width: 260, height: 260 }}>
        <svg
          width="260"
          height="260"
          viewBox="0 0 260 260"
          role="img"
          aria-label={`${countdown(left)} remaining`}
          style={{ display: "block", transform: "rotate(-90deg)" }}
        >
          <circle
            cx="130"
            cy="130"
            r="110"
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={10}
          />
          <circle
            cx="130"
            cy="130"
            r="110"
            fill="none"
            stroke="var(--pit)"
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${(C * frac).toFixed(1)} ${C.toFixed(1)}`}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>Remaining</span>
          <span className="big" style={{ fontSize: 56, letterSpacing: "-0.04em" }}>
            {countdown(left)}
          </span>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>of {f.minutes}:00</span>
        </div>
      </div>

      <div className="grid-2" style={{ width: "100%" }}>
        <div
          className="card"
          style={{
            borderRadius: 16,
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span className="label">Pit</span>
          <span style={{ fontSize: 28, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
            {deg(live.reading?.pitC)}
            {rate !== null && Math.abs(rate) >= 0.5 && (
              <span
                style={{
                  fontSize: 14,
                  color: rate > 0 ? "var(--ok)" : "var(--text-2)",
                  marginLeft: 6,
                }}
              >
                {rate > 0 ? "↑" : "↓"} {Math.abs(Math.round(rate))}°/min
              </span>
            )}
          </span>
        </div>
        <div
          className="card"
          style={{
            borderRadius: 16,
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span className="label">Fan</span>
          <span style={{ fontSize: 28, letterSpacing: "-0.02em" }}>
            {live.reading?.fanPct ?? 0}%
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", textAlign: "center" }}>
        {f.thenHoldC !== null
          ? `Then holding pit at ${deg(f.thenHoldC)}`
          : "Then the fan turns off"}
      </p>

      <div style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-lg"
        style={{ width: "100%", fontWeight: 500 }}
        disabled={stopping}
        onClick={async () => {
          setStopping(true);
          await api.stop();
          setStopping(false);
        }}
      >
        Stop
      </button>
    </div>
  );
}
