import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  db,
  findHousehold,
  insertHousehold,
  updateProfile,
  maxRev,
  eventsSince,
  getEvent,
  upsertEvent,
  pruneDeleted,
} from "./db.js";

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
    profile_updated_at: Date.now(),
    created_at: Date.now(),
  });
  res.json({ householdId: id, token });
});

/* ---------- синхронизация ---------- */

const clean = (e, householdId, rev) => ({
  household_id: householdId,
  id: String(e.id).slice(0, 64),
  type: ["sleep", "feed", "diaper"].includes(e.type) ? e.type : "feed",
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
        updated_at: Number(profile.updatedAt),
      });
    }
  });

  apply();

  const rows = eventsSince.all(hid, since);
  const current = db
    .prepare("SELECT name, birth, profile_updated_at FROM households WHERE id = ?")
    .get(hid);

  res.json({
    rev: maxRev.get(hid).rev,
    events: rows.map(toClient),
    profile: {
      name: current.name,
      birth: current.birth,
      updatedAt: current.profile_updated_at,
    },
    serverTime: Date.now(),
  });
});

r.get("/api/health", (_req, res) => res.json({ ok: true }));

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
