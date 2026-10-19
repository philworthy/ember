// REST commands (docs/brief.md › API). Everything on the wire is °C. Commands answer 202 at once;
// the device's read-back arrives later as a `commandResult` event on the live stream.

import type {
  AlertPrefs,
  CatalogNode,
  DeviceInfo,
  Food,
  ProbeSlot,
  PushInfo,
  PushResult,
  RecentFood,
  Session,
} from "@ember/shared";
import { toast } from "./ui/toast.tsx";

export interface Accepted {
  id: string | null;
  sessionId: number | null;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function request<T>(method: string, url: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `Ember answered ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Can't reach Ember. Check you're on the home network." };
  }
}

/** A command; a failure shows as a toast unless the caller shows it itself. */
async function command(
  method: string,
  url: string,
  body?: unknown,
  opts: { quiet?: boolean } = {},
): Promise<Result<Accepted>> {
  const r = await request<Accepted>(method, url, body);
  if (!r.ok && !opts.quiet) toast(r.error);
  return r;
}

type Opts = { quiet?: boolean };

export const api = {
  start: (pitC: number, o?: Opts) => command("POST", "/api/cook/start", { pitC }, o),
  setPit: (pitC: number, o?: Opts) => command("POST", "/api/cook/target", { pitC }, o),
  stop: () => command("POST", "/api/cook/stop"),
  end: () => command("POST", "/api/cook/end"),
  fireUp: (minutes: number, thenHoldC: number | null) =>
    command("POST", "/api/fire-up", { minutes, thenHoldC }),
  keepGoing: () => command("POST", "/api/session/keep-going"),
  assignProbe: (
    slot: ProbeSlot,
    body: { food: Food | null; weightLb?: number | null; targetC?: number },
    o?: Opts,
  ) => command("PUT", `/api/probes/${slot}`, body, o),
  setProbeTarget: (slot: ProbeSlot, targetC: number, o?: Opts) =>
    command("POST", `/api/probes/${slot}/target`, { targetC }, o),
  clearProbe: (slot: ProbeSlot) => command("DELETE", `/api/probes/${slot}`),

  catalog: () => request<CatalogNode[]>("GET", "/api/catalog"),
  recentFoods: () => request<RecentFood[]>("GET", "/api/foods/recent"),
  sessions: () => request<Session[]>("GET", "/api/sessions?limit=50"),

  push: () => request<PushInfo>("GET", "/api/push"),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<unknown>("POST", "/api/push/subscriptions", sub),
  unsubscribe: (endpoint: string) =>
    request<unknown>("DELETE", "/api/push/subscriptions", { endpoint }),
  setAlerts: (prefs: AlertPrefs) => request<AlertPrefs>("PUT", "/api/alerts", prefs),
  testPush: (endpoint: string) => request<PushResult>("POST", "/api/push/test", { endpoint }),
  device: () => request<DeviceInfo>("GET", "/api/device"),
};
