import { readFileSync } from "node:fs";
import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  db,
  findHousehold,
  findHouseholdById,
  insertHousehold,
  updateProfile,
  maxRev,
  eventsSince,
  getEvent,
  upsertEvent,
  pruneDeleted,
  getNotification,
  setNotification,
  clearNotification,
  markNotificationSent,
  newerEventSince,
  householdDates,
  dueNotifications,
  lastSleepEvent,
  linkTelegramChat,
  telegramChatsFor,
  findMemberByToken,
  insertMember,
  listMembers,
  touchMember,
  revokeMember,
  countActiveParents,
  insertInvite,
  findInvite,
  useInvite,
} from "./db.js";
import { telegramEnabled, sendMessage, getMe, deleteWebhook, getUpdates } from "./telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
// "" для корня, "/monitor" для подкаталога
const BASE = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, "..", "web", "dist");

/*
 * Идентификатор сборки фронтенда — имя собранного JS-файла из
 * index.html (vite подставляет в него хеш содержимого). Клиент узнаёт
 * СВОЙ идентификатор из `import.meta.url`, то есть из имени файла, из
 * которого он сам загружен: оба значения выводятся из одного артефакта,
 * никакой отдельной нумерации версий заводить не нужно.
 *
 * Зачем вообще. Тексты вех живут в бандле НА ТЕЛЕФОНЕ и приезжают на
 * сервер уже готовой строкой. Значит залипший клиент молча шлёт старый
 * контент, а снаружи это выглядит как «пуш пришёл не тот» — ровно так
 * и случилось. Service worker тут не спасает: файл sw.js между
 * деплоями не меняется, браузеру нечего заметить, а PWA, которую не
 * закрывали, при возврате из фона навигацию не делает и новый
 * index.html не запрашивает.
 *
 * Читаем один раз при старте: контейнер пересобирается вместе с
 * фронтендом, так что в живом процессе это значение поменяться не может.
 */
const BUILD = (() => {
  try {
    const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
    return html.match(/assets\/([A-Za-z0-9._-]+\.js)/)?.[1] || null;
  } catch {
    return null; // дев-режим: фронтенд отдаёт vite, dist ещё нет
  }
})();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

const r = express.Router();

/* ---------- элементарная защита от перебора токенов ---------- */

const attempts = new Map();
setInterval(() => attempts.clear(), 10 * 60 * 1000).unref();

function throttle(req, res, next) {
  const ip = req.ip || "unknown";
  const n = attempts.get(ip) || 0;
  if (n > 60) return res.status(429).json({ error: "too_many_attempts" });
  next();
}

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");

/*
 * Опознание идёт по строке УЧАСТНИКА, а не по общему токену семьи.
 * Прежний общий токен при миграции стал обычным участником с ролью
 * parent (см. db.js), поэтому подключённые телефоны продолжают
 * работать без переподключения.
 *
 * Отозванный участник не находится вовсе — запрос получает 401, тот
 * же ответ, что и при неправильном токене. Специального «доступ
 * отозван» на сервере нет намеренно: снаружи это лишний сигнал
 * тому, кто перебирает токены.
 */
function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "no_token" });

  const member = findMemberByToken.get(hash(token));
  const row = member ? findHouseholdById.get(member.household_id) : null;
  if (!member || !row) {
    attempts.set(req.ip, (attempts.get(req.ip) || 0) + 1);
    return res.status(401).json({ error: "bad_token" });
  }

  touchMember.run(Date.now(), member.id);
  req.household = row;
  req.member = member;
  next();
}

/** Роль viewer читает, но ничего не меняет. Проверка ТОЛЬКО здесь: в
 *  интерфейсе кнопки можно спрятать, но запрос никто не мешает послать
 *  руками, поэтому решает сервер. */
function requireParent(req, res, next) {
  if (req.member?.role !== "parent") return res.status(403).json({ error: "read_only" });
  next();
}

/* ---------- CORS для автономного приложения ---------- */

/*
 * В вебе CORS не нужен: приложение и API отдаёт один и тот же сервер.
 * Автономный APK — другое дело: его файлы лежат внутри приложения и
 * открываются с origin `https://localhost`, то есть КАЖДЫЙ запрос к
 * API становится межсайтовым.
 *
 * Список источников закрытый и задаётся через CORS_ORIGINS. Отражать
 * присланный Origin обратно (частый приём) здесь нельзя: токен ездит
 * в заголовке, любой сайт в браузере пользователя смог бы тогда
 * дёргать API от его имени, если бы токен утёк в страницу.
 *
 * Учётные данные (`credentials`) не разрешаем намеренно: авторизация
 * идёт заголовком Authorization, а не куками, поэтому браузеру нечего
 * прикладывать — и CSRF в принципе неоткуда взяться.
 */
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || "https://localhost,capacitor://localhost")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

r.use("/api", (req, res, next) => {
  const origin = req.get("origin");
  if (origin && CORS_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "authorization, content-type");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Max-Age", "86400");
  }
  // предварительный запрос браузера: до обработчиков его пускать незачем
  if (req.method === "OPTIONS") return res.sendStatus(origin && CORS_ORIGINS.has(origin) ? 204 : 403);
  next();
});

/* ---------- создание семьи ---------- */

r.post("/api/household", throttle, (req, res) => {
  const { name, birth } = req.body || {};
  const sex = req.body?.sex === "m" || req.body?.sex === "f" ? req.body.sex : null;
  const dueAtRaw = Number(req.body?.dueAt);
  const dueAt = Number.isFinite(dueAtRaw) ? dueAtRaw : null;
  if (typeof name !== "string" || !name.trim() || !Number.isFinite(birth)) {
    return res.status(400).json({ error: "bad_profile" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const now = Date.now();

  /*
   * Семья и её первый участник заводятся ОДНОЙ транзакцией. Раздельно
   * нельзя: миграция общих токенов в участников одноразовая и работает
   * только при старте, так что семья, созданная без строки участника,
   * получила бы 401 на первом же синке — и починить это было бы нечем,
   * токен на руках, а войти по нему некуда.
   */
  db.transaction(() => {
    insertHousehold.run({
      id,
      token_hash: hash(token),
      name: name.trim().slice(0, 60),
      birth,
      sex,
      due_at: dueAt,
      profile_updated_at: now,
      created_at: now,
    });
    insertMember.run({
      id: memberId,
      household_id: id,
      name: "",
      role: "parent",
      token_hash: hash(token),
      created_at: now,
    });
  })();

  res.json({ householdId: id, token, member: { id: memberId, name: "", role: "parent" } });
});

/* ---------- синхронизация ---------- */

const clean = (e, householdId, rev) => ({
  household_id: householdId,
  id: String(e.id).slice(0, 64),
  // illness — период болезни: данные за него не идут в обучение прогноза.
  // weight — взвешивание, meta.g в граммах;
  // length — длина тела лёжа, head — окружность головы, meta.mm в мм.
  // Неизвестные типы падают в "feed" молча, поэтому список нужно
  // расширять ОДНОВРЕМЕННО с клиентом, иначе записи тихо испортятся.
  type: ["sleep", "feed", "diaper", "illness", "weight", "length", "head"].includes(e.type)
    ? e.type
    : "feed",
  start: Number(e.start) || 0,
  finish: e.end == null ? null : Number(e.end),
  meta: e.meta ? JSON.stringify(e.meta).slice(0, 500) : null,
  deleted: e.deleted ? 1 : 0,
  updated_at: Number(e.updatedAt) || Date.now(),
  rev,
});

const toClient = (r) => ({
  id: r.id,
  type: r.type,
  start: r.start,
  end: r.finish,
  meta: r.meta ? JSON.parse(r.meta) : undefined,
  deleted: !!r.deleted,
  updatedAt: r.updated_at,
});

/** Виды уведомлений, известные серверу. Нужен только для валидации. */
const KINDS = ["sleep", "feed", "dev"];

/** Ближе этого к уже отправленному — то же самое напоминание, а не новое. */
const RE_ARM_GAP_MS = 20 * 60000;

/*
 * Насколько далеко в прошлое и в будущее метка считается правдоподобной,
 * по видам: [назад, вперёд].
 *
 * БЫЛ БАГ: горизонт был общий, 5 минут назад и 12 часов вперёд. Для сна
 * и кормления это верно — окно всегда в пределах ближайших часов, и
 * метка за их пределами означает сломанные часы на телефоне. Но `dev` —
 * не прогноз, а КАЛЕНДАРЬ: ближайшая веха бывает и через месяц.
 * Клиент честно её считал, а сервер каждый раз отбрасывал как
 * «неправдоподобно далёкую» — пуш вставал в очередь, только если
 * приложение открыли в последние 12 часов перед самим моментом.
 *
 * Назад для `dev` — те же 3 суток, что `CATCH_UP_MS` в milestones.js:
 * иначе клиент подхватывает пропущенную веху, а сервер тут же снимает
 * её как протухшую, и подхват не работает вообще. Эти два числа обязаны
 * меняться вместе.
 */
/*
 * Потолок длины текста уведомления при приёме от клиента.
 *
 * Был 300 символов — под короткие напоминания о сне, где этого хватало
 * с запасом. Тексты вех развития длиннее в разы, и обрез происходил
 * МОЛЧА: клиент отправлял полный текст, сервер сохранял четверть, в
 * телеграм уезжал обрубок на полуслове. Ни ошибки, ни предупреждения —
 * с виду просто «пуш пришёл короткий».
 *
 * 8192 — два сообщения Telegram по 4096; на большее splitMessage всё
 * равно разобьёт, а от совсем битых данных клиента ограничение
 * по-прежнему защищает. Понадобится длиннее — правится тут, но помните,
 * что каждый пуш это ещё и уведомление на телефоне посреди ночи.
 */
const MAX_NOTIFY_TEXT = 8192;

const DAY_MS = 86400000;
const HORIZON = {
  sleep: [5 * 60000, 12 * 3600000],
  feed: [5 * 60000, 12 * 3600000],
  dev: [3 * DAY_MS, 400 * DAY_MS],
};

/** Одно уведомление: null — снять, объект — поставить. */
function putNotify(hid, kind, n) {
  if (n === null) return clearNotification.run(hid, kind);

  /*
   * БЫЛ БАГ: обе ветки ниже раньше просто делали `return`, оставляя
   * старую запись в очереди нетронутой. Клиент пересчитывает окно на
   * каждом синке, и стоит окну устареть (ребёнка покормили, момент
   * прошёл) — новое вычисленное время становится "невалидным" по этим
   * же проверкам, функция выходит НИЧЕГО не сделав, а прежняя,
   * теперь неактуальная запись остаётся в очереди и рано или поздно
   * улетает планировщиком. Именно так приходили неактуальные пуши:
   * протухание не переносилось на сервер, потому что сервер о нём
   * узнавал только через "новое валидное время", а протухание — это
   * ОТСУТСТВИЕ валидного времени.
   *
   * Правило теперь простое: если новый расчёт не даёт валидного
   * времени — значит слать нечего, и любая ждущая отправки запись
   * снимается. Уже отправленную не трогаем: она уже уехала, и
   * повторно её обнулять незачем.
   */
  if (!n || !Number.isFinite(n.at)) {
    const cur = getNotification.get(hid, kind);
    if (cur && !cur.sent) clearNotification.run(hid, kind);
    return;
  }
  const at = Math.round(n.at);
  const now = Date.now();
  // отбрасываем совсем старые (часы уехали) или неправдоподобно
  // далёкие метки — не даём битым клиентским данным что-то сломать
  const [behind, ahead] = HORIZON[kind] || HORIZON.sleep;
  if (at <= now - behind || at >= now + ahead) {
    const cur = getNotification.get(hid, kind);
    if (cur && !cur.sent) clearNotification.run(hid, kind);
    return;
  }
  const current = getNotification.get(hid, kind);
  if (current && current.at === at) return; // уже стоит, не сбрасываем sent

  /*
   * Уведомление уже отправлено, а новое время рядом со старым — это не
   * новое событие, а дрожание прогноза. Перевзводить нельзя: родитель
   * получит второе такое же сообщение. Клиент округляет время до
   * минуты, но округление не спасает, когда расчёт переползает через
   * границу минуты, а прогноз между тем шевелится и на пару минут.
   * Разъехалось сильно — значит окно правда сдвинулось, взводим.
   */
  if (current && current.sent && Math.abs(current.at - at) < RE_ARM_GAP_MS) return;
  setNotification.run({
    id: hid,
    kind,
    at,
    text: String(n.text || "").slice(0, MAX_NOTIFY_TEXT),
    guard_type: typeof n.guardType === "string" ? n.guardType : null,
    guard_after: Number.isFinite(n.guardAfter) ? Math.round(n.guardAfter) : null,
    guard_due_at: Number.isFinite(n.guardDueAt) ? Math.round(n.guardDueAt) : null,
    guard_birth_at: Number.isFinite(n.guardBirthAt) ? Math.round(n.guardBirthAt) : null,
  });
}

function applyNotify(hid, notify) {
  if (notify === undefined) return; // клиент ничего не пересчитывал
  if (notify === null) {
    for (const k of KINDS) clearNotification.run(hid, k);
    return;
  }
  // старая форма: плоский объект с at/fromLabel/toLabel
  if (Number.isFinite(notify.at)) {
    putNotify(hid, "sleep", {
      at: notify.at,
      text: `🌙 Пора успокаиваться — окно сна ${notify.fromLabel}–${notify.toLabel}`,
      guardType: "sleep",
      guardAfter: Date.now(),
    });
    return;
  }
  for (const k of KINDS) {
    if (k in notify) putNotify(hid, k, notify[k]);
  }
}

/** Кто есть кто — уходит клиенту, чтобы он знал, что прятать. */
const memberInfo = (m) => ({ id: m.id, name: m.name, role: m.role });

r.post("/api/sync", throttle, auth, (req, res) => {
  const hid = req.household.id;
  const since = Number(req.body?.since) || 0;

  /*
   * Единственная точка записи во всём API — поэтому режим «только
   * чтение» стоит здесь одной проверкой, а не рассыпан по обработчикам.
   * Присланное зрителем не отвергаем ошибкой, а молча игнорируем: его
   * приложение и так не должно ничего слать, а если пришло — значит
   * либо устаревший клиент, либо ручной запрос, и в обоих случаях
   * полезнее отдать данные, чем свалить синхронизацию.
   */
  const canWrite = req.member.role === "parent";
  const incoming = canWrite && Array.isArray(req.body?.events)
    ? req.body.events.slice(0, 2000)
    : [];
  const profile = canWrite ? req.body?.profile : undefined;

  const apply = db.transaction(() => {
    let rev = maxRev.get(hid).rev;

    for (const e of incoming) {
      if (!e || typeof e.id !== "string") continue;
      const existing = getEvent.get(hid, e.id);
      const incomingAt = Number(e.updatedAt) || 0;
      // последняя запись побеждает; равные метки считаем уже применёнными
      if (existing && existing.updated_at >= incomingAt) continue;
      rev += 1;
      upsertEvent.run(clean(e, hid, rev));
    }

    if (profile && Number.isFinite(profile.updatedAt)) {
      updateProfile.run({
        id: hid,
        name: String(profile.name || "").slice(0, 60),
        birth: Number(profile.birth) || null,
        sex: profile.sex === "m" || profile.sex === "f" ? profile.sex : null,
        notify_off: Array.isArray(profile.notifyOff)
          ? profile.notifyOff.filter((k) => KINDS.includes(k)).join(",")
          : null,
        due_at: Number.isFinite(profile.dueAt) ? Math.round(profile.dueAt) : null,
        updated_at: Number(profile.updatedAt),
      });
    }

    /*
     * Расписание уведомлений приходит от клиента — там же, где
     * считается прогноз (с личной поправкой и весом). Сервер сам
     * ничего не прогнозирует, только хранит время и текст.
     *
     * Принимаются две формы. Новая: { sleep: {...}|null, feed: {...}|null }.
     * Старая: { at, fromLabel, toLabel } — так шлёт телефон, на
     * котором приложение ещё не обновилось. Без поддержки старой
     * формы напоминания о сне на нём молча перестали бы приходить.
     */
    // очередь уведомлений семьи — тоже запись: зритель её не трогает,
    // иначе телефон бабушки перебивал бы расчёты родителей
    if (canWrite) applyNotify(hid, req.body?.notify);
  });

  apply();

  const rows = eventsSince.all(hid, since);
  const current = db
    .prepare("SELECT name, birth, sex, notify_off, due_at, profile_updated_at FROM households WHERE id = ?")
    .get(hid);

  res.json({
    rev: maxRev.get(hid).rev,
    events: rows.map(toClient),
    profile: {
      name: current.name,
      birth: current.birth,
      sex: current.sex || null,
      notifyOff: current.notify_off ? current.notify_off.split(",") : [],
      dueAt: current.due_at || null,
      updatedAt: current.profile_updated_at,
    },
    serverTime: Date.now(),
    build: BUILD,
    member: memberInfo(req.member),
  });
});

/* ---------- участники семьи ---------- */

const INVITE_TTL_MS = 24 * 3600 * 1000;

/*
 * Код приглашения. Короткий, но из 32 случайных байт: его набирают
 * руками редко (обычно переходят по ссылке), зато он живёт сутки и
 * сгорает при первом использовании — в отличие от прежней ссылки,
 * которая содержала настоящий токен и работала вечно.
 */
r.post("/api/invites", throttle, auth, requireParent, (req, res) => {
  const role = req.body?.role === "viewer" ? "viewer" : "parent";
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const code = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  insertInvite.run({
    code_hash: hash(code),
    household_id: req.household.id,
    role,
    name,
    created_at: now,
    expires_at: now + INVITE_TTL_MS,
  });
  res.json({ code, role, name, expiresAt: now + INVITE_TTL_MS });
});

/*
 * Обмен кода на собственный токен. Без auth — приглашённый ещё никто.
 * Отсюда же и throttle: это единственный маршрут, где посторонний
 * может подбирать секрет.
 */
r.post("/api/join", throttle, (req, res) => {
  const code = String(req.body?.code || "");
  if (!code) return res.status(400).json({ error: "no_code" });

  const inv = findInvite.get(hash(code));
  const now = Date.now();
  if (!inv || inv.used_at || inv.expires_at < now) {
    attempts.set(req.ip, (attempts.get(req.ip) || 0) + 1);
    return res.status(404).json({ error: "bad_invite" });
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const name = String(req.body?.name || inv.name || "").trim().slice(0, 40);

  /*
   * Транзакция обязательна: два телефона могут открыть одну ссылку
   * одновременно. Гасим приглашение УСЛОВНЫМ обновлением (used_at IS
   * NULL) и проверяем changes — проигравший получит 404, а не второй
   * доступ по тому же коду.
   */
  const done = db.transaction(() => {
    if (useInvite.run(now, id, hash(code)).changes !== 1) return false;
    insertMember.run({
      id,
      household_id: inv.household_id,
      name,
      role: inv.role,
      token_hash: hash(token),
      created_at: now,
    });
    return true;
  })();

  if (!done) return res.status(404).json({ error: "bad_invite" });
  res.json({ token, householdId: inv.household_id, member: { id, name, role: inv.role } });
});

r.get("/api/members", auth, (req, res) => {
  res.json({
    members: listMembers.all(req.household.id).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      createdAt: m.created_at,
      lastSeenAt: m.last_seen_at,
      revokedAt: m.revoked_at,
      me: m.id === req.member.id,
    })),
  });
});

r.post("/api/members/:id/revoke", throttle, auth, requireParent, (req, res) => {
  const id = String(req.params.id || "");

  // себя отзывать нельзя: это мгновенная потеря доступа с того же
  // устройства, с которого нажали, и вернуть его будет нечем
  if (id === req.member.id) return res.status(400).json({ error: "self_revoke" });

  const target = listMembers.all(req.household.id).find((m) => m.id === id);
  if (!target || target.revoked_at) return res.status(404).json({ error: "no_member" });

  // и последнего родителя тоже: семья осталась бы без права записи
  if (target.role === "parent" && countActiveParents.get(req.household.id).n <= 1) {
    return res.status(400).json({ error: "last_parent" });
  }

  revokeMember.run(Date.now(), id, req.household.id);
  res.json({ ok: true });
});

r.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- уведомления в Telegram ---------- */

let botUsername = null;

r.get("/api/telegram-link", auth, requireParent, (req, res) => {
  if (!telegramEnabled()) return res.status(503).json({ error: "telegram_disabled" });
  if (!botUsername) return res.status(503).json({ error: "bot_not_ready" });
  res.json({ url: `https://t.me/${botUsername}?start=${req.household.id}` });
});

/* ---------- статика ---------- */

r.use(
  express.static(STATIC_DIR, {
    setHeaders(res, path) {
      if (path.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
      else if (path.includes("/assets/"))
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

r.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(STATIC_DIR, "index.html")));

// /monitor -> /monitor/ , иначе относительные ссылки уедут в корень.
// Сравниваем originalUrl: Express без strict routing считает
// "/monitor" и "/monitor/" одним маршрутом и зациклил бы редирект.
if (BASE) {
  app.get(BASE, (req, res, next) => {
    if (req.originalUrl.split("?")[0] === BASE) return res.redirect(301, BASE + "/");
    next();
  });
}
app.use(BASE || "/", r);

setInterval(pruneDeleted, 24 * 3600 * 1000).unref();

app.listen(PORT, () => console.log(`baby-tracker on :${PORT}${BASE || ""}`));

/* ---------- Telegram: приём /start и рассылка уведомлений ---------- */

if (telegramEnabled()) {
  // на случай, если на боте раньше был включён webhook (например, для
  // Mini App) — иначе getUpdates будет молча ничего не возвращать
  deleteWebhook();

  getMe().then((me) => {
    if (me?.username) botUsername = me.username;
    else console.warn("не удалось получить username бота — проверьте TG_BOT_TOKEN");
  });

  let offset = 0;
  (async function pollLoop() {
    for (;;) {
      const { updates, offset: next } = await getUpdates(offset);
      offset = next;
      for (const u of updates) {
        const msg = u.message;
        const text = msg?.text || "";
        const m = text.match(/^\/start(?:@\S+)?\s*(\S+)?/);
        if (!m || !msg?.chat?.id) continue;
        const chatId = String(msg.chat.id);
        const householdId = m[1];
        if (!householdId) {
          await sendMessage(chatId, "Открой эту ссылку из приложения дневника сна — она подставит нужный идентификатор.");
          continue;
        }
        const hh = findHouseholdById.get(householdId);
        if (!hh) {
          await sendMessage(chatId, "Не нашёл такой дневник — возможно, ссылка устарела.");
          continue;
        }
        linkTelegramChat.run({ household_id: householdId, chat_id: chatId, linked_at: Date.now() });
        await sendMessage(chatId, `Готово! Буду присылать сюда напоминания о снах${hh.name ? ` — ${hh.name}` : ""}.`);
      }
      if (!updates.length) await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  /*
   * Отдельная сверка для вех развития: если родитель поправил ПДР или
   * дату рождения ПОСЛЕ того, как был посчитан этот пуш, текст и момент
   * могли устареть (скачок целиком считается от другой даты). Дневник
   * тут ни при чём, поэтому это не newerEventSince, а прямое сравнение
   * снимка с текущим значением в профиле.
   *
   * Несовпадение ОТКЛАДЫВАЕТ пуш, а не съедает: клиент на ближайшем
   * синке пересчитает веху от новых дат и перевзведёт очередь другим
   * временем, перезаписав эту строку. Раньше здесь стоял `continue`
   * после `markNotificationSent`, и любое расхождение — включая
   * вызванное потерей `due_at` при создании семьи — теряло веху
   * навсегда и молча. Молчание было самым дорогим: снаружи это
   * выглядело как «пуш просто не пришёл», без единой зацепки.
   */
  const warnedDevDates = new Set();

  function devDatesMatch(n) {
    const cur = householdDates.get(n.id);
    if (!cur) return true; // семьи нет — не наше дело, решит следующая проверка
    const ok = (cur.due_at || null) === (n.guard_due_at || null) && cur.birth === n.guard_birth_at;
    if (!ok && !warnedDevDates.has(n.id)) {
      warnedDevDates.add(n.id);
      console.warn(
        "веха отложена: снимок дат не сходится с профилем " +
        `(семья ${n.id}; рождение ${n.guard_birth_at} против ${cur.birth}, ` +
        `ПДР ${n.guard_due_at} против ${cur.due_at})`
      );
    }
    return ok;
  }

  setInterval(async () => {
    const due = dueNotifications.all(Date.now());
    for (const n of due) {
      /*
       * Защитный чек: ребёнок уже спит. Будить его напоминанием —
       * худшее, что это приложение может сделать, поэтому проверка
       * общая для всех видов, а не только для сна.
       *
       * Но реакция разная. Сон и кормление — окна: пропущенное окно
       * уже не вернуть, напоминание о нём протухло, и снять его —
       * правильно. Веха развития — календарная заметка, ей всё равно,
       * придёт она сейчас или через час; поэтому её мы ОТКЛАДЫВАЕМ
       * до пробуждения, а не теряем.
       *
       * БЫЛ БАГ: `markNotificationSent` стоял ВЫШЕ этой проверки, то
       * есть спящий ребёнок помечал веху отправленной и она исчезала
       * навсегда. А скачки развития считаются от ПДР или даты рождения
       * и попадают ровно на то же время суток — то есть чаще всего на
       * ночь. Ночная веха не могла дойти в принципе.
       */
      const last = lastSleepEvent.get(n.id);
      const asleep = last && last.finish === null;
      if (asleep && n.kind === "dev") continue; // отложить, не помечая

      if (n.kind === "dev" && !devDatesMatch(n)) continue; // тоже отложить

      // помечаем сразу, чтобы сбой отправки не привёл к повтору на
      // следующем тике планировщика
      markNotificationSent.run(n.id, n.kind);
      if (asleep) continue;

      /*
       * Прогноз мог устареть между постановкой и отправкой: ребёнка
       * покормили, или родитель поправил запись задним числом. Телефон
       * в это время мог быть выключен и ничего не пересчитать, поэтому
       * проверка обязана быть здесь, а не только на клиенте.
       */
      if (n.guard_type && Number.isFinite(n.guard_after)) {
        const changed = newerEventSince.get(n.id, n.guard_type, n.guard_after);
        if (changed && changed.n > 0) continue;
      }

      const chats = telegramChatsFor.all(n.id);
      if (!chats.length) continue;
      for (const c of chats) await sendMessage(c.chat_id, n.text);
    }
  }, 30000).unref();
}
