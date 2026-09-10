/* Дымовой тест первого экрана: подключение по коду приглашения.
 *
 * Экран Onboarding виден только на чистом устройстве, поэтому оба
 * остальных дымовых теста его не задевают вовсе — они стартуют с уже
 * заполненной базой. А это единственный путь внутрь для приглашённого:
 * если он сломается, человек упрётся в него молча и без вариантов.
 *
 * Проверяется и то, что в поле можно вставить ЦЕЛУЮ ссылку, а не
 * только код: вставить из буфера то, что прислали, — первое, что
 * сделает живой человек.
 */
import { JSDOM } from "jsdom";
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

const seen = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  seen.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
  if (u.endsWith("/join")) {
    return { ok: true, status: 200, json: async () => ({
      token: "viewer-token", householdId: "h",
      member: { id: "v1", name: "Бабушка", role: "viewer" } }) };
  }
  if (u.endsWith("/sync")) {
    return { ok: true, status: 200, json: async () => ({
      events: [], rev: 0, profile: { name: "Василиса", birth: Date.now() - 1e10, sex: "f", updatedAt: 1 },
      member: { id: "v1", name: "Бабушка", role: "viewer" } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

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
const btn = (t) => [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(t));

let bad = 0;
const check = (label, cond, extra = "") => {
  if (!cond) bad++;
  console.log((cond ? "  ок  " : "ПРОВАЛ") + "  " + label + (extra ? "  — " + extra : ""));
};

check("первый экран показан", html().includes("Начнём"), `${html().length} символов`);
check("поле кода есть", html().includes("Код приглашения"));

// вставляем ЦЕЛУЮ ссылку, как её пришлют в мессенджере
const input = [...document.querySelectorAll("input")]
  .find(i => i.placeholder === "Код приглашения");
check("поле найдено", Boolean(input));

if (input) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "https://burmalda.host/monitor/#invite=AbC-123_xyz");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await wait(200);
  btn("Подключиться по коду")?.click();
  await wait(700);

  const join = seen.find(r => r.url.endsWith("/join"));
  check("код выкушен из ссылки", join?.body?.code === "AbC-123_xyz", JSON.stringify(join?.body));
  check("после подключения открылся дневник", html().includes("Василиса"));
  check("роль зрителя подхвачена", html().includes("Режим просмотра"));
}

if (errs.length) { bad++; console.log("ПРОВАЛ  ошибок в консоли: " + errs.length); console.log(errs[0]); }
console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : "\nподключение по коду работает");
process.exit(bad ? 1 : 0);
