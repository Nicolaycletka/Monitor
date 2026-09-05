/**
 * Локальное хранилище (IndexedDB) + синхронизация с сервером.
 *
 * Принцип: local-first. Всё пишется в IndexedDB сразу и работает офлайн.
 * Синхронизация — фоновая, отдельным циклом. Слияние по правилу
 * "последняя запись побеждает" на основе updatedAt.
 */

import { predictNext, hhmm, durShort } from "./sleep.js";
import { feedNotify } from "./feed.js";
import { nextMilestone } from "./milestones.js";

const DB_NAME = "baby-tracker";
const STORE = "kv";
const KEY = "state";

let dbPromise = null;

function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */

/**
 * Версия локального состояния. Поднимается, когда меняется СМЫСЛ уже
 * сохранённых полей, а не только их набор — тогда старое значение надо
 * не дополнить, а обезвредить.
 *
 * 2: bias сменил смысл. Раньше кнопка «Применить измеренную поправку»
 *    записывала туда ВСЮ поправку целиком (скажем, 36 минут). Теперь
 *    приложение считает поправку само, а bias — ручная добавка ПОВЕРХ
 *    неё. Старое значение стало бы вторым слагаемым того же самого:
 *    удвоение, о котором никто бы не догадался. Плюс шагом ±5 из 36
 *    в ноль не попасть, то есть руками это было не убрать.
 */
export const STATE_VERSION = 2;

/** Ручная добавка ограничена: она идёт мимо всего демпфирования. */
export const MANUAL_BIAS_LIMIT = 30;

export const emptyState = {
  profile: null,      // { name, birth, updatedAt }
  events: [],         // { id, type, start, end, meta, deleted, updatedAt, dirty }
  auth: null,         // { token, householdId }
  rev: 0,             // курсор сервера
  bias: 0,            // ручная добавка к поправке, минуты
  schema: STATE_VERSION,
  feedsPerDay: null,  // ручное число кормлений в сутки; null — считать самим
  pumpMl: null,       // сцеживание одной груди утром, мл; null — считать по бюджету/числу кормлений
  dueAt: null,        // ПДР — для точности скачков развития у недоношенных; null — считать от даты рождения
  biasResetFrom: null, // сколько сняли при миграции — показать один раз
  profileDirty: false,
};

/** Разовые правки при загрузке состояния, сохранённого старой версией. */
export function migrate(saved) {
  const st = { ...emptyState, ...saved };
  if ((saved.schema || 1) < 2) {
    // старый bias нёс всю поправку и теперь удваивал бы её
    st.biasResetFrom = saved.bias || null;
    st.bias = 0;
  }
  st.bias = Math.min(Math.max(st.bias || 0, -MANUAL_BIAS_LIMIT), MANUAL_BIAS_LIMIT);
  st.schema = STATE_VERSION;
  return st;
}

export async function loadState() {
  try {
    const saved = await idbGet(KEY);
    if (saved) return migrate(saved);
  } catch (e) {
    console.warn("IndexedDB недоступна, работаем в памяти", e);
  }
  return { ...emptyState };
}

export async function saveState(state) {
  try {
    await idbSet(KEY, state);
    return true;
  } catch (e) {
    console.warn("не удалось сохранить", e);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Сеть                                                               */
/* ------------------------------------------------------------------ */

/** База приложения: "/" в корне, "/monitor/" в подкаталоге. */
export const API = `${import.meta.env.BASE_URL}api`;

export async function createHousehold(name, birth, sex = null) {
  const res = await fetch(`${API}/household`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, birth, sex }),
  });
  if (!res.ok) throw new Error("не удалось создать профиль на сервере");
  return res.json();
}

/**
 * Перепривязка к серверу: заводит новую семью с текущим профилем
 * и помечает все локальные записи неотправленными, чтобы они уехали
 * заново. Нужна, если база на сервере пересоздалась и старый токен
 * больше не действует — данные на телефоне при этом целы.
 */
export async function relink(state) {
  if (!state.profile) throw new Error("нет профиля");
  const { token, householdId } = await createHousehold(
    state.profile.name,
    state.profile.birth,
    state.profile.sex || null
  );
  return {
    ...state,
    auth: { token, householdId },
    rev: 0,
    profileDirty: true,
    events: state.events.map((e) => ({ ...e, dirty: true })),
  };
}

/**
 * Расписание уведомлений для Telegram. Считается здесь же, где и для
 * интерфейса, — сервер прогноз не пересчитывает, только хранит время
 * и готовый текст и шлёт его по расписанию.
 *
 * Значение по каждому виду: объект — поставить, null — снять явно
 * (например, ребёнок уснул). Возврат null целиком означает «считать
 * не из чего», и тогда сервер ничего не трогает.
 */

/** Насколько близко два напоминания считаются одним шумом. */
const NOTIFY_MERGE_MIN = 20;

/*
 * Время напоминания округляется до минуты.
 *
 * Прогноз зависит от возраста в месяцах, то есть от текущего момента
 * непрерывно: между двумя синхронизациями расчётное время уезжает на
 * секунды. Сервер видел «другое» время, перевзводил уведомление со
 * снятым флагом отправки, и сообщение уходило второй раз — с теми же
 * границами окна. Секунды в напоминании всё равно ничего не значат.
 */
const toMinute = (ts) => Math.round(ts / 60000) * 60000;

/** Границы, в которые сдвигается пуш о вехе развития, часы местного времени. */
const DEV_PUSH_FROM = 9;
const DEV_PUSH_TO = 22;

/*
 * Момент вехи — чистая арифметика от даты рождения (или ПДР), и время
 * суток у него какое угодно. У скачков оно вообще всегда равно времени
 * суток самой точки отсчёта: если ПДР записана как дата без времени,
 * ВСЕ скачки приходятся ровно на полночь.
 *
 * Календарной заметке безразлично, придёт она в 00:00 или в 09:00,
 * а родителю — нет. Поэтому пуш сдвигается в дневные часы. Сдвиг
 * детерминирован (функция только от `at`), иначе сервер видел бы новое
 * время на каждом синке и перевзводил очередь.
 *
 * Пропущенную веху (подхват в пределах CATCH_UP_MS) не сдвигаем: она
 * уже опоздала, шлём при первой возможности.
 */
function devPushTime(at, now = Date.now()) {
  if (at <= now) return at;
  const d = new Date(at);
  const h = d.getHours();
  if (h >= DEV_PUSH_FROM && h < DEV_PUSH_TO) return at;
  if (h >= DEV_PUSH_TO) d.setDate(d.getDate() + 1);
  d.setHours(DEV_PUSH_FROM, 0, 0, 0);
  return d.getTime();
}

function computeNotify(state) {
  if (!state.profile?.birth) return null;
  const events = liveEvents(state.events || []);
  const { birth, sex, name } = state.profile;
  const active = events.find((e) => e.type === "sleep" && !e.end);

  /*
   * Вехи развития — календарь, а не прогноз: спящий ребёнок ничему не
   * мешает, окно кормления рядом тоже не имеет значения, слияние
   * с другими видами не нужно. Единственная защита — снимок дат,
   * который сверяется на сервере перед отправкой (см. server/index.js).
   *
   * Считается ДО ветки спящего ребёнка. Раньше эта ветка возвращала
   * объект без ключа `dev` вовсе, сервер такой ключ не трогал — и пока
   * ребёнок спит, веха не могла даже встать в очередь. Вместе с тем,
   * что синк во сне — самый частый (родитель как раз открывает дневник,
   * чтобы отметить сон), окно постановки сжималось почти в ноль.
   */
  const dev = nextMilestone(birth, state.profile?.dueAt ?? null, Date.now());
  const devN = dev && {
    at: devPushTime(dev.at, Date.now()),
    text: `🌱 ${dev.text}`,
    guardDueAt: state.profile?.dueAt ?? null,
    guardBirthAt: birth,
  };

  // ребёнок спит — оба напоминания снимаются: и укладывать уже не надо,
  // и будить кормлением тем более
  if (active) return { sleep: null, feed: null, dev: devN };

  let sleepN = null;
  const win = predictNext(events, birth, Date.now(), state.bias || 0);
  if (win && !win.stale) {
    sleepN = {
      at: toMinute(win.calm),
      // на что опирался расчёт: появится новая или исправленная запись
      // сна — сервер отменит отправку сам, даже если телефон выключен
      guardType: "sleep",
      guardAfter: Date.now(),
      text: `🌙 Пора успокаиваться — окно сна ${hhmm(win.from)}–${hhmm(win.to)}`,
    };
  }

  let feedN = null;
  const f = feedNotify(events, birth, sex || null, Date.now(), state.feedsPerDay ?? null, state.pumpMl ?? null);
  if (f) {
    const who = name ? `${name} ` : "";
    const был = sex === "f" ? "ела" : "ел";
    feedN = {
      at: toMinute(f.at),
      guardType: "feed",
      guardAfter: Date.now(),
      text: `🍼 ${who}не ${был} ${durShort(f.sinceLabel * 60000)} — желудок свободен, ` +
        "сейчас возьмёт охотнее всего",
    };
  }

  /*
   * Два напоминания подряд — это шум, а не забота. Если окно сна
   * открывается почти одновременно с окном кормления, оставляем
   * напоминание о сне: у него есть срок годности (перегул), а
   * покормить можно и на десять минут позже.
   */
  if (sleepN && feedN && Math.abs(feedN.at - sleepN.at) < NOTIFY_MERGE_MIN * 60000) {
    feedN = null;
  }

  return { sleep: sleepN, feed: feedN, dev: devN };
}

const stripLocal = (e) => ({
  id: e.id,
  type: e.type,
  start: e.start,
  end: e.end ?? null,
  meta: e.meta,
  deleted: !!e.deleted,
  updatedAt: e.updatedAt,
});

/**
 * Один проход синхронизации. Возвращает новое состояние либо null,
 * если синхронизировать нечего или сеть недоступна.
 */
export async function syncOnce(state) {
  if (!state.auth?.token) return null;

  const dirty = state.events.filter((e) => e.dirty);
  const pushed = new Map(dirty.map((e) => [e.id, e.updatedAt]));

  const res = await fetch(`${API}/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.auth.token}`,
    },
    body: JSON.stringify({
      since: state.rev || 0,
      events: dirty.map(stripLocal),
      profile: state.profileDirty && state.profile ? state.profile : undefined,
      notify: computeNotify(state),
    }),
  });

  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  const data = await res.json();

  // слияние: последняя запись побеждает
  const byId = new Map(state.events.map((e) => [e.id, e]));
  for (const remote of data.events) {
    const local = byId.get(remote.id);
    if (!local || remote.updatedAt > local.updatedAt) {
      byId.set(remote.id, { ...remote, dirty: false });
    }
  }

  // снимаем флаг только с тех, что не успели измениться во время запроса
  const events = [...byId.values()].map((e) =>
    e.dirty && pushed.get(e.id) === e.updatedAt ? { ...e, dirty: false } : e
  );

  let profile = state.profile;
  let profileDirty = state.profileDirty;
  if (data.profile && data.profile.updatedAt >= (profile?.updatedAt || 0)) {
    profile = {
      name: data.profile.name,
      birth: data.profile.birth,
      // sex мог прийти пустым от сервера, который ещё не обновлён, —
      // тогда сохраняем локальное значение, а не затираем его
      sex: data.profile.sex || profile?.sex || null,
      // как и sex: сервер старой версии этого поля не пришлёт —
      // тогда сохраняем локальный выбор, а не затираем его пустотой
      notifyOff: data.profile.notifyOff || profile?.notifyOff || [],
      dueAt: data.profile.dueAt ?? profile?.dueAt ?? null,
      updatedAt: data.profile.updatedAt,
    };
    profileDirty = false;
  }

  /*
   * Сервер мог вернуть профиль, в котором наших полей нет: старая
   * версия сервера — или потерянная при создании семьи ПДР (её не
   * писал `insertHousehold`). Слияние выше локальное значение бережно
   * сохраняет, но обратно на сервер оно уже не уедет: профиль уходит,
   * только пока стоит `profileDirty`. Получалась тихая вечная
   * рассинхронизация, видимая лишь по тому, что пуши о вехах не
   * доходят: их снимок дат сверяется с серверной копией.
   *
   * Поэтому расхождение помечаем к дозаписи. `updatedAt` при этом
   * обязательно двигаем: на сервере запись профиля закрыта условием
   * `profile_updated_at < @updated_at`, и без сдвига UPDATE молча не
   * сделал бы ничего — а `profileDirty` вставал бы снова на каждом
   * синке. Сходится за один круг: следующий ответ уже совпадёт.
   */
  if (data.profile && profile && (
        (profile.dueAt ?? null) !== (data.profile.dueAt ?? null) ||
        (profile.sex ?? null) !== (data.profile.sex ?? null))) {
    profile = { ...profile, updatedAt: Date.now() };
    profileDirty = true;
  }

  return { ...state, events, profile, profileDirty, rev: data.rev };
}

/* ------------------------------------------------------------------ */

export const now = () => Date.now();
export const uid = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const liveEvents = (events) => events.filter((e) => !e.deleted);

export function inviteLink(token) {
  return `${location.origin}${import.meta.env.BASE_URL}#join=${token}`;
}

export function readJoinToken() {
  const m = location.hash.match(/join=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Ссылка вида t.me/bot?start=<householdId> — сервер сам знает username бота. */
export async function fetchTelegramLink(token) {
  const res = await fetch(`${API}/telegram-link`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.url;
}
