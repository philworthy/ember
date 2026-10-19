// Alerts API (docs/brief.md › Alerts): the VAPID key and prefs, subscribing a phone, the alert
// toggles and thresholds, a test notification, and what Settings shows about the grill.

import type { AlertPrefs, DeviceInfo } from "@ember/shared";
import type { FastifyInstance } from "fastify";
import { ALERTS } from "../config.ts";
import type { Store } from "../db/store.ts";
import { ALERT_PREFS_KEY, alertPrefs } from "../push/alerts.ts";
import type { PushSender } from "../push/sender.ts";

export interface PushDeps {
  store: Store;
  sender: PushSender;
  publicKey: string;
  deviceInfo: () => Promise<DeviceInfo>;
}

const endpointBody = {
  type: "object",
  required: ["endpoint"],
  properties: { endpoint: { type: "string", minLength: 1, maxLength: 2048 } },
} as const;

const subscriptionBody = {
  type: "object",
  required: ["endpoint", "keys"],
  properties: {
    endpoint: { type: "string", minLength: 1, maxLength: 2048, pattern: "^https://" },
    keys: {
      type: "object",
      required: ["p256dh", "auth"],
      properties: {
        p256dh: { type: "string", minLength: 1, maxLength: 512 },
        auth: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
  },
} as const;

const { bandC, forMin } = ALERTS.limits;
const minutes = { type: "integer", minimum: forMin.min, maximum: forMin.max } as const;
const prefsBody = {
  type: "object",
  additionalProperties: false,
  required: [
    "itemAtTarget",
    "itemCameOff",
    "pitOffTarget",
    "deviceOffline",
    "fireUpFinished",
    "looksDone",
  ],
  properties: {
    itemAtTarget: { type: "boolean" },
    itemCameOff: { type: "boolean" },
    fireUpFinished: { type: "boolean" },
    looksDone: { type: "boolean" },
    pitOffTarget: {
      type: "object",
      additionalProperties: false,
      required: ["on", "bandC", "forMin"],
      properties: {
        on: { type: "boolean" },
        // A hair of slack, so a °F value converted on the client is never rejected.
        bandC: { type: "number", minimum: bandC.min - 1e-6, maximum: bandC.max + 1e-6 },
        forMin: minutes,
      },
    },
    deviceOffline: {
      type: "object",
      additionalProperties: false,
      required: ["on", "forMin"],
      properties: { on: { type: "boolean" }, forMin: minutes },
    },
  },
} as const;

export function registerPushRoutes(app: FastifyInstance, deps: PushDeps): void {
  const { store, sender, publicKey } = deps;

  app.get("/api/push", async () => ({
    publicKey,
    prefs: alertPrefs(store),
    subscriptions: store.pushSubscriptions().length,
  }));

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    "/api/push/subscriptions",
    { schema: { body: subscriptionBody } },
    async (req, reply) => {
      const { endpoint, keys } = req.body;
      store.upsertPushSubscription(
        { endpoint, keys, userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null },
        Date.now(),
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Body: { endpoint: string } }>(
    "/api/push/subscriptions",
    { schema: { body: endpointBody } },
    async (req, reply) => {
      store.deletePushSubscription(req.body.endpoint);
      return reply.code(204).send();
    },
  );

  app.put<{ Body: AlertPrefs }>("/api/alerts", { schema: { body: prefsBody } }, async (req) => {
    store.setSetting(ALERT_PREFS_KEY, req.body);
    return alertPrefs(store);
  });

  // Sends one notification to this phone and waits for the push service's answer, so Settings
  // can show whether it went out (and from the NAS, that pushes reach Apple at all).
  app.post<{ Body: { endpoint: string } }>(
    "/api/push/test",
    { schema: { body: endpointBody } },
    async (req, reply) => {
      const sub = store.pushSubscription(req.body.endpoint);
      if (!sub) return reply.code(404).send({ error: "This device isn't subscribed" });
      return sender.send(
        sub,
        {
          type: "test",
          title: "Ember test",
          body: "Alerts are working. They'll look like this.",
          url: "/#/settings",
          tag: "test",
        },
        ALERTS.testTimeoutMs,
      );
    },
  );

  app.get("/api/device", async () => deps.deviceInfo());
}
