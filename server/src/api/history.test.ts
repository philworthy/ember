// History over the API (M7 done-when, in the simulator): a brisket cook shows up with its graph,
// foods and stats, and trimming it recalculates them.

import {
  type CookDetail,
  cToF,
  fToDeviceC,
  type HistoryEntry,
  type LiveState,
} from "@ember/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.ts";
import { Catalog, SEED_CATALOG } from "../cook/catalog.ts";
import { cookHarness } from "../test/cook.ts";
import { SEC } from "../test/harness.ts";

const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const BRISKET = { path: ["Beef", "Brisket", "Flat"] };
const PIT_225 = fToDeviceC(225);
const catalog = Catalog.fromFile(SEED_CATALOG);
let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

/** A brisket at 225 °F from start until it comes off, ended by the user 20 min later. */
async function brisket() {
  const h = cookHarness({ scenario: "brisket" });
  await h.boot();
  const app = await buildApp({
    engine: h.engine,
    store: h.store,
    catalog,
    clock: h.clock,
    serveClient: false,
  });
  close = () => app.close();
  await h.run(20 * MIN); // readings before the cook, which a trim can reach back into
  h.engine.assignProbe(1, { food: BRISKET, weightLb: 6.5 });
  const id = h.engine.start(PIT_225).sessionId as number;
  await h.runUntil(() => h.ofCook("itemCameOff").length > 0, 16 * HOUR);
  await h.run(20 * MIN);
  h.engine.end();
  await h.run(30 * MIN);
  const get = async () => (await app.inject(`/api/sessions/${id}`)).json() as CookDetail;
  const patch = (payload: object) =>
    app.inject({ method: "PATCH", url: `/api/sessions/${id}`, payload });
  return { h, app, id, get, patch };
}

describe("History", () => {
  it("lists a cook, shows it, trims it and puts it back", async () => {
    const { app, id, get, patch } = await brisket();

    const list = (await app.inject("/api/sessions")).json() as HistoryEntry[];
    expect(list).toHaveLength(1);
    const entry = list[0] as HistoryEntry;
    expect(entry).toMatchObject({ id, title: "Brisket", pitTargetC: PIT_225 });
    expect(entry.foods).toEqual([{ slot: 1, food: BRISKET, weightLb: 6.5 }]);
    expect(entry.spark.length).toBeGreaterThan(50);
    expect(entry.spark.length).toBeLessThanOrEqual(81);
    expect(entry.spark.every((p) => p.pitC !== null && p.t2C === null)).toBe(true);

    const before = await get();
    const s = before.session;
    const item = before.items[0];
    if (!item?.stats || s.endedAt === null) throw new Error("no ended item");
    expect(item.inWindow).toBe(true);
    expect(item.stats.stallStartAt).not.toBeNull();
    expect(item.stats.timeToTargetMs).not.toBeNull();
    expect(before.recorded).toEqual({ startedAt: s.startedAt, endedAt: s.endedAt });
    // Bounds reach the readings before the cook and after it, not beyond them.
    expect(s.startedAt - before.bounds.from).toBeGreaterThan(15 * MIN);
    expect(s.startedAt - before.bounds.from).toBeLessThanOrEqual(20 * MIN);
    expect(before.bounds.to - s.endedAt).toBeGreaterThan(25 * MIN);
    expect(before.bounds.to - s.endedAt).toBeLessThanOrEqual(30 * MIN);
    expect(cToF(before.pit.avgC ?? 0)).toBeCloseTo(225, -1);
    expect(before.pit.heldWithinC).not.toBeNull();

    // Trim the start into the stall: the stats are recalculated.
    const into = (item.stats.stallStartAt as number) + 15 * MIN;
    const res = await patch({ startedAt: into });
    expect(res.statusCode).toBe(200);
    const trimmed = res.json() as CookDetail;
    const t = trimmed.items[0];
    expect(trimmed.session.startedAt).toBe(into);
    expect(t?.startedAt).toBe(into);
    expect(t?.stats?.timeToTargetMs).toBe((item.reachedTargetAt as number) - into);
    expect(t?.stats?.stallStartAt).not.toBe(item.stats.stallStartAt);
    expect(t?.stats?.avgPitC).not.toBe(item.stats.avgPitC);
    expect(trimmed.recorded).toEqual(before.recorded);
    expect((await get()).items[0]?.stats).toEqual(t?.stats);

    // Back to the recorded window: exactly the original.
    const back = (await patch({ startedAt: s.startedAt, endedAt: s.endedAt })).json() as CookDetail;
    expect(back.session).toEqual(before.session);
    expect(back.items).toEqual(before.items);
  });

  it("refuses a trim outside the readings or too short", async () => {
    const { h, id, get, patch } = await brisket();
    const { bounds, session } = await get();
    expect((await patch({ startedAt: bounds.from - MIN })).statusCode).toBe(400);
    expect((await patch({ endedAt: bounds.to + MIN })).statusCode).toBe(400);
    expect((await patch({ endedAt: session.startedAt + 10 * MIN })).statusCode).toBe(400);

    h.engine.start(PIT_225);
    const open = h.store.openSession()?.id as number;
    expect(open).not.toBe(id);
    // A past cook can still be edited while another is running.
    expect((await patch({ notes: "fine" })).statusCode).toBe(200);
  });

  it("edits notes and the title, and a null title goes back to the generated one", async () => {
    const { get, patch } = await brisket();
    await patch({ notes: "Post oak, wrapped at 165." });
    await patch({ title: "Sunday brisket" });
    expect((await get()).session).toMatchObject({
      notes: "Post oak, wrapped at 165.",
      title: "Sunday brisket",
      titleCustom: true,
    });
    await patch({ title: null });
    expect((await get()).session).toMatchObject({ title: "Brisket", titleCustom: false });
  });

  it("Cook this again sets up the next start, but not during a cook", async () => {
    const { h, app, id } = await brisket();
    const again = () => app.inject({ method: "POST", url: `/api/sessions/${id}/cook-again` });
    h.engine.setProbeTarget(2, 80);
    expect((await again()).statusCode).toBe(202);
    const live = (await app.inject("/api/state")).json() as LiveState;
    expect(live.cook.pitTargetC).toBe(PIT_225);
    expect(live.probes.map((p) => p.setup)).toEqual([
      { food: BRISKET, weightLb: 6.5, targetC: 95 },
      null,
      null,
    ]);

    h.engine.start(PIT_225);
    expect((await again()).statusCode).toBe(409);
    const open = h.store.openSession()?.id as number;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${open}`,
      payload: { notes: "x" },
    });
    expect(res.statusCode).toBe(409);
  });
});
