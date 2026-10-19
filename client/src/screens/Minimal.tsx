// History and Settings, kept plain until their milestones (M7 designs History, M6 adds alerts).

import type { LiveState, Session } from "@ember/shared";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api.ts";
import { duration } from "../format.ts";
import type { Snapshot } from "../live.ts";
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

const LINK_TEXT: Record<LiveState["link"]["state"], string> = {
  starting: "Starting",
  online: "Connected",
  recovering: "Reconnecting",
  offline: "Offline",
};

export function Settings({ snap, now }: { snap: Snapshot; now: number }) {
  const live = snap.live;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return (
    <main className="screen">
      <SheetHeader title="Settings" />
      <Section title="Grill">
        <Row label="Status" value={live ? LINK_TEXT[live.link.state] : "—"} />
        <Row
          label="Last reading"
          value={live?.link.lastSeenMs ? `${duration(now - live.link.lastSeenMs)} ago` : "—"}
        />
        {live?.link.halted && <Row label="Control" value="Halted after repeated errors" />}
        {live && live.clockRate !== 1 && (
          <Row label="Source" value={`Simulator at ${live.clockRate}×`} />
        )}
      </Section>
      <Section title="Alerts">
        <p
          className="muted"
          style={{ margin: 0, padding: "14px 0", fontSize: 14, lineHeight: 1.45 }}
        >
          Notifications for food reaching target, the pit drifting and the cook finishing come in a
          later update.
        </p>
      </Section>
      <Section title="Install">
        <p
          className="muted"
          style={{ margin: 0, padding: "14px 0", fontSize: 14, lineHeight: 1.45 }}
        >
          {standalone
            ? "Ember is installed on this device."
            : "On iPhone, open Ember in Safari, tap Share, then Add to Home Screen. Alerts need the installed app."}
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="label" style={{ padding: "0 4px" }}>
        {title}
      </span>
      <div className="list">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="list-row">
      <span style={{ fontSize: 15 }}>{label}</span>
      <span className="muted" style={{ fontSize: 14 }}>
        {value}
      </span>
    </div>
  );
}
