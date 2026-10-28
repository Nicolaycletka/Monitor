/* Оценка алгоритма прогноза на реальной выгрузке.
 *
 *   node --experimental-default-type=module ../tools/evaluate.mjs выгрузка.json
 *
 * Walk-forward: для каждого дневного сна прогноз строится ТОЛЬКО по
 * данным строго до него, подглядывания в будущее нет. Считает
 * попадания в окно, медиану ошибки, систематический сдвиг, сравнивает
 * с простыми правилами и показывает собственный разброс ребёнка —
 * тот самый потолок, выше которого не поднимется никакая модель.
 *
 * Запускать при каждом заметном изменении алгоритма и просто по мере
 * накопления данных: то, что верно на двух неделях и 57 наблюдениях,
 * может оказаться неверным на двух месяцах.
 */
import { readFileSync } from "node:fs";
import { loadModule, runBacktest, summarize, median } from "./backtest.mjs";

const file = process.argv[2];
if (!file) { console.error("укажите файл выгрузки"); process.exit(1); }
const raw = JSON.parse(readFileSync(file, "utf8"));
const ev = raw.events.filter((e) => !e.deleted);
const birth = raw.profile.birth;

const S = await loadModule();
const rows = runBacktest(S, ev, birth);
const s = summarize(rows);

console.log(`наблюдений: ${s.n}`);
console.log(`попаданий в окно: ${(s.hit * 100).toFixed(0)}%`);
console.log(`медиана |ошибки|: ${s.mae.toFixed(0)} мин`);
console.log(`систематический сдвиг: ${s.bias > 0 ? "+" : ""}${s.bias.toFixed(0)} мин`);
console.log(`ширина окна: ${Math.round(median(rows.map((r) => r.width)))} мин`);

const sleeps = S.mergeSleeps(S.healthySleeps(ev), birth).sort((a, b) => a.start - b.start);
const awake = [];
for (let i = 1; i < sleeps.length; i++) {
  const cur = sleeps[i], prev = sleeps[i - 1];
  if (S.isNightSleep(cur) || cur.meta?.settle === "external") continue;
  const a = (cur.start - prev.end) / 60000;
  if (a > 5 && a < 360) awake.push(a);
}
const m = median(awake);
const spread = median(awake.map((x) => Math.abs(x - m)));
console.log(`\nсобственный разброс ребёнка: ${Math.round(spread)} мин вокруг медианы ${Math.round(m)} мин`);
console.log(spread >= s.mae * 0.85
  ? "Модель у потолка: её ошибка сравнима с разбросом самого ребёнка.\nТочность здесь упирается не в алгоритм, а в данные."
  : "Есть запас: ошибка модели заметно больше собственного разброса ребёнка.");
