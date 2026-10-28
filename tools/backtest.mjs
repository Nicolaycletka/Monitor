/* Walk-forward: для каждого ДНЕВНОГО сна прогноз строится только по
 * данным строго до него. Никакого подглядывания в будущее. */
import { readFileSync } from "node:fs";

export async function loadModule(patch = {}) {
  let src = readFileSync("/home/claude/bt/baby-tracker/web/src/sleep.js", "utf8");
  for (const [k, v] of Object.entries(patch)) {
    const re = new RegExp(`export const ${k} = [^;]+;`);
    if (!re.test(src)) throw new Error(`не найдена константа ${k}`);
    src = src.replace(re, `export const ${k} = ${v};`);
  }
  const b64 = Buffer.from(src).toString("base64");
  return import(`data:text/javascript;base64,${b64}`);
}

export function runBacktest(S, events, birth) {
  const sleeps = S.mergeSleeps(S.healthySleeps(events), birth).sort((a,b)=>a.start-b.start);
  const rows = [];
  for (let i = 1; i < sleeps.length; i++) {
    const cur = sleeps[i];
    if (S.isNightSleep(cur)) continue;
    if (cur.meta?.settle === "external") continue;  // не оценка прогноза
    const before = sleeps.slice(0, i);
    const w = S.predictNext(before, birth, cur.start - 1, 0);
    if (!w) continue;
    const mid = (w.from + w.to) / 2;
    rows.push({
      at: cur.start,
      err: (cur.start - mid) / 60000,          // + значит заснул позже прогноза
      hit: cur.start >= w.from && cur.start <= w.to,
      width: (w.to - w.from) / 60000,
      settle: cur.meta?.settle || null,
    });
  }
  return rows;
}

export const median = (a) => { if(!a.length) return NaN;
  const s=[...a].sort((x,y)=>x-y); const m=s.length>>1;
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
export const summarize = (rows) => ({
  n: rows.length,
  hit: rows.length ? rows.filter(r=>r.hit).length / rows.length : NaN,
  mae: median(rows.map(r=>Math.abs(r.err))),
  bias: median(rows.map(r=>r.err)),
});
