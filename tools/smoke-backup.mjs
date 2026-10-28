/* Проверка, что резервная копия ПРИГОДНА ДЛЯ ВОССТАНОВЛЕНИЯ.
 *
 *   node --experimental-default-type=module ../tools/smoke-backup.mjs копия.json
 *
 * Мало проверить, что файл отправился: копия может уйти, выглядеть
 * целой и не содержать главного. Ровно это и случилось при разработке —
 * в копию не попала дата рождения, потому что данные брались из узкой
 * строки `req.household` (там только id и name). Файл был на месте, вес
 * правдоподобный, а восстановить по нему дневник было нельзя.
 *
 * Поэтому здесь копия скармливается ТОМУ ЖЕ коду, что считает прогноз
 * в приложении: если прогноз считается — копия рабочая.
 */
import { readFileSync } from "node:fs";
const dump = JSON.parse(readFileSync(process.argv[2] || "dump.json","utf8"));
const S = await import("/home/claude/bt/baby-tracker/web/src/sleep.js");
let bad=0; const check=(l,c,e="")=>{if(!c)bad++;console.log((c?"  ок  ":"ПРОВАЛ")+"  "+l+(e?"  — "+e:""));};
check("есть профиль с датой рождения", Number.isFinite(dump.profile?.birth));
check("есть события", Array.isArray(dump.events) && dump.events.length>0, `${dump.events?.length}`);
const ev = dump.events.filter(e=>!e.deleted);
check("поля событий как в приложении", ev.every(e=>e.id&&e.type&&Number.isFinite(e.start)));
const w = S.predictNext(ev, dump.profile.birth, Date.now(), 0);
check("прогноз считается по копии", Boolean(w?.from), w? new Date(w.from).toLocaleTimeString("ru-RU"):"—");
const sleeps = ev.filter(e=>e.type==="sleep").length;
check("сны на месте", sleeps>0, `${sleeps} снов`);
console.log(bad?`\nПРОВАЛЕНО: ${bad}`:"\nкопия пригодна для восстановления");
