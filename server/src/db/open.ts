// Opens the SQLite database (a file in DATA_DIR, or :memory: in tests) and migrates it.

import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.ts";

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Apply any migrations past the database's user_version, each in its own transaction. */
export function migrate(db: Db, migrations: string[] = MIGRATIONS): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(
      `database is at schema ${current}, newer than this server (${migrations.length})`,
    );
  }
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return migrations.length;
}
