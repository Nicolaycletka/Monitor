/* Дымовой тест: монтируем ВСЁ приложение в jsdom и щёлкаем по вкладкам.
   Сборка не ловит обращение к переменной до объявления — приложение
   при этом показывает пустой фон. Этот тест ловит. */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost/monitor/", pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document;
for (const k of ["navigator","HTMLElement","Element","Node","SVGElement","getComputedStyle",
  "requestAnimationFrame","cancelAnimationFrame","CustomEvent","Event","localStorage","MutationObserver","location","history","Blob","URL"])
  if (!(k in globalThis)) globalThis[k] = dom.window[k];
globalThis.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
globalThis.fetch = async () => ({ ok:false, status:0, json: async()=>({}) });

const raw = JSON.parse(readFileSync(process.argv[2] || "/mnt/user-data/uploads/sleep-2026-08-30.json","utf8"));
await new Promise((res, rej) => {
  const r = indexedDB.open("baby-tracker", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => { const tx = r.result.transaction("kv","readwrite");
    tx.objectStore("kv").put({ profile: raw.profile, events: raw.events,
      auth:{token:"t",householdId:"h"}, rev:0, bias:0, schema:2, profileDirty:false }, "state");
    tx.oncomplete = res; tx.onerror = rej; };
  r.onerror = rej;
});

const errs = [];
const origErr = console.error;
console.error = (...a) => { const s = a.map(String).join(" "); if (!/not wrapped in act|Warning:/.test(s)) errs.push(s); };

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("../web/appbuild.mjs");
const root = createRoot(document.getElementById("root"));
root.render(React.createElement(App));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(900);

const click = async (text) => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === text);
  if (!b) return `кнопка «${text}» не найдена`;
  b.click(); await wait(400);
  const n = document.getElementById("root").innerHTML.length;
  return `${String(n).padStart(6)} символов ${n < 400 ? "  ПУСТО" : ""}`;
};

console.log("экран                    | размер разметки");
console.log(`Сон / Сейчас             | ${String(document.getElementById("root").innerHTML.length).padStart(6)} символов`);
for (const [sec, tabs] of [["Сон",["День","Неделя"]],["Здоровье",["Вес","Рост","Голова"]]]) {
  console.log(`${sec.padEnd(24)} | ${await click(sec)}`);
  for (const t of tabs) console.log(`${(sec+" / "+t).padEnd(24)} | ${await click(t)}`);
}
console.log(errs.length ? "\nОШИБКИ:\n" + errs.slice(0,3).join("\n") : "\nошибок нет");
process.exit(errs.length ? 1 : 0);
