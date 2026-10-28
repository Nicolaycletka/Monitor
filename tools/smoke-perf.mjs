/* Дымовой тест отзывчивости.
 *
 * Проверяет не «работает ли», а «не подвисает ли» — то, что обычные
 * дымовые тесты пропускают полностью. История, ради которой он написан:
 * нажатие «Заснул» блокировало поток на секунды, потому что прогноз
 * считался прямо в теле рендера, а кеши расчётов сбрасывались любой
 * записью дневника, включая кормление.
 *
 * Пороги намеренно с запасом: тест должен ловить возврат СЕКУНДНЫХ
 * задержек, а не колебания в десяток миллисекунд от загрузки машины.
 *
 * Запускается копией внутри web/, как и остальные дымовые тесты:
 *
 *   cp ../tools/smoke-perf.mjs ./_p.mjs
 *   node --experimental-default-type=module ./_p.mjs выгрузка.json
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url:"http://localhost/monitor/", pretendToBeVisual:true });
globalThis.window=dom.window; globalThis.document=dom.window.document;
for (const k of ["navigator","HTMLElement","Element","Node","SVGElement","getComputedStyle",
  "requestAnimationFrame","cancelAnimationFrame","CustomEvent","Event","localStorage",
  "MutationObserver","location","history","Blob","URL"]) if(!(k in globalThis)) globalThis[k]=dom.window[k];
globalThis.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
globalThis.fetch=async()=>({ok:false,status:0,json:async()=>({})});
const raw=JSON.parse(readFileSync(process.argv[2],"utf8"));
await new Promise((res,rej)=>{const r=indexedDB.open("baby-tracker",1);
  r.onupgradeneeded=()=>r.result.createObjectStore("kv");
  r.onsuccess=()=>{const tx=r.result.transaction("kv","readwrite");
    tx.objectStore("kv").put({profile:raw.profile,events:raw.events,
      auth:{token:"t",householdId:"h",member:{id:"p",name:"",role:"parent"}},
      rev:0,bias:0,schema:2,profileDirty:false},"state"); tx.oncomplete=res; tx.onerror=rej;};
  r.onerror=rej;});
console.error=()=>{};
const React=(await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("./appbuild.mjs");
createRoot(document.getElementById("root")).render(React.createElement(App));
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
await wait(2500); // даём отложенному расчёту отработать

const btn=(t)=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===t);
const sleepBtn = btn("Заснул") || btn("Проснулся");
let bad = 0;
const check = (label, ok, extra="") => { if(!ok) bad++;
  console.log((ok?"  ок  ":"ПРОВАЛ")+"  "+label+(extra?"  — "+extra:"")); };
check("кнопка сна найдена", Boolean(sleepBtn), sleepBtn?.textContent.trim());

// сколько блокирует САМО нажатие — это и есть ощущаемый лаг
const t0=performance.now();
sleepBtn.click();
const blocked=performance.now()-t0;
await wait(0);
const afterPaint=performance.now()-t0;
check("нажатие не блокирует поток", blocked < 300, `${blocked.toFixed(0)} мс`);
check("разметка обновляется сразу", afterPaint < 400, `${afterPaint.toFixed(0)} мс`);
await wait(3000); // фоновый пересчёт идёт здесь, интерфейс его не ждал

// переключение вкладок при неизменных данных
for (const t of ["Трекер","Здоровье","Сон"]) {
  const b=btn(t); if(!b) continue;
  const s=performance.now(); b.click(); await wait(0);
  const ms=performance.now()-s;
  // данные не менялись — пересчитывать нечего ни на одной вкладке
  check(`вкладка «${t}» без пересчёта`, ms < 400, `${ms.toFixed(0)} мс`);
}

console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : "\nотзывчивость в норме");
process.exit(bad ? 1 : 0);
