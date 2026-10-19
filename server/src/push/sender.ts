// Sends web pushes to the saved subscriptions. It never throws: a failed push is logged and saved
// on the subscription, and one the push service says is gone (404/410) is deleted.

import type { PushPayload, PushResult } from "@ember/shared";
import webpush from "web-push";
import { ALERTS } from "../config.ts";
import type { PushSubscriptionRow, Store } from "../db/store.ts";
import type { Vapid } from "./vapid.ts";

/** The network call, swappable in tests. Resolves with the push service's status code. */
export type PushTransport = (
  sub: PushSubscriptionRow,
  body: string,
  opts: { ttlS: number; timeoutMs?: number },
) => Promise<number>;

export function webPushTransport(vapid: Vapid): PushTransport {
  const vapidDetails = {
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  };
  return async (sub, body, opts) => {
    const res = await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, {
      vapidDetails,
      TTL: opts.ttlS,
      urgency: "high",
      timeout: opts.timeoutMs,
    });
    return res.statusCode;
  };
}

export interface PushSenderOptions {
  store: Store;
  transport: PushTransport;
  now: () => number;
  log?: (msg: string, data?: unknown) => void;
}

export class PushSender {
  constructor(private readonly opts: PushSenderOptions) {}

  /** Send to every subscription. Resolves when all have answered; never rejects. */
  async sendAll(payload: PushPayload): Promise<PushResult[]> {
    const subs = this.opts.store.pushSubscriptions();
    return Promise.all(subs.map((s) => this.send(s, payload)));
  }

  async send(
    sub: PushSubscriptionRow,
    payload: PushPayload,
    timeoutMs?: number,
  ): Promise<PushResult> {
    const { store, transport, now } = this.opts;
    const log = this.opts.log ?? (() => {});
    const where = hostOf(sub.endpoint);
    try {
      const status = await transport(sub, JSON.stringify(payload), {
        ttlS: ALERTS.ttlS,
        timeoutMs,
      });
      store.markPush(sub.endpoint, now(), null);
      log(`push: ${payload.type} sent to ${where} (${status})`);
      return { ok: true, status };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const body = (err as { body?: string }).body?.trim();
      const error = [status && `HTTP ${status}`, body || (err as Error).message]
        .filter(Boolean)
        .join(": ");
      try {
        if (status === 404 || status === 410) {
          store.deletePushSubscription(sub.endpoint);
          log(`push: ${where} subscription expired; removed it`);
        } else {
          store.markPush(sub.endpoint, now(), error);
          log(`push: ${payload.type} to ${where} failed: ${error}`);
        }
      } catch (dbErr) {
        log("push: couldn't record the result", dbErr);
      }
      return { ok: false, status, error };
    }
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "?";
  }
}
