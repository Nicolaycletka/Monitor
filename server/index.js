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
  dueNotifications,
  lastSleepEvent,
  linkTelegramChat,
  telegramChatsFor,
} from "./db.js";
import { telegramEnabled, sendMessage, getMe, deleteWebhook, getUpdates } from "./telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
// "" для корня, "/monitor" для подкаталога
const BASE = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, "..", "web", "dist");

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

function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "no_token" });
  const row = findHousehold.get(hash(token));
  if (!row) {
    attempts.set(req.ip, (attempts.get(req.ip) || 0) + 1);
    return res.status(401).json({ error: "bad_token" });
  }
  req.household = row;
  next();
}

/* ---------- создание семьи ---------- */

r.post("/api/household", throttle, (req, res) => {
  const { name, birth } = req.body || {};
  const sex = req.body?.sex === "m" || req.body?.sex === "f" ? req.body.sex : null;
  if (typeof name !== "string" || !name.trim() || !Number.isFinite(birth)) {
    return res.status(400).json({ error: "bad_profile" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  insertHousehold.run({
    id,
    token_hash: hash(token),
    name: name.trim().slice(0, 60),
    birth,
    sex,
    profile_updated_at: Date.now(),
    created_at: Date.now(),
  });
  res.json({ householdId: id, token });
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
const KINDS = ["sleep", "feed"];

/** Ближе этого к уже отправленному — то же самое напоминание, а не новое. */
const RE_ARM_GAP_MS = 20 * 60000;

/** Одно уведомление: null — снять, объект — поставить. */
function putNotify(hid, kind, n) {
  if (n === null) return clearNotification.run(hid, kind);
  if (!n || !Number.isFinite(n.at)) return;
  const at = Math.round(n.at);
  const now = Date.now();
  // отбрасываем совсем старые (часы уехали) или неправдоподобно
  // далёкие метки — не даём битым клиентским данным что-то сломать
  if (at <= now - 5 * 60000 || at >= now + 12 * 3600000) return;
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
    text: String(n.text || "").slice(0, 300),
    guard_type: typeof n.guardType === "string" ? n.guardType : null,
    guard_after: Number.isFinite(n.guardAfter) ? Math.round(n.guardAfter) : null,
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

r.post("/api/sync", throttle, auth, (req, res) => {
  const hid = req.household.id;
  const since = Number(req.body?.since) || 0;
  const incoming = Array.isArray(req.body?.events) ? req.body.events.slice(0, 2000) : [];
  const profile = req.body?.profile;

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
    applyNotify(hid, req.body?.notify);
  });

  apply();

  const rows = eventsSince.all(hid, since);
  const current = db
    .prepare("SELECT name, birth, sex, notify_off, profile_updated_at FROM households WHERE id = ?")
    .get(hid);

  res.json({
    rev: maxRev.get(hid).rev,
    events: rows.map(toClient),
    profile: {
      name: current.name,
      birth: current.birth,
      sex: current.sex || null,
      notifyOff: current.notify_off ? current.notify_off.split(",") : [],
      updatedAt: current.profile_updated_at,
    },
    serverTime: Date.now(),
  });
});

r.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ---------- уведомления в Telegram ---------- */

let botUsername = null;

r.get("/api/telegram-link", auth, (req, res) => {
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

  setInterval(async () => {
    const due = dueNotifications.all(Date.now());
    for (const n of due) {
      // помечаем сразу, чтобы сбой отправки не привёл к повтору на
      // следующем тике планировщика
      markNotificationSent.run(n.id, n.kind);

      // защитный чек: ребёнок уже спит. Будить его напоминанием —
      // худшее, что это приложение может сделать, поэтому проверка
      // общая для всех видов, а не только для сна.
      const last = lastSleepEvent.get(n.id);
      if (last && last.finish === null) continue;

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
