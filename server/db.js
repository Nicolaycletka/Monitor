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

CREATE TABLE IF NOT EXISTS telegram_links (
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  linked_at     INTEGER NOT NULL,
  PRIMARY KEY (household_id, chat_id)
);
`);

/*
 * Столбцы уведомлений добавлены после первого релиза — на уже
 * развёрнутой базе их нет, поэтому мигрируем через ALTER TABLE,
 * а не переписываем CREATE TABLE (это бы не подействовало на
 * существующий файл базы).
 */
const householdCols = db.prepare("PRAGMA table_info(households)").all().map((c) => c.name);
const addColumn = (name, def) => {
  if (!householdCols.includes(name)) db.exec(`ALTER TABLE households ADD COLUMN ${name} ${def}`);
};
addColumn("notify_at", "INTEGER");
addColumn("notify_from_label", "TEXT");
addColumn("notify_to_label", "TEXT");
addColumn("notify_sent", "INTEGER NOT NULL DEFAULT 1");

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

/* ---------- уведомления в Telegram ---------- */

export const getNotifyState = db.prepare(
  "SELECT notify_at, notify_sent FROM households WHERE id = ?"
);

export const setNotify = db.prepare(`
  UPDATE households
  SET notify_at = @at, notify_from_label = @from_label, notify_to_label = @to_label, notify_sent = 0
  WHERE id = @id
`);

export const clearNotify = db.prepare(`
  UPDATE households
  SET notify_at = NULL, notify_from_label = NULL, notify_to_label = NULL, notify_sent = 1
  WHERE id = @id
`);

export const markNotifySent = db.prepare("UPDATE households SET notify_sent = 1 WHERE id = ?");

export const dueNotifications = db.prepare(`
  SELECT id, notify_at, notify_from_label, notify_to_label
  FROM households
  WHERE notify_at IS NOT NULL AND notify_sent = 0 AND notify_at <= ?
`);

export const lastSleepEvent = db.prepare(`
  SELECT finish FROM events
  WHERE household_id = ? AND type = 'sleep' AND deleted = 0
  ORDER BY start DESC LIMIT 1
`);

export const linkTelegramChat = db.prepare(`
  INSERT INTO telegram_links (household_id, chat_id, linked_at)
  VALUES (@household_id, @chat_id, @linked_at)
  ON CONFLICT (household_id, chat_id) DO UPDATE SET linked_at = excluded.linked_at
`);

export const telegramChatsFor = db.prepare(
  "SELECT chat_id FROM telegram_links WHERE household_id = ?"
);

export const findHouseholdById = db.prepare("SELECT id, name FROM households WHERE id = ?");
