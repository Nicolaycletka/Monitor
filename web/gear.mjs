import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
const dom=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:"http://localhost/monitor/",pretendToBeVisual:true});
globalThis.window=dom.window; globalThis.document=dom.window.document;
for(const k of ["navigator","HTMLElement","Element","Node","SVGElement","getComputedStyle","requestAnimationFrame","cancelAnimationFrame","CustomEvent","Event","localStorage","MutationObserver","location","history"])
  if(!(k in globalThis)) globalThis[k]=dom.window[k];
globalThis.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
globalThis.fetch=async(url)=>({ok:false,status:0,json:async()=>({})});
const raw=JSON.parse(readFileSync("/mnt/user-data/uploads/sleep-2026-08-30__1_.json","utf8"));
await new Promise((res,rej)=>{const r=indexedDB.open("baby-tracker",1);
 r.onupgradeneeded=()=>r.result.createObjectStore("kv");
 r.onsuccess=()=>{const t=r.result.transaction("kv","readwrite");
  t.objectStore("kv").put({profile:raw.profile,events:raw.events,auth:{token:"t",householdId:"h"},rev:0,bias:0,schema:2,profileDirty:false},"state");
  t.oncomplete=res;t.onerror=rej;};r.onerror=rej;});
let errs=[]; const oe=console.error; console.error=(...a)=>{errs.push(a.map(String).join(" "));oe(...a);};
const React=(await import("react")).default;
const {createRoot}=await import("react-dom/client");
const {default:App}=await import("./appbuild.mjs");
createRoot(document.getElementById("root")).render(React.createElement(App));
await new Promise(r=>setTimeout(r,900));

const click=(t)=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim().startsWith(t));if(b){b.click();return true;}return false;};
console.log("клик по шестерёнке:", document.querySelector(".gear-b") ? "найдена, кликаю" : "НЕ НАЙДЕНА");
document.querySelector(".gear-b")?.click();
await new Promise(r=>setTimeout(r,300));
const html = document.getElementById("root").innerHTML;
console.log("модалка открылась:", html.includes("Настройки") && html.includes("settings-sheet"));
console.log("содержит 'Второй родитель':", html.includes("Второй родитель"));
console.log("содержит 'ПДР':", html.includes(">ПДР<"));
console.log("содержит кормлений в сутки вручную:", html.includes("Кормлений в сутки вручную"));
console.log("содержит переключатели уведомлений (Вехи развития):", html.includes("Вехи развития"));
console.log("содержит резервную копию:", html.includes("Скачать резервную копию"));

click("Готово");
await new Promise(r=>setTimeout(r,200));
console.log("\nмодалка закрылась:", !document.getElementById("root").innerHTML.includes("settings-sheet"));

click("Неделя");
await new Promise(r=>setTimeout(r,300));
const weekHtml = document.getElementById("root").innerHTML;
console.log("\nв Неделе БОЛЬШЕ НЕТ 'Второй родитель':", !weekHtml.includes("Второй родитель"));
console.log("в Неделе БОЛЬШЕ НЕТ кнопки 'Поделиться ссылкой':", !weekHtml.includes("Поделиться ссылкой"));
console.log("в Неделе остались аналитические карточки (Точность прогноза):", weekHtml.includes("Точность прогноза"));
console.log("в Неделе остались Вехи развития (обзор):", weekHtml.includes("Пройдено вех"));
console.log("errs:", errs.length);
if(errs.length) console.log(errs[0].slice(0,1000));
