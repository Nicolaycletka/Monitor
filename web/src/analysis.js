/*
 * Клиент фонового потока расчётов (см. analysis.worker.js).
 *
 * Три правила, ради которых этот модуль вообще существует:
 *
 * 1. Последний запрос побеждает. Пока поток считает, новые запросы того
 *    же вида не встают в очередь, а заменяют друг друга: считать окно по
 *    данным, которые уже устарели, — та самая работа впустую, что
 *    раньше замораживала экран. Все ожидающие получают свежий ответ.
 *
 * 2. В поток уходят только сны и периоды болезни. Прогноз других
 *    записей не читает (см. sleepsKey в sleep.js), а кормления и
 *    подгузники — больше половины дневника, копировать их незачем.
 *
 * 3. Если Worker недоступен (старый WebView, тесты в Node) или упал,
 *    расчёт идёт в основном потоке теми же функциями (analysis-run.js),
 *    но после отрисовки, а не внутри неё. Медленнее, но не ломается.
 */
import { RUN } from "./analysis-run.js";

let worker = null;
let broken = typeof Worker === "undefined";
let seq = 0;
const inflight = new Map(); // id -> { kind, payload, resolve, reject }
const lanes = {}; // kind -> { busy, queued: { payload, waiters[] } | null }

function getWorker() {
  if (broken) return null;
  if (worker) return worker;
  try {
    // запись ровно в такой форме: по ней vite находит и собирает поток
    worker = new Worker(new URL("./analysis.worker.js", import.meta.url), { type: "module" });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (e) => {
    const { id, ok, r, err } = e.data || {};
    const job = inflight.get(id);
    if (!job) return;
    inflight.delete(id);
    ok ? job.resolve(r) : job.reject(new Error(err));
  };
  worker.onerror = (e) => {
    // поток не поднялся или упал целиком — дальше считаем без него,
    // а уже отправленное пересчитываем здесь, чтобы никто не завис
    e.preventDefault?.();
    broken = true;
    try { worker.terminate(); } catch { /* уже мёртв */ }
    worker = null;
    const jobs = [...inflight.values()];
    inflight.clear();
    for (const j of jobs) runLocal(j.kind, j.payload).then(j.resolve, j.reject);
  };
  return worker;
}

function runLocal(kind, payload) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(RUN[kind](payload)); } catch (err) { reject(err); }
    }, 0);
  });
}

/*
 * Сторож. Ответ потока, который не пришёл, раньше ждался вечно — и
 * вместе с ним вечно ждали окно на экране и синк (он берёт прогноз
 * отсюда же). Так и случилось в проде: «Отправляю · 2 записей ждут»
 * без конца. Теперь каждый запрос ограничен по времени; по истечении
 * поток перезапускается, а запрос завершается ошибкой — вызывающие
 * её переживают (экран держит прежнее окно, синк уходит без него).
 */
export const JOB_TIMEOUT_MS = 20000;

function killWorker() {
  try { worker?.terminate(); } catch { /* уже мёртв */ }
  worker = null;
}

function send(kind, payload) {
  const w = getWorker();
  if (!w) return runLocal(kind, payload);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!inflight.has(id)) return;
      // поток завис или считает недопустимо долго — перезапускаем его;
      // остальные ожидающие тоже завершаются, иначе они повисли бы
      // на уже убитом потоке
      const jobs = [...inflight.values()];
      inflight.clear();
      killWorker();
      for (const j of jobs) j.reject(new Error("timeout"));
    }, JOB_TIMEOUT_MS);
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    inflight.set(id, { kind, payload, resolve: done(resolve), reject: done(reject) });
    try {
      w.postMessage({ id, kind, p: payload });
    } catch (err) {
      // данные не клонируются — считаем здесь, это не повод оставить экран без окна
      clearTimeout(timer);
      inflight.delete(id);
      runLocal(kind, payload).then(resolve, reject);
    }
  });
}

function request(kind, payload) {
  const lane = (lanes[kind] ||= { busy: false, queued: null });
  return new Promise((resolve, reject) => {
    if (lane.busy) {
      const waiters = lane.queued ? lane.queued.waiters : [];
      waiters.push({ resolve, reject });
      lane.queued = { payload, waiters };
      return;
    }
    drain(kind, lane, payload, [{ resolve, reject }]);
  });
}

function drain(kind, lane, payload, waiters) {
  lane.busy = true;
  send(kind, payload).then(
    (r) => waiters.forEach((w) => w.resolve(r)),
    (e) => waiters.forEach((w) => w.reject(e))
  ).finally(() => {
    lane.busy = false;
    const next = lane.queued;
    lane.queued = null;
    if (next) drain(kind, lane, next.payload, next.waiters);
  });
}

const forModel = (events) =>
  (events || []).filter((e) => e.type === "sleep" || e.type === "illness");

/** Окно следующего сна. То же, что predictNext(events, birth, now, bias). */
export const predictAsync = (events, birth, now, bias = 0) =>
  request("predict", { events: forModel(events), birth, now, bias });

/** Самопроверка и сравнение источников для вкладки «Неделя». */
export const qualityAsync = (events, birth, now) =>
  request("quality", { events: forModel(events), birth, now });
