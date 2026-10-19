// The alerts API: subscribing, prefs, the test notification and device info.

import { type AlertPrefs, fDeltaToC, type PushPayload } from "@ember/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.ts";
import { ALERTS } from "../config.ts";
import { Catalog, SEED_CATALOG } from "../cook/catalog.ts";
import { PushSender, type PushTransport } from "../push/sender.ts";
import { cookHarness } from "../test/cook.ts";

const catalog = Catalog.fromFile(SEED_CATALOG);
let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const SUB = { endpoint: "https://web.push.apple.com/xyz", keys: { p256dh: "p", auth: "a" } };

async function setup(transport: PushTransport) {
  const h = cookHarness();
  await h.boot();
  const sender = new PushSender({ store: h.store, transport, now: () => h.clock.now() });
  const app = await buildApp({
    engine: h.engine,
    store: h.store,
    catalog,
    clock: h.clock,
    serveClient: false,
    push: {
      sender,
      publicKey: "PUBKEY",
      deviceInfo: async () => ({ source: "simulator", host: null, firmware: "1.0.56", mac: null }),
    },
  });
  close = () => app.close();
  return { h, app };
}

describe("push API", () => {
  it("subscribes (idempotently), unsubscribes, and reports the key and prefs", async () => {
    const { h, app } = await setup(async () => 201);
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        payload: SUB,
      });
      expect(res.statusCode).toBe(204);
    }
    expect(h.store.pushSubscriptions()).toHaveLength(1);
    expect((await app.inject("/api/push")).json()).toEqual({
      publicKey: "PUBKEY",
      prefs: ALERTS.defaults,
      subscriptions: 1,
    });
    const bad = await app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      payload: { ...SUB, endpoint: "http://insecure.example" },
    });
    expect(bad.statusCode).toBe(400);
    const del = await app.inject({
      method: "DELETE",
      url: "/api/push/subscriptions",
      payload: { endpoint: SUB.endpoint },
    });
    expect(del.statusCode).toBe(204);
    expect(h.store.pushSubscriptions()).toEqual([]);
  });

  it("saves prefs within limits", async () => {
    const { app } = await setup(async () => 201);
    const prefs: AlertPrefs = {
      ...ALERTS.defaults,
      itemCameOff: false,
      pitOffTarget: { on: true, bandC: fDeltaToC(40), forMin: 15 },
    };
    const res = await app.inject({ method: "PUT", url: "/api/alerts", payload: prefs });
    expect(res.statusCode).toBe(200);
    expect((await app.inject("/api/push")).json().prefs).toEqual(prefs);
    const tooTight = await app.inject({
      method: "PUT",
      url: "/api/alerts",
      payload: { ...prefs, pitOffTarget: { on: true, bandC: fDeltaToC(5), forMin: 10 } },
    });
    expect(tooTight.statusCode).toBe(400);
  });

  it("sends a test to one phone and returns the push service's answer", async () => {
    const sent: PushPayload[] = [];
    const { app } = await setup(async (sub, body) => {
      if (sub.endpoint !== SUB.endpoint) throw new Error("wrong phone");
      sent.push(JSON.parse(body) as PushPayload);
      return 201;
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/push/test",
      payload: { endpoint: SUB.endpoint },
    });
    expect(missing.statusCode).toBe(404);
    await app.inject({ method: "POST", url: "/api/push/subscriptions", payload: SUB });
    const res = await app.inject({
      method: "POST",
      url: "/api/push/test",
      payload: { endpoint: SUB.endpoint },
    });
    expect(res.json()).toEqual({ ok: true, status: 201 });
    expect(sent).toMatchObject([{ type: "test", title: "Ember test", url: "/#/settings" }]);
  });

  it("reports a failed test, and drops a subscription that's gone", async () => {
    const { h, app } = await setup(async () => {
      throw Object.assign(new Error("Received unexpected response code"), {
        statusCode: 410,
        body: "Gone",
      });
    });
    await app.inject({ method: "POST", url: "/api/push/subscriptions", payload: SUB });
    const res = await app.inject({
      method: "POST",
      url: "/api/push/test",
      payload: { endpoint: SUB.endpoint },
    });
    expect(res.json()).toEqual({ ok: false, status: 410, error: "HTTP 410: Gone" });
    expect(h.store.pushSubscriptions()).toEqual([]);
  });

  it("serves device info", async () => {
    const { app } = await setup(async () => 201);
    expect((await app.inject("/api/device")).json()).toMatchObject({ firmware: "1.0.56" });
  });
});
