import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "tracker.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS households (
  id                  TEXT PRIMARY KEY,
  token_hash          TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  birth               INTEGER,
  profile_updated_at  INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  type          TEXT NOT NULL,
  start         INTEGER NOT NULL,
  finish        INTEGER,
  meta          TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  rev           INTEGER NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX IF NOT EXISTS idx_events_rev ON events(household_id, rev);
`);

/* ------------------------------------------------------------------ */

export const findHousehold = db.prepare(
  "SELECT * FROM households WHERE token_hash = ?"
);

export const insertHousehold = db.prepare(`
  INSERT INTO households (id, token_hash, name, birth, profile_updated_at, created_at)
  VALUES (@id, @token_hash, @name, @birth, @profile_updated_at, @created_at)
`);

export const updateProfile = db.prepare(`
  UPDATE households SET name = @name, birth = @birth, profile_updated_at = @updated_at
  WHERE id = @id AND profile_updated_at < @updated_at
`);

export const maxRev = db.prepare(
  "SELECT COALESCE(MAX(rev), 0) AS rev FROM events WHERE household_id = ?"
);

export const eventsSince = db.prepare(
  "SELECT * FROM events WHERE household_id = ? AND rev > ? ORDER BY rev ASC LIMIT 5000"
);

export const getEvent = db.prepare(
  "SELECT updated_at FROM events WHERE household_id = ? AND id = ?"
);

export const upsertEvent = db.prepare(`
  INSERT INTO events (household_id, id, type, start, finish, meta, deleted, updated_at, rev)
  VALUES (@household_id, @id, @type, @start, @finish, @meta, @deleted, @updated_at, @rev)
  ON CONFLICT (household_id, id) DO UPDATE SET
    type       = excluded.type,
    start      = excluded.start,
    finish     = excluded.finish,
    meta       = excluded.meta,
    deleted    = excluded.deleted,
    updated_at = excluded.updated_at,
    rev        = excluded.rev
`);

/** Старые удалённые записи не нужны — чистим раз в сутки. */
export function pruneDeleted() {
  const cutoff = Date.now() - 90 * 86400000;
  db.prepare("DELETE FROM events WHERE deleted = 1 AND updated_at < ?").run(cutoff);
}
