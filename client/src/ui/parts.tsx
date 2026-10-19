// Pieces shared by the screens: headers, notices, steppers, toggles and the confirm sheet.

import type { ProbeSlot } from "@ember/shared";
import { type ReactNode, useEffect, useRef } from "react";
import { countdown, duration } from "../format.ts";
import { type Snapshot, store } from "../live.ts";
import { goBack, navigate } from "../router.ts";
import {
  BackIcon,
  CloseIcon,
  HistoryIcon,
  MinusIcon,
  OfflineIcon,
  PlusIcon,
  SettingsIcon,
  WarnIcon,
} from "./icons.tsx";

export const SLOT_COLOR: Record<ProbeSlot, string> = {
  1: "var(--p1)",
  2: "var(--p2)",
  3: "var(--p3)",
};

/** The pill next to "Ember": what the grill is doing right now. */
export function statusPill(snap: Snapshot, now: number): { text: string; dot: string } {
  const live = snap.live;
  if (!live || snap.conn === "down") {
    return snap.conn === "down"
      ? { text: "No connection", dot: "var(--warn-fg)" }
      : { text: "Connecting…", dot: "var(--text-3)" };
  }
  if (live.link.halted) return { text: "Halted", dot: "var(--warn-fg)" };
  if (live.link.state === "offline") return { text: "Offline", dot: "var(--pit)" };
  if (live.link.state !== "online") return { text: "Connecting…", dot: "var(--text-3)" };
  if (live.fireUp) {
    return { text: `Fire it up · ${countdown(live.fireUp.endsAtMs - now)}`, dot: "var(--pit)" };
  }
  if (live.session) {
    const elapsed = duration(now - live.session.startedAt);
    return live.cook.active
      ? { text: `Cooking · ${elapsed}`, dot: "var(--ok)" }
      : { text: `Stopped · ${elapsed}`, dot: "var(--text-3)" };
  }
  return { text: "Ready", dot: "var(--ok)" };
}

export function AppHeader({ snap, now }: { snap: Snapshot; now: number }) {
  const pill = statusPill(snap, now);
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 44,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>Ember</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--text-2)",
            padding: "5px 10px",
            border: "1px solid var(--line)",
            borderRadius: 999,
            whiteSpace: "nowrap",
          }}
        >
          <span className="dot" style={{ width: 6, height: 6, background: pill.dot }} />
          {pill.text}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          type="button"
          className="icon-btn"
          aria-label="History"
          onClick={() => navigate({ name: "history" })}
        >
          <HistoryIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Settings"
          onClick={() => navigate({ name: "settings" })}
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}

/** Close (✕) or Back (‹) on the left, a title in the middle, an optional slot on the right. */
export function SheetHeader({
  title,
  sub,
  back,
  onBack,
  right,
}: {
  title: string;
  sub?: string;
  back?: boolean;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <header className="sheet-head">
      <button
        type="button"
        className="icon-btn"
        aria-label={back ? "Back" : "Close"}
        onClick={onBack ?? goBack}
      >
        {back ? <BackIcon /> : <CloseIcon />}
      </button>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          minWidth: 0,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%",
          }}
        >
          {title}
        </h1>
        {sub && <span className="label">{sub}</span>}
      </div>
      <span style={{ justifySelf: "end" }}>{right}</span>
    </header>
  );
}

/** The device can't be reached (Idle and Live cook), or the server stopped driving it. */
export function LinkNotices({ snap, now }: { snap: Snapshot; now: number }) {
  const live = snap.live;
  if (snap.conn === "down") {
    return (
      <WarnNotice
        icon={<OfflineIcon color="var(--warn-fg)" />}
        title="Can't reach Ember"
        body="Check you're on the home network (or Tailscale). Ember keeps the cook going and catches up when you're back."
        action={
          <button type="button" className="btn btn-sm" onClick={() => store.retry()}>
            Retry
          </button>
        }
      />
    );
  }
  if (!live) return null;
  if (live.link.halted) {
    return (
      <WarnNotice
        icon={<WarnIcon color="var(--warn-fg)" />}
        title="Ember stopped controlling the grill"
        body="Something kept failing, so Ember stopped sending commands. The grill holds its last setting. Restart the Ember server to take over again."
      />
    );
  }
  if (live.link.state === "offline") {
    const seen = live.link.lastSeenMs;
    return (
      <WarnNotice
        icon={<OfflineIcon color="var(--warn-fg)" />}
        title="Can't reach the grill"
        body={`Check the iKamand has power and is on Wi-Fi.${seen ? ` Last seen ${agoText(now - seen)}.` : ""}`}
        action={
          <button type="button" className="btn btn-sm" onClick={() => store.retry()}>
            Retry
          </button>
        }
      />
    );
  }
  return null;
}

function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${duration(ms)} ago`;
}

export function WarnNotice({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div role="status" className="notice notice-warn">
      <span style={{ marginTop: 1 }}>{icon}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        <span style={{ fontSize: 15, fontWeight: 500 }}>{title}</span>
        {body && <span style={{ fontSize: 13, color: "#D6C3BA", lineHeight: 1.4 }}>{body}</span>}
      </div>
      {action && <span style={{ alignSelf: "center" }}>{action}</span>}
    </div>
  );
}

/** A round −/+ button that repeats while held. */
export function StepButton({
  kind,
  label,
  onStep,
  disabled,
}: {
  kind: "dec" | "inc";
  label: string;
  onStep: () => void;
  disabled?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const step = useRef(onStep);
  step.current = onStep;
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const repeat = (delay: number) => {
    timer.current = setTimeout(() => {
      step.current();
      repeat(70);
    }, delay);
  };
  return (
    <button
      type="button"
      className="round-btn"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        step.current();
        repeat(450);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          step.current();
        }
      }}
    >
      {kind === "dec" ? <MinusIcon /> : <PlusIcon />}
    </button>
  );
}

export function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 48,
        height: 28,
        borderRadius: 999,
        padding: 3,
        display: "flex",
        flex: "none",
        background: on ? "var(--pit)" : "var(--muted-dot)",
        justifyContent: on ? "flex-end" : "flex-start",
        transition: "background 0.15s",
      }}
    >
      <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--text)" }} />
    </span>
  );
}

export function ConfirmSheet({
  title,
  body,
  confirm,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="backdrop">
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        style={{ position: "absolute", inset: 0, border: 0, background: "transparent" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bottom-sheet"
        style={{ position: "relative" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 17, fontWeight: 500 }}>{title}</span>
          <span className="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
            {body}
          </span>
        </div>
        <div className="grid-2">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
