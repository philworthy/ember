// History (design/canvas/History.dc.html): cooks newest first, each with a small graph, how long
// it ran, the pit target and the foods. A card opens Past cook; the open cook opens Live cook.

import { foodLabel, type HistoryEntry } from "@ember/shared";
import { useCallback, useEffect, useState } from "react";
import { api, HISTORY_PAGE } from "../api.ts";
import { Sparkline } from "../chart/Sparkline.tsx";
import { day, duration, pitDeg } from "../format.ts";
import { href, navigate, type Route } from "../router.ts";
import { SheetHeader } from "../ui/parts.tsx";

/** "Flat 6.5 lb · Point 4 lb", or "No probes". */
export function foodsText(foods: HistoryEntry["foods"]): string {
  if (!foods.length) return "No probes";
  return foods
    .map((x) => {
      const name = foodLabel(x.food, x.slot).short;
      return x.weightLb === null ? name : `${name} ${x.weightLb} lb`;
    })
    .join(" · ");
}

export function History() {
  const [cooks, setCooks] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: number) => {
    const r = await api.history(before);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setCooks((prev) => (before === undefined ? r.data : [...(prev ?? []), ...r.data]));
    setMore(r.data.length === HISTORY_PAGE);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="screen">
      <SheetHeader title="History" back />
      {error && <p className="muted">{error}</p>}
      {cooks && cooks.length === 0 && (
        <p className="muted" style={{ textAlign: "center", marginTop: 40 }}>
          No cooks yet.
        </p>
      )}
      {cooks && cooks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cooks.map((c) => (
            <CookCard key={c.id} cook={c} />
          ))}
        </div>
      )}
      {more && cooks && (
        <button type="button" className="btn" onClick={() => void load(cooks.at(-1)?.startedAt)}>
          Show older
        </button>
      )}
    </main>
  );
}

function CookCard({ cook }: { cook: HistoryEntry }) {
  const open = cook.endedAt === null;
  const route: Route = open ? { name: "home" } : { name: "cook", id: cook.id };
  const slots = [...new Set(cook.foods.map((x) => x.slot))].sort();
  return (
    <a
      href={href(route)}
      onClick={(e) => {
        e.preventDefault();
        navigate(route);
      }}
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderRadius: 18,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 16,
            fontWeight: 500,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {cook.title}
        </span>
        <span className="label" style={{ whiteSpace: "nowrap" }}>
          {open ? "Cooking now" : day(cook.startedAt)}
        </span>
      </div>
      {!open && cook.spark.length > 1 && (
        <Sparkline
          points={cook.spark}
          slots={slots}
          span={{ from: cook.startedAt, to: cook.endedAt as number }}
        />
      )}
      <div className="label" style={{ display: "flex", gap: 14, minWidth: 0 }}>
        {!open && (
          <span style={{ whiteSpace: "nowrap" }}>
            {duration((cook.endedAt as number) - cook.startedAt)}
          </span>
        )}
        {cook.pitTargetC !== null && (
          <span style={{ whiteSpace: "nowrap" }}>Pit {pitDeg(cook.pitTargetC)}</span>
        )}
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {foodsText(cook.foods)}
        </span>
      </div>
    </a>
  );
}
