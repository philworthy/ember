// Web push on this device (docs/brief.md › Alerts). iOS only offers push to the app installed on
// the home screen, and only asks for permission from a tap, so `enable` must run straight from
// the button's click. The app re-sends its subscription whenever it opens or comes back to the
// foreground (`syncPush`), so a server that lost it (a new database, the simulator's) has it
// again without a tap.

import { api } from "./api.ts";

export type PushState =
  /** No service worker: a dev build, or a page that isn't on localhost or HTTPS. */
  | "noWorker"
  | "unsupported"
  /** iOS outside the installed app. */
  | "needsInstall"
  | "denied"
  | "off"
  | "on";

export interface PushEnv {
  hasWorker: boolean;
  hasPush: boolean;
  isIOS: boolean;
  standalone: boolean;
  permission: NotificationPermission | null;
  subscribed: boolean;
}

export function pushState(e: PushEnv): PushState {
  if (e.isIOS && !e.standalone) return "needsInstall";
  if (!e.hasPush || e.permission === null) return "unsupported";
  if (!e.hasWorker) return "noWorker";
  if (e.permission === "denied") return "denied";
  return e.subscribed && e.permission === "granted" ? "on" : "off";
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return (await reg?.pushManager?.getSubscription()) ?? null;
}

export async function readPush(): Promise<{ state: PushState; sub: PushSubscription | null }> {
  const reg = await registration();
  const sub = (await reg?.pushManager?.getSubscription()) ?? null;
  const state = pushState({
    hasWorker: reg !== null,
    hasPush: "PushManager" in window,
    isIOS: isIOS(),
    standalone: isStandalone(),
    permission: "Notification" in window ? Notification.permission : null,
    subscribed: sub !== null,
  });
  return { state, sub };
}

/** The VAPID key as the bytes `subscribe` wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const have = sub.options?.applicationServerKey;
  if (!have) return true; // can't tell; assume it's ours
  const a = new Uint8Array(have);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function save(sub: PushSubscription): Promise<string | null> {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return "The browser gave no keys";
  const r = await api.subscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return r.ok ? null : r.error;
}

/** Ask for permission and subscribe. Call it directly from a tap. Returns an error, or null. */
export async function enablePush(publicKey: string): Promise<string | null> {
  // First thing, before any other await: iOS only asks while handling the tap.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications weren't allowed";
  const reg = await registration();
  if (!reg) return "The app isn't ready yet. Reload and try again.";
  try {
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
    return await save(sub);
  } catch (err) {
    return (err as Error).message || "Couldn't subscribe";
  }
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.unsubscribe(sub.endpoint);
  await sub.unsubscribe().catch(() => false);
}

export async function testPush(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return "This device isn't subscribed";
  const r = await api.testPush(sub.endpoint);
  if (!r.ok) return r.error;
  return r.data.ok ? null : (r.data.error ?? "The push service refused it");
}

/**
 * Hand the server this device's subscription again (or renew it for a new key). Runs on launch,
 * whenever the app comes back to the foreground (an installed iOS app usually resumes without
 * reloading), and when Settings opens. Returns an error, or null.
 */
export async function syncPush(): Promise<string | null> {
  if (!("Notification" in window) || Notification.permission !== "granted") return null;
  const reg = await registration();
  let sub = (await reg?.pushManager?.getSubscription()) ?? null;
  if (!reg || !sub) return null;
  const info = await api.push();
  if (!info.ok) return info.error;
  if (!sameKey(sub, info.data.publicKey)) {
    // The server's keys changed: the old subscription can't be used. Renewing may need a tap on
    // some browsers; then Settings shows "Turn on alerts" again.
    await sub.unsubscribe().catch(() => false);
    sub = await reg.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.data.publicKey) })
      .catch(() => null);
    if (!sub) return null;
  }
  return save(sub);
}

let lastSync = 0;

/** Re-sync when the app comes back to the foreground, at most once a minute. */
export function syncPushOnResume(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - lastSync < 60_000) return;
    lastSync = Date.now();
    void syncPush().catch(() => null);
  });
}
