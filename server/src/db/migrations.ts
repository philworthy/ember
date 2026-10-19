// Schema migrations, applied in order and tracked with PRAGMA user_version. Never edit a
// migration that has shipped; add a new one.

export const MIGRATIONS: string[] = [
  // 1: M3 — readings, sessions, items, targets, Fire it up, push, settings, events
  `
  -- The permanent record: one row per kept poll, raw device °C, null = no probe.
  CREATE TABLE readings (
    ts INTEGER PRIMARY KEY,           -- server receive time, Unix ms
    pit_c INTEGER,
    t1_c INTEGER,
    t2_c INTEGER,
    t3_c INTEGER,
    fan_pct INTEGER NOT NULL,
    cook_active INTEGER NOT NULL,
    target_pit_c INTEGER NOT NULL,
    raw TEXT NOT NULL                 -- unparsed fields as JSON
  );

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT CHECK (ended_by IN ('user', 'auto', 'timeout')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'fireUp', 'adopted', 'foreign')),
    title TEXT NOT NULL DEFAULT '',
    title_custom INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    looks_done_at INTEGER,
    keep_going_at INTEGER
  );
  -- At most one open session.
  CREATE UNIQUE INDEX sessions_one_open ON sessions ((1)) WHERE ended_at IS NULL;
  CREATE INDEX sessions_started ON sessions (started_at);

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
    food TEXT,                        -- JSON {path} or {custom}; null = "Probe N"
    weight_lb REAL,
    target_c REAL NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT CHECK (end_reason IN ('removed', 'unplugged', 'session_end', 'user')),
    came_off_c REAL,
    reached_target_at INTEGER,
    time_to_target_ms INTEGER,
    stall_start_at INTEGER,
    stall_end_at INTEGER,
    stall_start_c REAL,
    stall_end_c REAL,
    avg_pit_c REAL
  );
  CREATE INDEX items_session ON items (session_id);
  -- At most one active item per probe.
  CREATE UNIQUE INDEX items_one_active ON items (slot) WHERE ended_at IS NULL;

  CREATE TABLE target_changes (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    item_id INTEGER REFERENCES items (id),
    ts INTEGER NOT NULL,
    subject TEXT NOT NULL CHECK (subject IN ('pit', 'p1', 'p2', 'p3')),
    target_c REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'adopted', 'foreign', 'fireUp'))
  );
  CREATE INDEX target_changes_session ON target_changes (session_id, ts);

  CREATE TABLE fire_ups (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES sessions (id),
    started_at INTEGER NOT NULL,
    minutes REAL NOT NULL,
    then_hold_c INTEGER,
    ended_at INTEGER,
    outcome TEXT CHECK (outcome IN ('hold', 'stop', 'stopped'))
  );

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL,               -- JSON {p256dh, auth}
    created_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL               -- JSON
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    session_id INTEGER REFERENCES sessions (id),
    type TEXT NOT NULL,
    data TEXT NOT NULL                -- JSON
  );
  CREATE INDEX events_session ON events (session_id, ts);
  CREATE INDEX events_ts ON events (ts);
  `,
  // 2: M6 — the outcome of the last push to each subscription
  `
  ALTER TABLE push_subscriptions ADD COLUMN user_agent TEXT;
  ALTER TABLE push_subscriptions ADD COLUMN last_ok_at INTEGER;
  ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;
  `,
];
