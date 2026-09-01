import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
const dom=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:"http://localhost/monitor/",pretendToBeVisual:true});
globalThis.window=dom.window; globalThis.document=dom.window.document;
for(const k of ["navigator","HTMLElement","Element","Node","SVGElement","getComputedStyle","requestAnimationFrame","cancelAnimationFrame","CustomEvent","Event","localStorage","MutationObserver","location","history"])
  if(!(k in globalThis)) globalThis[k]=dom.window[k];
globalThis.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
globalThis.fetch=async()=>({ok:false,status:0,json:async()=>({})});
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
await new Promise(r=>setTimeout(r,1000));
console.log("СЕЙЧАС:", document.getElementById("root").textContent.slice(0,300));
console.log("errs:", errs.length);
if (errs.length) console.log(errs[0].slice(0,1500));

// переключаемся на «Здоровье»/уже открыта «Сон» — кликнем «Неделя» и «Бутылочка», проверим маркеры
const click=(t)=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim().startsWith(t));if(b)b.click();return !!b;};
click("Неделя"); await new Promise(r=>setTimeout(r,300));
const weekHtml = document.getElementById("root").innerHTML;
console.log("\nнеделя: колонка еды присутствует ('week-food'):", weekHtml.includes("week-food"));
console.log("неделя: столбец еды показывает мл/×:", /week-food[^>]*>[^<]*(мл|×|—)/.test(weekHtml));

click("Сейчас"); await new Promise(r=>setTimeout(r,200));
click("Бутылочка"); await new Promise(r=>setTimeout(r,200));
const bh = document.getElementById("root").innerHTML;
console.log("\nбутылочка: 'Молоко' есть:", bh.includes("Молоко"), "| 'Вода' есть:", bh.includes(">Вода<"));

click("Подгузник");
