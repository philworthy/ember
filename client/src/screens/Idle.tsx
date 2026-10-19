// Idle / start cook (design/canvas/Idle.dc.html): current readings, the targets Start will use,
// Fire it up and Start cook. Dimmed with a banner when the grill can't be reached.

import { cToF, foodLabel, type LiveState } from "@ember/shared";
import type { ReactNode } from "react";
import { api } from "../api.ts";
import { countdown, deg, f, presetName } from "../format.ts";
import type { Snapshot } from "../live.ts";
import { navigate } from "../router.ts";
import { ChevronIcon, FlameIcon } from "../ui/icons.tsx";
import { AppHeader, LinkNotices, SLOT_COLOR } from "../ui/parts.tsx";

export function Idle({ snap, now }: { snap: Snapshot; now: number }) {
  const live = snap.live as LiveState;
  const offline = snap.conn === "down" || live.link.state === "offline" || live.link.halted;
  const dim = offline ? 0.45 : 1;
  const pit = live.reading?.pitC ?? null;
  const pitNote =
    pit === null
      ? "No reading"
      : live.cook.active
        ? "Fan on"
        : cToF(pit) < 150
          ? "Not lit"
          : "Fan off";
  const target = live.cook.pitTargetC;
  const preset = presetName(Math.round(cToF(target)));
  const setups = live.probes.filter((p) => p.setup);
  const probeTargets = setups.length
    ? setups.map((p) => `P${p.slot} ${deg(p.setup?.targetC)}`).join(" · ")
    : "None yet";

  return (
    <main className="screen" style={{ minHeight: "100dvh" }}>
      <AppHeader snap={snap} now={now} />
      <LinkNotices snap={snap} now={now} />
      {live.fireUp && (
        <button
          type="button"
          className="notice notice-info"
          onClick={() => navigate({ name: "fireUp" })}
          style={{ alignItems: "center", color: "var(--text)", textAlign: "left" }}
        >
          <FlameIcon color="var(--pit)" />
          <span style={{ flex: 1, fontSize: 15 }}>
            Fire it up · {countdown(live.fireUp.endsAtMs - now)} left
          </span>
          <ChevronIcon size={18} color="var(--text-2)" />
        </button>
      )}

      <section
        className="card"
        style={{ padding: 20, display: "flex", flexDirection: "column", gap: 6, opacity: dim }}
      >
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
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="big" style={{ fontSize: 72 }}>
            {f(pit)}
            <span style={{ fontSize: 36, color: "var(--text-2)", verticalAlign: "top" }}>°</span>
          </span>
          <span style={{ fontSize: 14, color: "var(--text-2)" }}>{pitNote}</span>
        </div>
      </section>

      <section
        className="card"
        style={{ padding: "6px 16px", display: "flex", flexDirection: "column", opacity: dim }}
      >
        {live.probes.map((p, i) => {
          const plugged = p.tempC !== null;
          const fg = plugged ? "var(--text)" : "var(--text-3)";
          return (
            <button
              key={p.slot}
              type="button"
              onClick={() => navigate({ name: "targets", tab: p.slot })}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                height: 52,
                border: 0,
                borderBottom: i < 2 ? "1px solid var(--surface-2)" : 0,
                background: "transparent",
                padding: 0,
                color: fg,
                fontSize: 14,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span
                  className="dot"
                  style={{ background: plugged ? SLOT_COLOR[p.slot] : "var(--muted-dot)" }}
                />
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  Probe {p.slot}
                  {p.setup?.food && (
                    <span className="muted"> · {foodLabel(p.setup.food, p.slot).name}</span>
                  )}
                </span>
              </span>
              <span style={{ fontSize: 15, whiteSpace: "nowrap" }}>
                {plugged ? deg(p.tempC) : "Not plugged in"}
              </span>
            </button>
          );
        })}
      </section>

      <div style={{ flex: 1 }} />

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <TargetRow
          label="Pit target"
          value={`${deg(target)}${preset ? ` · ${preset}` : ""}`}
          onClick={() => navigate({ name: "targets", tab: "pit" })}
        />
        <TargetRow
          label="Probe targets"
          value={probeTargets}
          onClick={() => navigate({ name: "targets", tab: setups[0]?.slot ?? 1 })}
        />
        <div className="grid-2" style={{ marginTop: 6 }}>
          <button
            type="button"
            className="btn btn-lg"
            style={{ fontSize: 15 }}
            onClick={() => navigate({ name: "fireUp" })}
          >
            <FlameIcon size={18} color="var(--pit)" />
            Fire it up
          </button>
          <button
            type="button"
            className="btn btn-lg btn-primary"
            disabled={offline}
            onClick={() => void api.start(target)}
          >
            Start cook
          </button>
        </div>
      </section>
    </main>
  );
}

function TargetRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 60,
        padding: "0 16px",
        borderRadius: 16,
        background: "var(--surface)",
        border: 0,
        color: "var(--text)",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="label">{label}</span>
        <span style={{ fontSize: 17, fontWeight: 500 }}>{value}</span>
      </span>
      <ChevronIcon size={18} color="var(--text-2)" />
    </button>
  );
}
