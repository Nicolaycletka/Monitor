/* Сравнение двух вариантов алгоритма на реальных данных.
 *
 *   node --experimental-default-type=module ../tools/ab-test.mjs выгрузка.json \
 *     'const tableKey = opts.table || "app";' 'const tableKey = opts.table || "huck";'
 *
 * Подменяет строку в sleep.js и прогоняет walk-forward оба варианта.
 *
 * ВАЖНО про статистику. Сводные цифры (процент попаданий, медиана
 * ошибки) на 60 наблюдениях обманчивы: разница в 4 минуты между
 * медианами уже случалась чисто от того, куда попала середина
 * распределения. Поэтому здесь считается ПАРНАЯ разница — для каждого
 * сна сравниваются ошибки обоих вариантов, — и знаковый критерий.
 * Пока z < 1.96, различия нет, как бы убедительно ни выглядели
 * сводные цифры.
 */
import { readFileSync } from "node:fs";
import { runBacktest, summarize, median } from "./backtest.mjs";

const [file, from, to] = process.argv.slice(2);
if (!file || !from || !to) {
  console.error("нужно: файл.json 'что заменить' 'на что'");
  process.exit(1);
}
const SRC = readFileSync(new URL("../web/src/sleep.js", import.meta.url), "utf8");
if (!SRC.includes(from)) { console.error("строка не найдена в sleep.js"); process.exit(1); }
const load = (src) => import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const raw = JSON.parse(readFileSync(file, "utf8"));
const ev = raw.events.filter((e) => !e.deleted);
const birth = raw.profile.birth;

const A = runBacktest(await load(SRC), ev, birth);
const B = runBacktest(await load(SRC.replace(from, to)), ev, birth);

const show = (n, rows) => {
  const s = summarize(rows);
  console.log(`${n.padEnd(10)} попаданий ${(s.hit * 100).toFixed(0).padStart(3)}%  |ош| ${s.mae.toFixed(0).padStart(3)} мин  сдвиг ${(s.bias > 0 ? "+" : "") + s.bias.toFixed(0)}`);
};
show("было", A);
show("стало", B);

const n = Math.min(A.length, B.length);
let better = 0, worse = 0; const diffs = [];
for (let i = 0; i < n; i++) {
  const a = Math.abs(A[i].err), b = Math.abs(B[i].err);
  diffs.push(a - b);
  if (b < a - 0.5) better++; else if (b > a + 0.5) worse++;
}
const m = better + worse;
const z = m ? (Math.abs(better - worse) - 1) / Math.sqrt(m) : 0;
console.log(`\nпарно (n=${n}): стало ближе ${better}, дальше ${worse}`);
console.log(`медиана парной разницы: ${median(diffs).toFixed(1)} мин`);
console.log(z > 1.96 ? `z = ${z.toFixed(2)} — различие устойчиво`
                     : `z = ${z.toFixed(2)} — различие НЕ отличимо от случайности`);
