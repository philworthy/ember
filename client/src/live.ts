// The live state: one EventSource on /api/live (`state` frames carry the whole LiveState, `event`
// frames carry CookEvents), plus the readings behind the graph. The server owns all state; this
// only mirrors it.

import type { CookEvent, LiveState, Reading } from "@ember/shared";
import { useEffect, useState, useSyncExternalStore } from "react";

export type Conn = "connecting" | "open" | "down";

export interface Snapshot {
  live: LiveState | null;
  conn: Conn;
  /** Real time (Date.now) the last state frame arrived. */
  recvAt: number;
  /** Bumped whenever `history.readings` changes. */
  historyVersion: number;
}

const HOUR = 3_600_000;
/** The server answers at most 48 h of readings at once. */
const MAX_HISTORY_MS = 47 * HOUR;
/** Frames kept for rates of rise (server time). */
const FRAMES_MS = 10 * 60_000;

class LiveStore {
  snap: Snapshot = { live: null, conn: "connecting", recvAt: Date.now(), historyVersion: 0 };
  /** Readings from `from` to now, for the graph. */
  readonly history: { from: number | null; readings: Reading[] } = { from: null, readings: [] };
  /** The latest readings from state frames (oldest first). */
  frames: Reading[] = [];

  private es: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchSeq = 0;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: CookEvent) => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  onEvent(fn: (e: CookEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  connect(): void {
    this.es?.close();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const es = new EventSource("/api/live");
    this.es = es;
    if (this.snap.conn !== "down") this.set({ conn: "connecting" });
    es.addEventListener("open", () => {
      this.set({ conn: "open" });
      // Fill whatever the graph missed while the stream was down or the phone was asleep.
      void this.loadHistory();
    });
    es.addEventListener("state", (m) => this.onState(JSON.parse((m as MessageEvent).data)));
    es.addEventListener("event", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as CookEvent;
      for (const fn of this.eventListeners) fn(e);
    });
    es.addEventListener("error", () => {
      this.set({ conn: "down" });
      // The browser retries by itself unless the stream is closed for good (an HTTP error).
      if (es.readyState === EventSource.CLOSED) {
        this.retryTimer = setTimeout(() => this.connect(), 3000);
      }
    });
  }

  /** Retry now (the offline banner's button). */
  retry(): void {
    this.connect();
  }

  /** iOS suspends background pages; reconnect when the app comes back. */
  resume(): void {
    if (!this.es || this.es.readyState === EventSource.CLOSED) this.connect();
    else void this.loadHistory();
  }

  private onState(live: LiveState): void {
    const r = live.reading;
    if (r) {
      const last = this.frames.at(-1);
      if (!last || r.ts > last.ts) {
        this.frames.push(r);
        while (this.frames.length > 2 && (this.frames[0] as Reading).ts < r.ts - FRAMES_MS) {
          this.frames.shift();
        }
        this.appendHistory(r);
      }
    }
    this.set({ live, recvAt: Date.now() });
  }

  private appendHistory(r: Reading): void {
    const h = this.history;
    if (h.from === null) return;
    const last = h.readings.at(-1);
    if (last && r.ts <= last.ts) return;
    h.readings.push(r);
    this.set({ historyVersion: this.snap.historyVersion + 1 });
  }

  /** Keep readings from `from` (e.g. the session start) for the graph; null drops them. */
  setHistoryFrom(from: number | null): void {
    if (from === this.history.from) return;
    this.history.from = from;
    this.history.readings = [];
    this.set({ historyVersion: this.snap.historyVersion + 1 });
    if (from !== null) void this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    const from = this.history.from;
    if (from === null) return;
    const seq = ++this.fetchSeq;
    const to = Math.max(serverNow(this.snap), from + 1);
    const start = Math.max(from, to - MAX_HISTORY_MS);
    try {
      const res = await fetch(`/api/readings?from=${Math.floor(start)}&to=${Math.ceil(to)}`);
      if (!res.ok) return;
      const fetched = (await res.json()) as Reading[];
      if (seq !== this.fetchSeq || this.history.from !== from) return;
      const lastTs = fetched.at(-1)?.ts ?? -Infinity;
      // Frames that arrived while the request was in flight come after what it returned.
      const newer = this.history.readings.filter((r) => r.ts > lastTs);
      this.history.readings = fetched.concat(newer);
      this.set({ historyVersion: this.snap.historyVersion + 1 });
    } catch {
      // Offline: the next reconnect loads it again.
    }
  }
}

export const store = new LiveStore();

/** The server's clock now: the last frame's `now`, advanced at the server's rate (sim speed-up). */
export function serverNow(snap: Snapshot = store.snap): number {
  const live = snap.live;
  if (!live) return Date.now();
  return live.now + (Date.now() - snap.recvAt) * (live.clockRate || 1);
}

export function useLive(): Snapshot {
  return useSyncExternalStore(store.subscribe, () => store.snap);
}

/** Server time, re-rendering every `everyMs` of real time (frames re-render too). */
export function useServerNow(everyMs = 1000): number {
  const snap = useLive();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return serverNow(snap);
}

/** Readings for the graph from `from`; re-renders as they grow. */
export function useHistory(from: number | null): { readings: Reading[]; version: number } {
  const snap = useLive();
  useEffect(() => {
    store.setHistoryFrom(from);
  }, [from]);
  return { readings: store.history.readings, version: snap.historyVersion };
}

export function startLive(): void {
  store.connect();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") store.resume();
  });
  window.addEventListener("online", () => store.resume());
}
