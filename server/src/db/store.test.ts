import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.ts";
import { migrate, openDb } from "./open.ts";
import { Store } from "./store.ts";

describe("migrations", () => {
  it("migrate an empty database and are idempotent", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual([
      "events",
      "fire_ups",
      "items",
      "push_subscriptions",
      "readings",
      "sessions",
      "settings",
      "target_changes",
    ]);
  });

  it("refuse a database newer than the server", () => {
    const db = openDb(":memory:");
    db.pragma("user_version = 9");
    expect(() => migrate(db)).toThrow(/newer than this server/);
  });
});

describe("store", () => {
  it("round-trips readings, keeping nulls and raw fields", () => {
    const s = new Store(openDb(":memory:"));
    const r = {
      ts: 1000,
      pitC: 107,
      t1C: null,
      t2C: 60,
      t3C: null,
      fanPct: 40,
      cookActive: true,
      targetPitC: 107,
      raw: { rm: "1", time: "1792368000" },
    };
    s.insertReading(r);
    s.insertReading({ ...r, pitC: 1 }); // same ts: ignored
    expect(s.readings(0, 2000)).toEqual([r]);
    expect(s.lastReadingTs()).toBe(1000);
    expect(s.maxProbeC(2, 0, 2000)).toBe(60);
    expect(s.maxProbeC(1, 0, 2000)).toBeNull();
  });

  it("allows one open session and one active item per probe", () => {
    const s = new Store(openDb(":memory:"));
    const a = s.insertSession(1, "user", "");
    expect(() => s.insertSession(2, "user", "")).toThrow(/UNIQUE/);
    s.updateSession(a.id, { endedAt: 5, endedBy: "user" });
    const b = s.insertSession(6, "adopted", "");
    expect(s.openSession()?.id).toBe(b.id);

    const item = s.insertItem({
      sessionId: b.id,
      slot: 1,
      food: { custom: "Ribs" },
      weightLb: null,
      targetC: 90,
      startedAt: 6,
    });
    expect(() =>
      s.insertItem({
        sessionId: b.id,
        slot: 1,
        food: null,
        weightLb: null,
        targetC: 90,
        startedAt: 7,
      }),
    ).toThrow(/UNIQUE/);
    const ended = s.updateItem(item.id, {
      endedAt: 9,
      endReason: "removed",
      cameOffC: 91,
      stats: {
        timeToTargetMs: 2,
        stallStartAt: null,
        stallEndAt: null,
        stallStartC: null,
        stallEndC: null,
        avgPitC: 107.5,
      },
    });
    expect(ended).toMatchObject({ food: { custom: "Ribs" }, endReason: "removed" });
    expect(ended.stats?.avgPitC).toBe(107.5);
    expect(s.activeItems()).toEqual([]);
  });

  it("keeps settings as JSON", () => {
    const s = new Store(openDb(":memory:"));
    expect(s.getSetting("x")).toBeNull();
    s.setSetting("x", { a: [1, 2] });
    s.setSetting("x", { a: [3] });
    expect(s.getSetting("x")).toEqual({ a: [3] });
  });
});
