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

/*
 * Очередь уведомлений. Заменяет колонки notify_* в households:
 * видов напоминаний стало больше одного (сон, кормление), и на
 * каждый новый вид пришлось бы добавлять четыре колонки и ветку
 * в планировщике. Текст готовит клиент — там же, где считается
 * прогноз, — поэтому новый вид уведомления не требует правок
 * на сервере вообще.
 *
 * Старые колонки notify_* намеренно не удаляются: SQLite умеет
 * DROP COLUMN не везде, а пустые колонки никому не мешают.
 */
CREATE TABLE IF NOT EXISTS notifications (
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  at            INTEGER NOT NULL,
  text          TEXT NOT NULL,
  sent          INTEGER NOT NULL DEFAULT 0,
  -- на какой момент дневника рассчитано уведомление: если после него
  -- появилась или изменилась запись того типа, что лежит в основе
  -- расчёта, отправлять нельзя — прогноз устарел
  guard_type    TEXT,
  guard_after   INTEGER,
  PRIMARY KEY (household_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_notif_due ON notifications(sent, at);

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
// пол ребёнка ("m" | "f") — нужен для кривых веса ВОЗ, они разные
addColumn("sex", "TEXT");
/*
 * Отключённые виды уведомлений — список через запятую ("feed,sleep").
 * Хранится именно ОТКЛЮЧЁННОЕ, а не включённое: тогда вид, добавленный
 * в будущей версии, у существующих семей заработает сам, а не окажется
 * молча выключенным.
 */
addColumn("notify_off", "TEXT");
// ПДР — нужна для точного расчёта скачков развития у недоношенных;
// без неё используется дата рождения (см. web/src/milestones.js)
addColumn("due_at", "INTEGER");

// таблица notifications могла быть создана до появления охранных полей
for (const [c, t] of [
  ["guard_type", "TEXT"], ["guard_after", "INTEGER"],
  // снимок ПДР/даты рождения на момент расчёта — для вида "dev":
  // если родитель поправит ПДР, уже посчитанный по старой дате пуш
  // не должен уйти. Отдельный механизм от guard_type/guard_after:
  // тот сверяется с таблицей событий, а тут сверяется с профилем.
  ["guard_due_at", "INTEGER"], ["guard_birth_at", "INTEGER"],
]) {
  const has = db.prepare("PRAGMA table_info(notifications)").all().some((x) => x.name === c);
  if (!has) db.exec(`ALTER TABLE notifications ADD COLUMN ${c} ${t}`);
}

/* ------------------------------------------------------------------ */

export const findHousehold = db.prepare(
  "SELECT * FROM households WHERE token_hash = ?"
);

export const insertHousehold = db.prepare(`
  INSERT INTO households (id, token_hash, name, birth, sex, profile_updated_at, created_at)
  VALUES (@id, @token_hash, @name, @birth, @sex, @profile_updated_at, @created_at)
`);

/*
 * sex пишется через COALESCE намеренно: телефон со старой версией
 * приложения профиль присылает, а поля sex в нём нет. Прямое
 * присваивание обнулило бы уже выбранный пол при первой же
 * синхронизации со старого телефона — и кривые веса на новом
 * телефоне молча исчезли бы.
 */
export const updateProfile = db.prepare(`
  UPDATE households
  SET name = @name, birth = @birth, sex = COALESCE(@sex, sex),
      notify_off = COALESCE(@notify_off, notify_off),
      due_at = @due_at,
      profile_updated_at = @updated_at
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

export const getNotification = db.prepare(
  "SELECT at, sent FROM notifications WHERE household_id = ? AND kind = ?"
);

export const setNotification = db.prepare(`
  INSERT INTO notifications
    (household_id, kind, at, text, sent, guard_type, guard_after, guard_due_at, guard_birth_at)
  VALUES (@id, @kind, @at, @text, 0, @guard_type, @guard_after, @guard_due_at, @guard_birth_at)
  ON CONFLICT (household_id, kind) DO UPDATE SET
    at = excluded.at, text = excluded.text, sent = 0,
    guard_type = excluded.guard_type, guard_after = excluded.guard_after,
    guard_due_at = excluded.guard_due_at, guard_birth_at = excluded.guard_birth_at
`);

export const clearNotification = db.prepare(
  "DELETE FROM notifications WHERE household_id = ? AND kind = ?"
);

export const markNotificationSent = db.prepare(
  "UPDATE notifications SET sent = 1 WHERE household_id = ? AND kind = ?"
);

/*
 * Отключённые виды отсекаются прямо в запросе: если родитель выключил
 * напоминания о кормлении, накопившаяся очередь не должна выстрелить
 * при обратном включении. Строка вида "feed,sleep" ищется с запятыми
 * по краям, иначе "feed" совпал бы с "feeding".
 */
export const dueNotifications = db.prepare(`
  SELECT n.household_id AS id, n.kind, n.at, n.text, n.guard_type, n.guard_after
  FROM notifications n
  JOIN households h ON h.id = n.household_id
  WHERE n.sent = 0 AND n.at <= ?
    AND (h.notify_off IS NULL
         OR INSTR(',' || h.notify_off || ',', ',' || n.kind || ',') = 0)
`);

/*
 * Появилась ли запись нужного типа новее, чем момент расчёта.
 * Считает и НОВЫЕ записи, и правки старых: у правки тоже растёт
 * updated_at, а исправленное задним числом кормление меняет прогноз
 * ровно так же, как только что случившееся.
 */
/** Текущие birth/due_at семьи — снимок для сверки перед отправкой "dev". */
export const householdDates = db.prepare(
  "SELECT birth, due_at FROM households WHERE id = ?"
);

export const newerEventSince = db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE household_id = ? AND type = ? AND deleted = 0 AND updated_at > ?
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
