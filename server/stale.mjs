import { rmSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
const DIR="/tmp/stale"; rmSync(DIR,{recursive:true,force:true}); mkdirSync(DIR,{recursive:true});
process.env.DATA_DIR=DIR; process.env.PORT="8096"; process.env.STATIC_DIR=DIR;
await import("./index.js"); await new Promise(r=>setTimeout(r,400));
const API="http://127.0.0.1:8096/api", j=r=>r.json();
const {token}=await fetch(`${API}/household`,{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({name:"В",birth:Date.now()-101*86400000,sex:"f"})}).then(j);
const sync=b=>fetch(`${API}/sync`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},
 body:JSON.stringify({since:0,events:[],...b})}).then(j);
const db=new Database(`${DIR}/tracker.db`);
const row=()=>db.prepare("SELECT at,sent FROM notifications WHERE kind='feed'").get();

await sync({notify:{feed:{at:Date.now()+180000,text:"🍼 можно кормить",guardType:"feed",guardAfter:Date.now()}}});
console.log("1. поставили будущий пуш:", row());

// клиент пересчитал и получил "просрочено" (dueAt в прошлом) — старая
// схема слала бы это как no-op и старая запись осталась бы висеть
await sync({notify:{feed:{at:Date.now()-600000,text:"устарело",guardType:"feed",guardAfter:Date.now()}}});
console.log("2. пересчитан как просроченный ->", row() || "СНЯТО (верно)");

// то же самое, если ребёнок уснул: клиент явно шлёт null
await sync({notify:{sleep:{at:Date.now()+180000,text:"тест"},feed:null}});
await sync({notify:{feed:null}});
console.log("3. явный null (уснул) ->", row() || "СНЯТО (верно)");
process.exit(0);
