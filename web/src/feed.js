/**
 * Модель наполнения желудка — «когда ребёнка МОЖНО покормить».
 *
 * Важно с самого начала: это не предсказание голода. Приложение видит
 * момент кормления, а не момент, когда ребёнок захотел есть, — ровно
 * та же разница, что между «уснул» и «был готов уснуть», которую в
 * прогнозе сна пришлось лечить метками укладывания. Голод зависит не
 * только от того, пуст ли желудок, и модели этого не знают.
 *
 * Зато «есть ли в желудке место» — вопрос физиологический и считаемый.
 * Поэтому все формулировки в интерфейсе разрешительные («можно»),
 * а не повелительные («пора»). Кормление по требованию — то, что
 * рекомендуют, и приложение не должно его подменять расписанием:
 * сигналы ребёнка точнее любого расчёта, а при ГВ выработка молока
 * зависит от спроса, и кормление по будильнику может ей мешать.
 *
 * Что считается и откуда числа:
 *
 * 1. ОПОРОЖНЕНИЕ. Содержимое желудка убывает экспоненциально, период
 *    полувыведения зашит константой. Дыхательный тест с 13C-октановой
 *    кислотой у доношенных: грудное молоко 47 мин (разброс 16–86),
 *    смесь 65 мин (27–98). Разброс огромный — поэтому модель даёт
 *    порядок величины, а не минуты.
 *
 * 2. ОБЪЁМ КОРМЛЕНИЯ. Для смеси он введён руками. Для груди его никто
 *    не знает, и это главная слабость модели. Оцениваем так: суточный
 *    объём (мл/кг/сут по возрасту, умноженные на вес ребёнка из
 *    вкладки «Вес») делим на СОБСТВЕННУЮ медиану числа кормлений за
 *    сутки. То есть вес и вправду попадает в расчёт — но через
 *    суточный бюджет, а не через «объём желудка»: последний в
 *    литературе разбросан так, что опираться на него нельзя.
 *
 *    Мета-анализ 167 исследований, здоровые доношенные на
 *    исключительном ГВ: 135 мл/кг/сут в 1 месяц, 126 в 3 месяца,
 *    107 в 6 месяцев, 61 в 12. В абсолюте это 624 / 735 / 729 /
 *    593 мл в сутки — то самое плато между 1 и 6 месяцами.
 *
 * 3. ПОЛНОТА ДНЕВНИКА. Пропуск в записях сам по себе ничего не
 *    значит: то ли не кормили, то ли не отметили. Но если промежуток
 *    закрыт отмеченным СНОМ — мы знаем, что ребёнок не ел, и
 *    промежуток настоящий. Отсюда `coverage`: доля времени с
 *    последнего кормления, покрытая сном. Низкая доля при длинном
 *    промежутке = дневник, скорее всего, неполный, и напоминание
 *    подавляется, чтобы не кричать о кормлении, которое было.
 *
 * 4. КОРОТКАЯ ПАМЯТЬ. Через три периода полувыведения от прошлого
 *    кормления остаётся около 12 %, через четыре — 6 %. Значит
 *    состояние «до пропуска» забывается за 2.5–3 часа само собой,
 *    и одного отмеченного кормления достаточно, чтобы расчёт снова
 *    стал осмысленным. Это главное, что делает функцию пригодной
 *    при неполном дневнике.
 *
 * Обучения на собственных предсказаниях здесь НЕТ намеренно. Все
 * параметры — физиологические константы, единственное личное число
 * (медиана числа кормлений) берётся из фактических записей. Иначе
 * получилась бы та же петля обратной связи, что и с окнами сна:
 * приложение предложило время, родитель покормил, приложение
 * измерило собственный сдвиг как факт о ребёнке.
 */

import { MIN, DAY, startOfDay, illnessPeriods, isSickAt } from "./sleep.js";
import { medianKg } from "./growth.js";

/** Период полувыведения из желудка, минуты. */
export const HALF_LIFE = { breast: 47, formula: 65 };

/** Виды кормлений, которые вообще попадают в модель. */
const MILK = new Set(["left", "right", "formula"]);

/**
 * Прикорм и вода в модель не входят. Вода занимает объём, но уходит
 * быстро; твёрдая пища, наоборот, заметно тормозит опорожнение — и
 * то и другое требует своих констант, которых у нас нет. Пока
 * ребёнок на молоке, это не мешает; после введения прикорма модель
 * станет заметно хуже, и это надо будет чинить, а не игнорировать.
 */
export const isMilk = (e) => e.type === "feed" && MILK.has(e.meta?.kind);

/** Суточный объём, мл/кг/сут, по возрасту в днях. */
const PER_KG = [[30, 135], [91, 126], [183, 107], [365, 61]];

export function mlPerKg(ageDays) {
  if (ageDays <= PER_KG[0][0]) return PER_KG[0][1];
  const last = PER_KG[PER_KG.length - 1];
  if (ageDays >= last[0]) return last[1];
  for (let i = 1; i < PER_KG.length; i += 1) {
    const [d0, v0] = PER_KG[i - 1];
    const [d1, v1] = PER_KG[i];
    if (ageDays <= d1) return v0 + ((ageDays - d0) / (d1 - d0)) * (v1 - v0);
  }
  return last[1];
}

/**
 * Вес ребёнка: последнее взвешивание, а если его нет — медиана ВОЗ
 * для возраста и пола. Подстановка медианы честнее, чем отказ считать:
 * ошибка в весе входит в оценку линейно, и промах в полкило меняет
 * объём кормления процентов на десять, что тонет в разбросе
 * опорожнения. Но в интерфейсе это оговаривается.
 */
export function weightKg(events, birth, sex, now = Date.now()) {
  const w = events
    .filter((e) => e.type === "weight" && !e.deleted && Number.isFinite(e.meta?.g))
    .sort((a, b) => b.start - a.start)[0];
  if (w) return { kg: w.meta.g / 1000, measured: true };
  const days = (now - birth) / DAY;
  const m = sex ? medianKg(sex, days) : null;
  return m == null ? null : { kg: m, measured: false };
}

/** Суточный бюджет, мл. */
export const dailyMl = (kg, ageDays) => kg * mlPerKg(ageDays);

/**
 * Медиана числа молочных кормлений за сутки за последнюю неделю.
 * Сегодняшний день не в счёт (не закончился), дни болезни тоже —
 * во время болезни ребёнок ест иначе, и запоминать это как норму
 * не надо (та же логика, что в обучении прогноза сна).
 * Дни без единой записи выбрасываются: это дырка в дневнике,
 * а не сутки без еды.
 */
export function typicalFeedCount(events, now = Date.now()) {
  const periods = illnessPeriods(events);
  const today = startOfDay(now);
  const counts = [];
  for (let i = 1; i <= 7; i += 1) {
    const from = today - i * DAY;
    if (isSickAt(from + DAY / 2, periods)) continue;
    const n = events.filter(
      (e) => isMilk(e) && !e.deleted && e.start >= from && e.start < from + DAY
    ).length;
    if (n > 0) counts.push(n);
  }
  if (!counts.length) return null;
  counts.sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const med = counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  return Math.min(Math.max(med, 4), 14);
}

/** Оценка объёма одного кормления, мл. */
export function perFeedMl(events, birth, sex, now = Date.now()) {
  const w = weightKg(events, birth, sex, now);
  if (!w) return null;
  const n = typicalFeedCount(events, now) || 8;
  const ml = dailyMl(w.kg, (now - birth) / DAY) / n;
  return {
    ml: Math.min(Math.max(ml, 20), 200),
    feeds: n,
    kg: w.kg,
    measured: w.measured,
    daily: dailyMl(w.kg, (now - birth) / DAY),
  };
}

/** Объём конкретного кормления: для смеси — введённый, иначе оценка. */
const volumeOf = (e, typical) =>
  e.meta?.kind === "formula" && Number.isFinite(e.meta?.ml) ? e.meta.ml : typical;

const halfLifeOf = (e) => (e.meta?.kind === "formula" ? HALF_LIFE.formula : HALF_LIFE.breast);

/** Сколько мл остаётся в желудке к моменту ts. */
export function stomachAt(events, ts, typical) {
  let sum = 0;
  for (const e of events) {
    if (!isMilk(e) || e.deleted || e.start > ts) continue;
    const mins = (ts - e.start) / MIN;
    if (mins > 480) continue; // за 8 часов остаётся меньше промилле
    sum += volumeOf(e, typical) * Math.pow(0.5, mins / halfLifeOf(e));
  }
  return sum;
}

/**
 * Доля «свободного» желудка, ниже которой считаем, что ребёнок
 * возьмёт полноценное кормление. Четверть типичного объёма — это
 * два периода полувыведения от полного желудка, около полутора
 * часов при ГВ. Число — соглашение, не измеренная величина.
 */
export const READY_FRACTION = 0.25;

/** Доля интервала, покрытая отмеченным сном. */
export function sleepCoverage(events, from, to) {
  if (to <= from) return 1;
  let covered = 0;
  for (const e of events) {
    if (e.type !== "sleep" || e.deleted) continue;
    const a = Math.max(e.start, from);
    const b = Math.min(e.end ?? Date.now(), to);
    if (b > a) covered += b - a;
  }
  return Math.min(covered / (to - from), 1);
}

/** Медиана промежутка между кормлениями за неделю, минуты. */
export function ownInterval(events, now = Date.now()) {
  const periods = illnessPeriods(events);
  const list = events
    .filter((e) => isMilk(e) && !e.deleted && e.start >= now - 7 * DAY && !isSickAt(e.start, periods))
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) {
    const g = (list[i].start - list[i - 1].start) / MIN;
    // короче 15 минут — одно кормление, записанное дважды (левая/правая);
    // длиннее 6 часов — ночь или дырка в дневнике, не характеристика ребёнка
    if (g >= 15 && g <= 360) gaps.push(g);
  }
  if (gaps.length < 4) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.min(Math.max(med, 60), 240);
}

/** Границы «дневного времени» для напоминаний. */
export const DAY_FROM_HOUR = 7;
export const DAY_TO_HOUR = 22;

export const isDaytime = (ts) => {
  const h = new Date(ts).getHours();
  return h >= DAY_FROM_HOUR && h < DAY_TO_HOUR;
};

/**
 * Промежуток без кормлений, после которого считаем дневник неполным,
 * если он не закрыт сном. Полтора часа бодрствования без единой
 * записи в разгар дня — почти наверняка не отмеченное кормление,
 * а не голодающий ребёнок.
 */
export const UNLOGGED_AWAKE_MIN = 90;

/**
 * Основной расчёт. Возвращает null, если считать не из чего.
 *
 * readyAt — когда желудок освободится настолько, что ребёнок возьмёт
 *           полноценное кормление;
 * dueAt   — момент напоминания: не раньше readyAt и не раньше, чем
 *           пройдёт собственный типичный промежуток. Без второго
 *           условия напоминание приходило бы каждые полтора часа.
 */
export function predictFeed(events, birth, sex, now = Date.now()) {
  const typical = perFeedMl(events, birth, sex, now);
  if (!typical) return null;

  const milk = events.filter((e) => isMilk(e) && !e.deleted).sort((a, b) => a.start - b.start);
  const lastFeed = milk.length ? milk[milk.length - 1] : null;
  if (!lastFeed) return { typical, lastFeed: null, empty: true };

  const level = stomachAt(events, now, typical.ml);
  const target = READY_FRACTION * typical.ml;

  let readyAt = now;
  if (level > target) {
    // шаг в 5 минут: точность модели такова, что минуты бессмысленны
    for (let t = now; t <= now + 8 * 3600000; t += 5 * MIN) {
      if (stomachAt(events, t, typical.ml) <= target) { readyAt = t; break; }
      readyAt = t;
    }
  }

  const interval = ownInterval(events, now);
  const dueAt = Math.max(readyAt, lastFeed.start + (interval || 150) * MIN);

  const gapMin = (now - lastFeed.start) / MIN;
  const coverage = sleepCoverage(events, lastFeed.start, now);
  const awakeUnlogged = gapMin * (1 - coverage);
  const stale =
    gapMin > 1.5 * (interval || 150) && awakeUnlogged > UNLOGGED_AWAKE_MIN;

  const asleep = events.some((e) => e.type === "sleep" && !e.end && !e.deleted);

  return {
    typical,
    lastFeed,
    level,
    target,
    fill: Math.min(level / typical.ml, 1),
    readyAt,
    dueAt,
    interval,
    gapMin,
    coverage,
    awakeUnlogged,
    stale,
    asleep,
    // напоминание попадает на ночь — показываем это, но не шлём
    nightly: !isDaytime(dueAt),
    readyNow: readyAt <= now,
    empty: false,
  };
}

/**
 * Напоминание для Telegram: время и текст, либо null.
 *
 * Подавляется, если:
 *   - ребёнок спит сейчас (разбудить напоминанием — худшее, что
 *     может сделать это приложение);
 *   - момент попадает на ночь;
 *   - дневник, похоже, неполный;
 *   - момент уже прошёл больше часа назад (клиент давно не открывали).
 */
export function feedNotify(events, birth, sex, now = Date.now()) {
  const p = predictFeed(events, birth, sex, now);
  if (!p || p.empty || p.stale || p.asleep) return null;
  if (!isDaytime(p.dueAt)) return null;
  if (p.dueAt < now - 60 * MIN) return null;
  return { at: p.dueAt, sinceLabel: Math.round(p.gapMin) };
}
