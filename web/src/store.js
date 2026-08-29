/**
 * Локальное хранилище (IndexedDB) + синхронизация с сервером.
 *
 * Принцип: local-first. Всё пишется в IndexedDB сразу и работает офлайн.
 * Синхронизация — фоновая, отдельным циклом. Слияние по правилу
 * "последняя запись побеждает" на основе updatedAt.
 */

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

export const emptyState = {
  profile: null,      // { name, birth, updatedAt }
  events: [],         // { id, type, start, end, meta, deleted, updatedAt, dirty }
  auth: null,         // { token, householdId }
  rev: 0,             // курсор сервера
  bias: 0,            // личная поправка окна, минуты
  profileDirty: false,
};

export async function loadState() {
  try {
    const saved = await idbGet(KEY);
    if (saved) return { ...emptyState, ...saved };
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

export async function createHousehold(name, birth) {
  const res = await fetch(`${API}/household`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, birth }),
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
    state.profile.birth
  );
  return {
    ...state,
    auth: { token, householdId },
    rev: 0,
    profileDirty: true,
    events: state.events.map((e) => ({ ...e, dirty: true })),
  };
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
      updatedAt: data.profile.updatedAt,
    };
    profileDirty = false;
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
