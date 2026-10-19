// The cook engine against the simulator, on one ManualClock: sessions, items, stats and events
// end to end, including device reboots, server restarts and adopting a cook found running.

import { cToF, fToC, fToDeviceC, type ProbeSlot } from "@ember/shared";
import { describe, expect, it } from "vitest";
import { startCook } from "../device/protocol.ts";
import { type CookHarness, cookHarness } from "../test/cook.ts";
import { HOUR, MIN, SEC, T0 } from "../test/harness.ts";
import { CommandError, SETTING } from "./engine.ts";

const PIT_225 = fToDeviceC(225);
const BRISKET = { path: ["Beef", "Brisket", "Whole packer"] };
const PORK_BUTT = { path: ["Pork", "Butt / shoulder"] };

/** Event types in order, without the plumbing (command results, recovery). */
const story = (h: CookHarness) =>
  h.cookEvents.map((e) => e.type).filter((t) => t !== "commandResult" && t !== "recovery");

const nowS = (h: CookHarness) => Math.floor(h.clock.now() / 1000);

async function cooking(scenario: string, foods: [ProbeSlot, { path: string[] }][], pitC = PIT_225) {
  const h = cookHarness({ scenario });
  await h.boot();
  for (const [slot, food] of foods) h.engine.assignProbe(slot, { food });
  const { sessionId } = h.engine.start(pitC);
  await h.run(10 * SEC);
  return { h, sessionId: sessionId as number };
}

describe("brisket at 225 °F, start to finish (M3 done-when)", () => {
  it("produces the right session, item, stats and events", async () => {
    const h = cookHarness({ scenario: "brisket" });
    await h.boot();
    h.engine.assignProbe(1, { food: BRISKET, weightLb: 14 });
    expect(h.engine.live().probes[0]?.setup).toMatchObject({ food: BRISKET, targetC: 95 });
    const { sessionId } = h.engine.start(PIT_225);
    const id = sessionId as number;

    // Before the stall the estimate projects a finish; in the stall it says so.
    await h.runUntil(() => h.sim.probeC(1) >= fToC(120), 8 * HOUR);
    expect(h.engine.live().probes[0]?.estimate?.kind).toBe("eta");
    await h.runUntil(() => h.sim.probeC(1) >= fToC(160), 8 * HOUR);
    expect(h.engine.live().probes[0]?.estimate).toEqual({ kind: "stalled" });
    expect(h.engine.live().cook.status).toBe("holding");

    await h.runUntil(() => h.ofCook("itemCameOff").length > 0, 16 * HOUR);
    // Phil shuts the fan off; nobody answers "Looks done", so it ends itself an hour later.
    h.engine.stop();
    await h.runUntil(() => h.store.openSession() === null, 2 * HOUR);

    const session = h.store.session(id);
    expect(session).toMatchObject({ origin: "user", endedBy: "auto", title: "Brisket" });
    const looksDone = h.ofCook("looksDone")[0];
    expect(session?.endedAt).toBe((looksDone?.ts ?? 0) + HOUR);
    expect(h.store.targets(id).map((t) => [t.subject, t.targetC, t.source])).toEqual([
      ["pit", PIT_225, "user"],
      ["p1", 95, "user"],
    ]);

    const items = h.store.sessionItems(id);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item?.stats || item.endedAt === null || item.reachedTargetAt === null) {
      throw new Error("item incomplete");
    }
    expect(item).toMatchObject({ slot: 1, food: BRISKET, weightLb: 14, endReason: "removed" });
    expect(cToF(item.cameOffC ?? 0)).toBeGreaterThanOrEqual(203);
    expect(cToF(item.cameOffC ?? 0)).toBeLessThanOrEqual(206);
    expect(item.reachedTargetAt).toBeLessThanOrEqual(item.endedAt);
    const s = item.stats;
    expect(s.timeToTargetMs).toBe(item.reachedTargetAt - item.startedAt);
    expect(s.timeToTargetMs).toBeGreaterThan(8 * HOUR);
    expect(cToF(s.stallStartC ?? 0)).toBeCloseTo(155, -0.5); // ±3 °F
    expect(cToF(s.stallEndC ?? 0)).toBeCloseTo(165, -0.5);
    const stallH = ((s.stallEndAt ?? 0) - (s.stallStartAt ?? 0)) / HOUR;
    expect(stallH).toBeGreaterThan(2);
    expect(stallH).toBeLessThan(3.5);
    expect(cToF(s.avgPitC ?? 0)).toBeGreaterThan(218); // heat-up from cold pulls it down a bit
    expect(cToF(s.avgPitC ?? 0)).toBeLessThan(230);

    expect(story(h)).toEqual([
      "sessionStarted",
      "itemStarted",
      "itemAtTarget",
      "itemCameOff",
      "looksDone",
      "sessionEnded",
    ]);
    expect(h.ofCook("itemCameOff")[0]?.data).toMatchObject({ name: "Brisket", reason: "removed" });
    expect(h.ofCook("looksDone")[0]?.data).toMatchObject({ reason: "stopped" });
    expect(h.ofCook("sessionEnded")[0]?.data).toEqual({ endedBy: "auto" });
    expect(h.store.sessionEvents(id).map((e) => e.type)).toContain("itemCameOff");

    // Every kept poll is stored, cook or not.
    const rows = h.store.readings(T0, h.clock.now()).length;
    expect(rows).toBeGreaterThan(((h.clock.now() - T0) / (5 * SEC)) * 0.98);
    // The device is idle, and the server remembers that it stopped it.
    expect(h.sim.truth.acs).toBe(false);
    expect(h.store.getSetting(SETTING.linkRestore)).toMatchObject({
      intent: { kind: "idle", by: "ember" },
    });
  });
});

describe("device reboot mid-cook", () => {
  it("keeps the session and item, waits out the garbage, and resumes the cook", async () => {
    const { h, sessionId } = await cooking("rebootMidCook", [[1, BRISKET]]);
    await h.run(3 * HOUR + 10 * MIN);

    expect(h.store.openSession()?.id).toBe(sessionId);
    expect(h.store.activeItems().map((i) => i.slot)).toEqual([1]);
    expect(story(h)).toEqual(["sessionStarted", "itemStarted", "deviceOffline", "deviceOnline"]);
    expect(h.ofCook("recovery").map((e) => e.data.action)).toEqual(["stop", "resume"]);
    expect(h.sim.truth).toMatchObject({ acs: true, tptC: PIT_225 });
    // Nothing stored from the post-boot garbage window.
    const p1 = h.store.readings(T0 + 3 * HOUR, h.clock.now()).map((r) => r.t1C ?? 0);
    expect(Math.max(...p1) - Math.min(...p1)).toBeLessThan(5);
  });
});

describe("server restart mid-cook", () => {
  it("picks the same session up, resumes the cook and still sees the brisket come off", async () => {
    const { h, sessionId } = await cooking("brisket", [[1, BRISKET]]);
    await h.run(6 * HOUR);
    const before = h.store.readings(T0, h.clock.now()).length;

    // The server goes away for 10 minutes; the device carries on.
    h.restart();
    h.clock.advance(10 * MIN);
    await h.boot();
    expect(h.link.snapshot.intent).toMatchObject({ kind: "cook", tptC: PIT_225, origin: "user" });
    expect(h.ofCook("recovery").at(-1)?.data.action).toBe("resume");
    expect(h.engine.live().session?.id).toBe(sessionId);
    expect(h.engine.live().session?.foundRunning).toBe(false);

    await h.runUntil(() => h.ofCook("itemCameOff").length > 0, 12 * HOUR);
    expect(h.ofCook("sessionStarted")).toHaveLength(1);
    const item = h.store.sessionItems(sessionId)[0];
    expect(item?.endReason).toBe("removed");
    expect(cToF(item?.stats?.stallStartC ?? 0)).toBeCloseTo(155, -0.5);
    expect(h.store.readings(T0, h.clock.now()).length).toBeGreaterThan(before);
  });

  it("rebuilds an item's track, so an unplug that straddles the restart still counts", async () => {
    const { h, sessionId } = await cooking("brisket", [[1, BRISKET]]);
    await h.run(HOUR);
    const unpluggedAt = h.clock.now();
    h.sim.unplugProbe(1);
    await h.run(20 * SEC);
    h.restart();
    await h.boot();
    await h.run(MIN);
    const item = h.store.sessionItems(sessionId)[0];
    expect(item?.endReason).toBe("unplugged");
    // It came off at the last reading before the restart, with that reading's temperature.
    expect(item?.endedAt).toBe(unpluggedAt);
    expect(item?.cameOffC).not.toBeNull();
  });
});

describe("adopting a cook found running", () => {
  it("opens a session at the device's target and flags it", async () => {
    const h = cookHarness({ scenario: "brisket" });
    h.sim.foreignCommand(startCook(fToDeviceC(250), nowS(h)));
    await h.boot();
    await h.run(10 * SEC);

    const live = h.engine.live();
    expect(live.session).toMatchObject({
      origin: "adopted",
      foundRunning: true,
      title: "250° cook",
    });
    expect(live.session?.pitTargets.map((t) => [t.targetC, t.source])).toEqual([
      [fToDeviceC(250), "adopted"],
    ]);
    expect(story(h)).toEqual(["sessionStarted", "foundRunning"]);
    expect(live.cook).toMatchObject({ active: true, pitTargetC: fToDeviceC(250) });
    // A probe with readings and no food is just "Probe 1": logged, no item.
    expect(live.probes[0]).toMatchObject({ item: null });
    expect(live.probes[0]?.tempC).not.toBeNull();
    // Food assigned now starts an item in the adopted session.
    h.engine.assignProbe(1, { food: BRISKET });
    expect(h.store.activeItems()).toHaveLength(1);
    expect(h.engine.live().session?.title).toBe("Brisket");
  });

  it("stops the cook instead when Ember was the one that stopped it last", async () => {
    const h = cookHarness({
      scenario: "brisket",
      restore: { intent: { kind: "idle", by: "ember" }, sceSentS: null },
    });
    h.sim.foreignCommand(startCook(PIT_225, nowS(h)));
    await h.boot();
    expect(h.store.openSession()).toBeNull();
    expect(h.ofCook("recovery")[0]?.data.action).toBe("stop");
    await h.run(10 * SEC);
    expect(h.sim.truth.acs).toBe(false);
  });

  it("adopts after a server restart that lost the session", async () => {
    // The device kept cooking while the DB was replaced: intent says cook, no session row.
    const h = cookHarness({
      scenario: "brisket",
      restore: { intent: { kind: "cook", tptC: PIT_225, origin: "user" }, sceSentS: null },
    });
    h.sim.foreignCommand(startCook(PIT_225, nowS(h)));
    await h.boot();
    expect(h.engine.live().session).toMatchObject({ origin: "adopted", foundRunning: true });
  });
});

describe("items coming off", () => {
  it("ends an unplugged probe's item 30 s after its readings stop", async () => {
    const { h, sessionId } = await cooking("probeUnplugged", [
      [1, BRISKET],
      [2, PORK_BUTT],
    ]);
    await h.run(2 * HOUR + 2 * MIN);
    const items = h.store.sessionItems(sessionId);
    const p2 = items.find((i) => i.slot === 2);
    expect(p2?.endReason).toBe("unplugged");
    expect(p2?.cameOffC).not.toBeNull();
    // Came off at the last reading before the unplug, a little before 2 h.
    expect(T0 + 2 * HOUR - (p2?.endedAt ?? 0)).toBeLessThan(15 * SEC);
    const event = h.ofCook("itemCameOff")[0];
    expect(event?.ts).toBeGreaterThanOrEqual(T0 + 2 * HOUR + 30 * SEC);
    expect(event?.data).toMatchObject({ slot: 2, name: "Butt / shoulder", reason: "unplugged" });
    expect(items.find((i) => i.slot === 1)?.endedAt).toBeNull();
    expect(h.store.openSession()?.title).toBe("Brisket & Butt / shoulder");

    // Reuse probe: a new food on P2 starts a second item in the same session.
    h.engine.assignProbe(2, { food: { custom: "Sausages" }, targetC: fToC(160) });
    expect(h.store.sessionItems(sessionId).filter((i) => i.slot === 2)).toHaveLength(2);
  });

  it("ends a chicken taken off at 165 °F with the probe still in it", async () => {
    const { h, sessionId } = await cooking(
      "meatRemoved",
      [[1, { path: ["Poultry", "Chicken", "Whole"] }]],
      fToDeviceC(350),
    );
    await h.runUntil(() => h.ofCook("itemCameOff").length > 0, 6 * HOUR);
    const item = h.store.sessionItems(sessionId)[0];
    expect(item?.endReason).toBe("removed");
    expect(cToF(item?.cameOffC ?? 0)).toBeGreaterThanOrEqual(164);
    expect(cToF(item?.cameOffC ?? 0)).toBeLessThanOrEqual(168);
    expect(item?.reachedTargetAt).not.toBeNull();
    // The pit is still holding, so it doesn't look done yet.
    expect(h.ofCook("looksDone")).toEqual([]);
    expect(h.engine.live().probes[0]?.item?.endReason).toBe("removed");
  });

  it("doesn't end an item on probe noise below 140 °F or a short unplug", async () => {
    const { h, sessionId } = await cooking("brisket", [[1, BRISKET]]);
    await h.run(HOUR);
    h.sim.unplugProbe(1);
    await h.run(25 * SEC);
    h.sim.insertProbe(1, { startC: h.sim.probeC(1), weightLb: 14 });
    await h.run(HOUR);
    expect(h.store.sessionItems(sessionId)[0]?.endedAt).toBeNull();
  });
});

describe("ending", () => {
  it("End cook stops the device and closes the session and its items", async () => {
    const { h, sessionId } = await cooking("probeUnplugged", [
      [1, BRISKET],
      [2, PORK_BUTT],
    ]);
    await h.run(HOUR);
    h.engine.end();
    await h.run(10 * SEC);
    expect(h.store.session(sessionId)).toMatchObject({ endedBy: "user" });
    expect(h.store.sessionItems(sessionId).map((i) => i.endReason)).toEqual([
      "session_end",
      "session_end",
    ]);
    expect(h.sim.truth.acs).toBe(false);
    expect(h.engine.live().session).toBeNull();
  });

  it("a no-probe pizza cook looks done on Stop; Keep going holds it off until it re-arms", async () => {
    const { h, sessionId } = await cooking("pizza", [], fToDeviceC(700));
    expect(h.store.session(sessionId)?.title).toBe("700° cook");
    await h.run(HOUR);
    expect(h.ofCook("looksDone")).toEqual([]);

    h.engine.stop();
    await h.run(10 * SEC);
    expect(h.engine.live().session?.autoEndAt).not.toBeNull();
    h.engine.keepGoing();
    await h.run(2 * HOUR); // well past the auto-end: Keep going means it waits
    expect(h.store.openSession()?.id).toBe(sessionId);
    expect(h.ofCook("looksDone")).toHaveLength(1);

    // Another round: the cook runs again (conditions clear), then stops (they return).
    h.engine.start(fToDeviceC(700));
    await h.run(MIN);
    h.engine.stop();
    await h.run(MIN);
    expect(h.ofCook("looksDone")).toHaveLength(2);
    h.engine.end();
    expect(h.store.session(sessionId)?.endedBy).toBe("user");
  });

  it("doesn't look done while the pit settles back to target after Fire it up", async () => {
    const h = cookHarness({ scenario: "fireUp" });
    await h.boot();
    h.engine.fireUp(10, fToDeviceC(225));
    await h.run(2 * HOUR);
    expect(h.ofCook("fireUpFinished")).toHaveLength(1);
    // Fire it up overshoots the hold target; falling back to it isn't a dying fire.
    expect(Math.max(...h.store.readings(0, h.clock.now()).map((r) => r.pitC ?? 0))).toBeGreaterThan(
      fToDeviceC(225) + 15,
    );
    expect(h.ofCook("looksDone")).toEqual([]);
  });

  it("looks done when the pit falls for 15 min with the fan still on", async () => {
    const { h } = await cooking("pizza", [], fToDeviceC(500));
    await h.run(HOUR);
    // Phil shuts the vents: model it as the fan unplugged with the cook still active.
    h.sim.setFanPlugged(false);
    await h.runUntil(() => h.ofCook("looksDone").length > 0, HOUR);
    expect(h.ofCook("looksDone")[0]?.data).toMatchObject({ reason: "pitFalling" });
    await h.runUntil(() => h.store.openSession() === null, 2 * HOUR);
    // Auto-end turns the cook off too.
    await h.run(10 * SEC);
    expect(h.sim.truth.acs).toBe(false);
  });
});

describe("another client", () => {
  it("survives a foreign stop and restart without fighting or ending the session", async () => {
    const { h, sessionId } = await cooking("foreignClient", [[1, BRISKET]]);
    await h.run(2 * HOUR);
    expect(h.store.openSession()?.id).toBe(sessionId);
    expect(h.ofCook("foreignControl")).toHaveLength(2);
    expect(h.engine.live().link.foreignControlAt).not.toBeNull();
    expect(h.ofCook("looksDone")).toEqual([]); // the brisket is still on
    expect(h.sim.truth.acs).toBe(true);
  });

  it("opens a session when another client starts a cook", async () => {
    const h = cookHarness({ scenario: "brisket" });
    await h.boot();
    await h.run(MIN);
    h.sim.foreignCommand(startCook(PIT_225, nowS(h)));
    await h.run(MIN);
    expect(h.engine.live().session).toMatchObject({ origin: "foreign" });
  });
});

describe("Fire it up", () => {
  it("with then hold: opens a session now and holds the target when it ends", async () => {
    const h = cookHarness({ scenario: "fireUp" });
    await h.boot();
    const { sessionId } = h.engine.fireUp(10, PIT_225);
    await h.run(MIN);
    const live = h.engine.live();
    expect(live.session?.origin).toBe("fireUp");
    expect(live.fireUp).toMatchObject({ minutes: 10, thenHoldC: PIT_225 });
    expect(live.cook).toMatchObject({ active: true, pitTargetC: PIT_225 });

    await h.run(10 * MIN);
    expect(h.engine.live().fireUp).toBeNull();
    expect(h.store.sessionFireUps(sessionId as number)[0]).toMatchObject({ outcome: "hold" });
    expect(h.store.targets(sessionId as number).map((t) => [t.targetC, t.source])).toEqual([
      [PIT_225, "fireUp"],
    ]);
    expect(h.ofCook("fireUpFinished")[0]?.data).toMatchObject({ next: "hold" });
    expect(h.sim.truth).toMatchObject({ acs: true, tptC: PIT_225 });
  });

  it("without then hold: no session, and the device stops at the end", async () => {
    const h = cookHarness({ scenario: "fireUp" });
    await h.boot();
    h.engine.fireUp(10, null);
    await h.run(11 * MIN);
    expect(h.store.openSession()).toBeNull();
    expect(h.ofCook("fireUpFinished")[0]?.data).toMatchObject({ next: "stop" });
    expect(h.sim.truth.acs).toBe(false);
  });

  it("Stop ends it early", async () => {
    const h = cookHarness({ scenario: "fireUp" });
    await h.boot();
    h.engine.fireUp(10, null);
    await h.run(2 * MIN);
    h.engine.stop();
    await h.run(10 * SEC);
    expect(h.engine.live().fireUp).toBeNull();
    expect(h.store.openFireUp()).toBeNull();
    expect(h.sim.truth.acs).toBe(false);
  });
});

describe("commands", () => {
  it("validates input and state", async () => {
    const h = cookHarness();
    await h.boot();
    expect(() => h.engine.start(500)).toThrow(CommandError);
    expect(() => h.engine.start(107.5)).toThrow(/whole number/);
    expect(() => h.engine.assignProbe(1, { food: { path: ["Beef", "Nope"] } })).toThrow(/catalog/);
    expect(() => h.engine.assignProbe(1, { food: { custom: "Ham" } })).toThrow(/targetC/);
    expect(() => h.engine.setProbeTarget(1, fToC(250))).toThrow(/targetC/);
    expect(() => h.engine.keepGoing()).toThrow(/keep going/);
    expect(() => h.engine.clearProbe(2)).toThrow(/Nothing on probe 2/);
    h.engine.fireUp(10, null);
    expect(() => h.engine.retarget(PIT_225)).toThrow(/Fire it up/);
  });

  it("retarget with nothing running saves the target for the next Start", async () => {
    const h = cookHarness();
    await h.boot();
    expect(h.engine.retarget(fToDeviceC(275))).toEqual({ id: null, sessionId: null });
    expect(h.engine.live().cook).toMatchObject({ active: false, pitTargetC: fToDeviceC(275) });
  });

  it("retarget during a cook records the change and moves the device", async () => {
    const { h, sessionId } = await cooking("brisket", [[1, BRISKET]]);
    h.engine.retarget(fToDeviceC(250));
    h.engine.setProbeTarget(1, fToC(200));
    await h.run(20 * SEC);
    expect(h.sim.truth.tptC).toBe(fToDeviceC(250));
    expect(h.store.targets(sessionId).map((t) => [t.subject, Math.round(cToF(t.targetC))])).toEqual(
      [
        ["pit", 225],
        ["p1", 203],
        ["pit", 250],
        ["p1", 200],
      ],
    );
    expect(h.ofCook("commandResult").every((e) => e.data.ok)).toBe(true);
  });
});
