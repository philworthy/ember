// History, kept plain until M7 designs it.

import type { Session } from "@ember/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { duration } from "../format.ts";
import { SheetHeader } from "../ui/parts.tsx";

export function History() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.sessions().then((r) => (r.ok ? setSessions(r.data) : setError(r.error)));
  }, []);
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <main className="screen">
      <SheetHeader title="History" />
      {error && <p className="muted">{error}</p>}
      {sessions && sessions.length === 0 && <p className="muted">No cooks yet.</p>}
      {sessions && sessions.length > 0 && (
        <div className="list">
          {sessions.map((s) => (
            <div key={s.id} className="list-row" style={{ minHeight: 60 }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 15 }}>{s.title}</span>
                <span className="label">{date.format(s.startedAt)}</span>
              </span>
              <span className="muted" style={{ fontSize: 14, whiteSpace: "nowrap" }}>
                {s.endedAt === null ? "Cooking" : duration(s.endedAt - s.startedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="faint" style={{ fontSize: 13, textAlign: "center" }}>
        Graphs, stats and notes for past cooks arrive with History in a later update.
      </p>
    </main>
  );
}
