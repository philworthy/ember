// Alerts end to end: the `alerts` simulator scenario through the cook engine, with a fake push
// service, ticking the alert service after every poll as the server's timer would.

import { type AlertPrefs, fToDeviceC, type PushPayload } from "@ember/shared";
import { describe, expect, it } from "vitest";
import { ALERTS } from "../config.ts";
import { type CookHarness, cookHarness } from "../test/cook.ts";
import { HOUR, MIN, SEC } from "../test/harness.ts";
import { ALERT_PREFS_KEY, AlertService } from "./alerts.ts";
import { PushSender, type PushTransport } from "./sender.ts";

const SUB = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } };

function setup(transport?: PushTransport) {
  const h = cookHarness({ scenario: "alerts" });
  const sent: PushPayload[] = [];
  const sender = new PushSender({
    store: h.store,
    transport:
      transport ??
      (async (_sub, body) => {
        sent.push(JSON.parse(body) as PushPayload);
        return 201;
      }),
    now: () => h.clock.now(),
  });
  const logs: string[] = [];
  const alerts = new AlertService({
    engine: h.engine,
    store: h.store,
    sender,
    log: (m) => logs.push(m),
  });
  h.store.upsertPushSubscription(SUB, h.clock.now());
  const until = async (pred: () => boolean, maxMs: number) => {
    const end = h.clock.now() + maxMs;
    while (!pred()) {
      if (h.clock.now() >= end) throw new Error(`condition not met within ${maxMs / MIN} min`);
      await h.run(5 * SEC);
      alerts.tick();
    }
  };
  return { h, sent, logs, alerts, until };
}

/** Phil's part: chicken on P1, Fire it up 10 min then hold 350 °F. */
async function startCook(h: CookHarness) {
  await h.boot();
  h.engine.assignProbe(1, { food: { path: ["Poultry", "Chicken", "Whole"] } });
  h.engine.fireUp(10, fToDeviceC(350));
}

describe("alerts scenario", () => {
  it("sends each alert once, in order, with its screen", async () => {
    const { h, sent, until } = setup();
    await startCook(h);
    const has = (type: string) => () => sent.some((p) => p.type === type);

    await until(has("deviceOffline"), 3 * HOUR);
    await until(() => h.link.snapshot.link === "online", 10 * MIN);
    h.engine.stop();
    await until(has("looksDone"), 5 * MIN);
    await until(() => sent.filter((p) => p.type === "looksDone").length === 2, 70 * MIN);

    expect(sent.map((p) => p.type)).toEqual([
      "fireUpFinished",
      "pitOffTarget",
      "itemAtTarget",
      "itemCameOff",
      "deviceOffline",
      "looksDone",
      "looksDone",
    ]);
    const [fire, pit, at, off, offline, done, ended] = sent as PushPayload[];
    expect(fire).toMatchObject({ title: "Fire it up done", body: "Holding the pit at 350°." });
    expect(pit?.title).toMatch(/^Pit is \d+° below target$/);
    expect(pit?.body).toMatch(/^It's \d+°, target 350°, for 10m\.$/);
    expect(at?.title).toMatch(/^Chicken is at 16[5-6]°$/);
    expect(at?.body).toMatch(/^Probe 1 reached its 165° target after (\d+h )?\d+m\.$/);
    expect(off?.title).toBe("Chicken came off");
    expect(off?.body).toMatch(/^Came off at 1[67]\d° after (\d+h )?\d+m\.$/);
    expect(offline?.body).toBe("No readings for 2m. Check its power and Wi-Fi.");
    expect(done).toMatchObject({
      title: "Looks like you're done",
      body: "Ember ends the cook in 1h 00m unless you keep going.",
      url: "/#/",
    });
    expect(ended).toMatchObject({ title: "Cook ended", url: "/#/history", tag: done?.tag });
    expect(ended?.body).toMatch(/^Chicken ended automatically after (\d+h )?\d+m\.$/);
    expect(sent.slice(0, -1).every((p) => p.url === "/#/")).toBe(true);
    expect(new Set(sent.map((p) => p.tag)).size).toBe(6);
    expect(h.store.pushSubscription(SUB.endpoint)?.lastOkAt).not.toBeNull();
  });

  it("sends nothing when every alert is off", async () => {
    const { h, sent, until } = setup();
    const off: AlertPrefs = {
      itemAtTarget: false,
      itemCameOff: false,
      fireUpFinished: false,
      looksDone: false,
      pitOffTarget: { ...ALERTS.defaults.pitOffTarget, on: false },
      deviceOffline: { ...ALERTS.defaults.deviceOffline, on: false },
    };
    h.store.setSetting(ALERT_PREFS_KEY, off);
    await startCook(h);
    await until(() => h.ofCook("deviceOnline").length > 0, 3 * HOUR);
    expect(sent).toEqual([]);
  });

  it("never disturbs the cook when pushes fail", async () => {
    const { h, logs, until } = setup(async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    });
    await startCook(h);
    await until(() => h.ofCook("itemCameOff").length > 0, 3 * HOUR);
    expect(h.of("fault")).toEqual([]);
    expect(h.store.pushSubscription(SUB.endpoint)?.lastError).toBe("HTTP 500: boom");
    expect(logs.some((l) => l.startsWith("alert: "))).toBe(true);
    expect(h.engine.live().session?.id).toBe(1);
  });

  it("removes a subscription the push service says is gone", async () => {
    const { h, until } = setup(async () => {
      throw Object.assign(new Error("Gone"), { statusCode: 410 });
    });
    await startCook(h);
    await until(() => h.ofCook("fireUpFinished").length > 0, HOUR);
    await h.run(SEC);
    expect(h.store.pushSubscriptions()).toEqual([]);
  });
});
