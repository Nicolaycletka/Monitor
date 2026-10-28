/* Дымовой тест режима «только просмотр».
 *
 * Основной smoke.mjs монтирует приложение от лица родителя и до этой
 * ветки не доходит вовсе. А ошибиться тут легко в обе стороны: спрятать
 * лишнее (зритель не увидит дневник) или не спрятать нужное (кнопки
 * есть, нажатие молча ничего не делает — худший из вариантов).
 *
 * Настоящий запрет всё равно на сервере, здесь проверяется только то,
 * что интерфейс не врёт.
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost/monitor/", pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document;
for (const k of ["navigator","HTMLElement","Element","Node","SVGElement","getComputedStyle",
  "requestAnimationFrame","cancelAnimationFrame","CustomEvent","Event","localStorage",
  "MutationObserver","location","history","Blob","URL"])
  if (!(k in globalThis)) globalThis[k] = dom.window[k];
globalThis.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){},
  addEventListener(){}, removeEventListener(){} });

// список участников приходит по сети — отвечаем как сервер зрителю
globalThis.fetch = async (url) => {
  if (String(url).includes("/members")) {
    return { ok: true, status: 200, json: async () => ({ members: [
      { id: "p1", name: "", role: "parent", createdAt: Date.now(), lastSeenAt: Date.now(), revokedAt: null, me: false },
      { id: "v1", name: "Бабушка", role: "viewer", createdAt: Date.now(), lastSeenAt: Date.now(), revokedAt: null, me: true },
    ] }) };
  }
  return { ok: false, status: 0, json: async () => ({}) };
};

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
await new Promise((res, rej) => {
  const r = indexedDB.open("baby-tracker", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => { const tx = r.result.transaction("kv","readwrite");
    tx.objectStore("kv").put({ profile: raw.profile, events: raw.events,
      auth: { token: "t", householdId: "h", member: { id: "v1", name: "Бабушка", role: "viewer" } },
      rev: 0, bias: 0, schema: 2, profileDirty: false }, "state");
    tx.oncomplete = res; tx.onerror = rej; };
  r.onerror = rej;
});

const errs = [];
console.error = (...a) => { const s = a.map(String).join(" ");
  if (!/not wrapped in act|Warning:/.test(s)) errs.push(s); };

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("./appbuild.mjs");
createRoot(document.getElementById("root")).render(React.createElement(App));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(900);

const html = () => document.getElementById("root").innerHTML;
const buttons = () => [...document.querySelectorAll("button")].map(b => b.textContent.trim());
const has = (t) => buttons().some(b => b === t);

let bad = 0;
const check = (label, cond, extra = "") => {
  if (!cond) bad++;
  console.log((cond ? "  ок  " : "ПРОВАЛ") + "  " + label + (extra ? "  — " + extra : ""));
};

check("приложение отрисовалось", html().length > 1000, `${html().length} символов`);
check("видна плашка режима просмотра", html().includes("Режим просмотра"));
check("нет кнопки сна", !has("Заснул") && !has("Проснулся"));
check("нет быстрых действий", !has("Грудь") && !has("Бутылочка") && !has("Подгузник"));
check("дневник всё равно виден", html().includes("Записи"));

// настройки: список участников есть, приглашать и отзывать нельзя
document.querySelector(".gear-b")?.click();
await wait(600);
check("в настройках виден список участников", html().includes("Кто имеет доступ"));
check("зритель себя видит", html().includes("Бабушка"));
check("зритель не приглашает", !has("Пригласить родителя") && !has("Пригласить для просмотра"));
check("зритель не отзывает", !has("Отозвать"));

if (errs.length) { bad++; console.log("ПРОВАЛ  ошибок в консоли: " + errs.length); console.log(errs[0]); }
console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : "\nрежим просмотра ведёт себя правильно");
process.exit(bad ? 1 : 0);
