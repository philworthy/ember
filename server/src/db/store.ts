// Typed queries over the schema in migrations.ts. Synchronous (better-sqlite3), so the cook
// engine can update state inside a device event handler without interleaving.

import type {
  CookEvent,
  CookEventType,
  EndedBy,
  FireUp,
  FireUpOutcome,
  Food,
  Item,
  ItemEndReason,
  ItemStats,
  ProbeSlot,
  Reading,
  RecentFood,
  Session,
  SessionOrigin,
  TargetChange,
  TargetSource,
  TargetSubject,
} from "@ember/shared";
import type { Db } from "./open.ts";

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toSession(r: Row): Session {
  return {
    id: Number(r.id),
    startedAt: Number(r.started_at),
    endedAt: num(r.ended_at),
    endedBy: (r.ended_by as EndedBy | null) ?? null,
    origin: r.origin as SessionOrigin,
    title: String(r.title),
    titleCustom: Boolean(r.title_custom),
    notes: String(r.notes),
    looksDoneAt: num(r.looks_done_at),
    keepGoingAt: num(r.keep_going_at),
  };
}

function toItem(r: Row): Item {
  const ended = r.ended_at !== null;
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    slot: Number(r.slot) as ProbeSlot,
    food: r.food === null ? null : (JSON.parse(String(r.food)) as Food),
    weightLb: num(r.weight_lb),
    targetC: Number(r.target_c),
    startedAt: Number(r.started_at),
    endedAt: num(r.ended_at),
    endReason: (r.end_reason as ItemEndReason | null) ?? null,
    cameOffC: num(r.came_off_c),
    reachedTargetAt: num(r.reached_target_at),
    stats: ended
      ? {
          timeToTargetMs: num(r.time_to_target_ms),
          stallStartAt: num(r.stall_start_at),
          stallEndAt: num(r.stall_end_at),
          stallStartC: num(r.stall_start_c),
          stallEndC: num(r.stall_end_c),
          avgPitC: num(r.avg_pit_c),
        }
      : null,
  };
}

function toTarget(r: Row): TargetChange {
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    itemId: num(r.item_id),
    ts: Number(r.ts),
    subject: r.subject as TargetSubject,
    targetC: Number(r.target_c),
    source: r.source as TargetSource,
  };
}

function toFireUp(r: Row): FireUp {
  return {
    id: Number(r.id),
    sessionId: num(r.session_id),
    startedAt: Number(r.started_at),
    minutes: Number(r.minutes),
    thenHoldC: num(r.then_hold_c),
    endedAt: num(r.ended_at),
    outcome: (r.outcome as FireUpOutcome | null) ?? null,
  };
}

function toEvent(r: Row): CookEvent {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    sessionId: num(r.session_id),
    type: r.type as CookEventType,
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
  };
}

function toReading(r: Row): Reading {
  return {
    ts: Number(r.ts),
    pitC: num(r.pit_c),
    t1C: num(r.t1_c),
    t2C: num(r.t2_c),
    t3C: num(r.t3_c),
    fanPct: Number(r.fan_pct),
    cookActive: Boolean(r.cook_active),
    targetPitC: Number(r.target_pit_c),
    raw: JSON.parse(String(r.raw)) as Record<string, string>,
  };
}

export interface PushSubscriptionRow {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
  lastOkAt?: number | null;
  lastError?: string | null;
}

function toPushSub(r: Row): PushSubscriptionRow {
  return {
    endpoint: String(r.endpoint),
    keys: JSON.parse(String(r.keys)) as PushSubscriptionRow["keys"],
    userAgent: (r.user_agent as string | null) ?? null,
    lastOkAt: num(r.last_ok_at),
    lastError: (r.last_error as string | null) ?? null,
  };
}

const SLOT_COLUMN = { 1: "t1_c", 2: "t2_c", 3: "t3_c" } as const;

export class Store {
  private readonly q;

  constructor(readonly db: Db) {
    const p = (sql: string) => db.prepare(sql);
    this.q = {
      insertReading: p(
        `INSERT OR IGNORE INTO readings (ts, pit_c, t1_c, t2_c, t3_c, fan_pct, cook_active, target_pit_c, raw)
         VALUES (@ts, @pitC, @t1C, @t2C, @t3C, @fanPct, @cookActive, @targetPitC, @raw)`,
      ),
      lastReadingTs: p("SELECT max(ts) AS ts FROM readings"),
      readings: p("SELECT * FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts"),
      getSetting: p("SELECT value FROM settings WHERE key = ?"),
      setSetting: p(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ),
      openSession: p("SELECT * FROM sessions WHERE ended_at IS NULL"),
      session: p("SELECT * FROM sessions WHERE id = ?"),
      sessions: p("SELECT * FROM sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?"),
      insertSession: p(
        "INSERT INTO sessions (started_at, origin, title) VALUES (?, ?, ?) RETURNING *",
      ),
      item: p("SELECT * FROM items WHERE id = ?"),
      activeItems: p("SELECT * FROM items WHERE ended_at IS NULL ORDER BY slot"),
      sessionItems: p("SELECT * FROM items WHERE session_id = ? ORDER BY started_at, id"),
      lastItem: p(
        "SELECT * FROM items WHERE session_id = ? AND slot = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      ),
      recentFoodItems: p(
        "SELECT * FROM items WHERE food IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 200",
      ),
      insertItem: p(
        `INSERT INTO items (session_id, slot, food, weight_lb, target_c, started_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      ),
      insertTarget: p(
        `INSERT INTO target_changes (session_id, item_id, ts, subject, target_c, source)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      ),
      targets: p("SELECT * FROM target_changes WHERE session_id = ? ORDER BY ts, id"),
      lastPitTarget: p(
        "SELECT * FROM target_changes WHERE session_id = ? AND subject = 'pit' ORDER BY ts DESC, id DESC LIMIT 1",
      ),
      insertFireUp: p(
        `INSERT INTO fire_ups (session_id, started_at, minutes, then_hold_c) VALUES (?, ?, ?, ?)
         RETURNING *`,
      ),
      openFireUp: p("SELECT * FROM fire_ups WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1"),
      closeFireUp: p("UPDATE fire_ups SET ended_at = ?, outcome = ? WHERE id = ?"),
      sessionFireUps: p("SELECT * FROM fire_ups WHERE session_id = ? ORDER BY started_at"),
      insertEvent: p(
        "INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?) RETURNING *",
      ),
      sessionEvents: p("SELECT * FROM events WHERE session_id = ? ORDER BY ts, id"),
      upsertPush: p(
        `INSERT INTO push_subscriptions (endpoint, keys, created_at, user_agent) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys, user_agent = excluded.user_agent`,
      ),
      deletePush: p("DELETE FROM push_subscriptions WHERE endpoint = ?"),
      pushSubs: p("SELECT * FROM push_subscriptions ORDER BY id"),
      pushSub: p("SELECT * FROM push_subscriptions WHERE endpoint = ?"),
      markPushOk: p(
        "UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE endpoint = ?",
      ),
      markPushError: p("UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?"),
    };
  }

  // ---- Readings ----

  insertReading(r: Reading): void {
    this.q.insertReading.run({
      ...r,
      cookActive: r.cookActive ? 1 : 0,
      raw: JSON.stringify(r.raw),
    });
  }

  lastReadingTs(): number | null {
    return num((this.q.lastReadingTs.get() as Row).ts);
  }

  readings(from: number, to: number): Reading[] {
    return (this.q.readings.all(from, to) as Row[]).map(toReading);
  }

  /** Highest temperature a probe read in a window (for an item's "passed 140 °F"). */
  maxProbeC(slot: ProbeSlot, from: number, to: number): number | null {
    const col = SLOT_COLUMN[slot];
    const row = this.db
      .prepare(`SELECT max(${col}) AS m FROM readings WHERE ts >= ? AND ts <= ?`)
      .get(from, to) as Row;
    return num(row.m);
  }

  // ---- Settings (JSON values) ----

  getSetting<T>(key: string): T | null {
    const row = this.q.getSetting.get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.q.setSetting.run(key, JSON.stringify(value));
  }

  // ---- Sessions ----

  openSession(): Session | null {
    const row = this.q.openSession.get() as Row | undefined;
    return row ? toSession(row) : null;
  }

  session(id: number): Session | null {
    const row = this.q.session.get(id) as Row | undefined;
    return row ? toSession(row) : null;
  }

  /** Newest first, started before `before`. */
  sessions(limit = 50, before = Number.MAX_SAFE_INTEGER): Session[] {
    return (this.q.sessions.all(before, limit) as Row[]).map(toSession);
  }

  insertSession(startedAt: number, origin: SessionOrigin, title: string): Session {
    return toSession(this.q.insertSession.get(startedAt, origin, title) as Row);
  }

  updateSession(
    id: number,
    patch: Partial<
      Pick<
        Session,
        "endedAt" | "endedBy" | "title" | "titleCustom" | "notes" | "looksDoneAt" | "keepGoingAt"
      >
    >,
  ): Session {
    const cols: Record<string, unknown> = {
      ended_at: patch.endedAt,
      ended_by: patch.endedBy,
      title: patch.title,
      title_custom: patch.titleCustom === undefined ? undefined : patch.titleCustom ? 1 : 0,
      notes: patch.notes,
      looks_done_at: patch.looksDoneAt,
      keep_going_at: patch.keepGoingAt,
    };
    this.update("sessions", id, cols);
    return this.session(id) as Session;
  }

  // ---- Items ----

  item(id: number): Item | null {
    const row = this.q.item.get(id) as Row | undefined;
    return row ? toItem(row) : null;
  }

  activeItems(): Item[] {
    return (this.q.activeItems.all() as Row[]).map(toItem);
  }

  sessionItems(sessionId: number): Item[] {
    return (this.q.sessionItems.all(sessionId) as Row[]).map(toItem);
  }

  lastItem(sessionId: number, slot: ProbeSlot): Item | null {
    const row = this.q.lastItem.get(sessionId, slot) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** The last `limit` distinct foods put on probes, newest first, with their latest weight. */
  recentFoods(limit = 6): RecentFood[] {
    const out = new Map<string, RecentFood>();
    for (const item of (this.q.recentFoodItems.all() as Row[]).map(toItem)) {
      if (!item.food) continue;
      const key = JSON.stringify(item.food);
      const seen = out.get(key);
      if (seen) {
        seen.weightLb ??= item.weightLb;
      } else if (out.size < limit) {
        out.set(key, {
          food: item.food,
          weightLb: item.weightLb,
          targetC: item.targetC,
          at: item.startedAt,
        });
      }
    }
    return [...out.values()];
  }

  insertItem(i: {
    sessionId: number;
    slot: ProbeSlot;
    food: Food | null;
    weightLb: number | null;
    targetC: number;
    startedAt: number;
  }): Item {
    const food = i.food === null ? null : JSON.stringify(i.food);
    return toItem(
      this.q.insertItem.get(i.sessionId, i.slot, food, i.weightLb, i.targetC, i.startedAt) as Row,
    );
  }

  updateItem(
    id: number,
    patch: Partial<
      Pick<
        Item,
        "food" | "weightLb" | "targetC" | "endedAt" | "endReason" | "cameOffC" | "reachedTargetAt"
      >
    > & { stats?: ItemStats },
  ): Item {
    const s = patch.stats;
    this.update("items", id, {
      food: patch.food === undefined ? undefined : patch.food && JSON.stringify(patch.food),
      weight_lb: patch.weightLb,
      target_c: patch.targetC,
      ended_at: patch.endedAt,
      end_reason: patch.endReason,
      came_off_c: patch.cameOffC,
      reached_target_at: patch.reachedTargetAt,
      time_to_target_ms: s?.timeToTargetMs,
      stall_start_at: s?.stallStartAt,
      stall_end_at: s?.stallEndAt,
      stall_start_c: s?.stallStartC,
      stall_end_c: s?.stallEndC,
      avg_pit_c: s?.avgPitC,
    });
    return this.item(id) as Item;
  }

  // ---- Targets ----

  insertTarget(t: Omit<TargetChange, "id">): TargetChange {
    return toTarget(
      this.q.insertTarget.get(t.sessionId, t.itemId, t.ts, t.subject, t.targetC, t.source) as Row,
    );
  }

  targets(sessionId: number): TargetChange[] {
    return (this.q.targets.all(sessionId) as Row[]).map(toTarget);
  }

  lastPitTarget(sessionId: number): TargetChange | null {
    const row = this.q.lastPitTarget.get(sessionId) as Row | undefined;
    return row ? toTarget(row) : null;
  }

  // ---- Fire it up ----

  insertFireUp(f: {
    sessionId: number | null;
    startedAt: number;
    minutes: number;
    thenHoldC: number | null;
  }): FireUp {
    return toFireUp(
      this.q.insertFireUp.get(f.sessionId, f.startedAt, f.minutes, f.thenHoldC) as Row,
    );
  }

  openFireUp(): FireUp | null {
    const row = this.q.openFireUp.get() as Row | undefined;
    return row ? toFireUp(row) : null;
  }

  closeFireUp(id: number, endedAt: number, outcome: FireUpOutcome): void {
    this.q.closeFireUp.run(endedAt, outcome, id);
  }

  sessionFireUps(sessionId: number): FireUp[] {
    return (this.q.sessionFireUps.all(sessionId) as Row[]).map(toFireUp);
  }

  // ---- Events ----

  insertEvent(e: Omit<CookEvent, "id">): CookEvent {
    return toEvent(
      this.q.insertEvent.get(e.ts, e.sessionId, e.type, JSON.stringify(e.data)) as Row,
    );
  }

  sessionEvents(sessionId: number): CookEvent[] {
    return (this.q.sessionEvents.all(sessionId) as Row[]).map(toEvent);
  }

  // ---- Push subscriptions ----

  /** Add a subscription, or refresh its keys (the app re-sends it every time it opens). */
  upsertPushSubscription(s: PushSubscriptionRow, at: number): void {
    this.q.upsertPush.run(s.endpoint, JSON.stringify(s.keys), at, s.userAgent ?? null);
  }

  deletePushSubscription(endpoint: string): boolean {
    return this.q.deletePush.run(endpoint).changes > 0;
  }

  pushSubscriptions(): PushSubscriptionRow[] {
    return (this.q.pushSubs.all() as Row[]).map(toPushSub);
  }

  pushSubscription(endpoint: string): PushSubscriptionRow | null {
    const row = this.q.pushSub.get(endpoint) as Row | undefined;
    return row ? toPushSub(row) : null;
  }

  markPush(endpoint: string, at: number, error: string | null): void {
    if (error === null) this.q.markPushOk.run(at, endpoint);
    else this.q.markPushError.run(error, endpoint);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** UPDATE the given columns; undefined values are left alone. */
  private update(table: "sessions" | "items", id: number, cols: Record<string, unknown>): void {
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!set.length) return;
    const sql = `UPDATE ${table} SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...set.map(([, v]) => v as never), id);
  }
}
