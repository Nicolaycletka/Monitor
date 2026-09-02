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
import { IND, medianKg, zOf, valueAt, inRange } from "./growth.js";

/** Период полувыведения из желудка, минуты. */
export const HALF_LIFE = { breast: 47, formula: 65 };

/**
 * Виды кормлений, которые попадают в модель.
 *   breast        — грудь по таймеру, объём оценивается из длительности
 *   left / right  — старые отметки без времени, читаются ради истории
 *   formula       — смесь из бутылочки, объём введён
 *   ebm           — сцеженное грудное молоко из бутылочки, объём введён
 */
const MILK = new Set(["breast", "left", "right", "formula", "ebm"]);

/** Виды, у которых объём известен точно, а не оценивается. */
const MEASURED = new Set(["formula", "ebm"]);

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
/**
 * Дальше какого срока после взвешивания экстраполяция по перцентилю
 * не продолжается, а вес просто держится последним измеренным. Не
 * потому что канал перестаёт быть верным допущением, а потому что
 * два месяца без единого взвешивания — сами по себе повод предложить
 * взвесить ребёнка, а не тянуть кривую всё дальше без проверки.
 */
export const WEIGHT_EXTRAPOLATE_MAX_DAYS = 60;

/**
 * Вес ребёнка сейчас — не последнее измеренное число, а его
 * ПРОЕКЦИЯ вперёд, вдоль того же перцентильного канала ВОЗ.
 *
 * Был баг, обнаруженный на суточном объёме кормления: между
 * взвешиваниями вес держался буквально замороженным на последнем
 * числе, а таблица мл/кг/сут (мета-анализ по возрасту) МОНОТОННО
 * убывает с возрастом на всём диапазоне. Возраст растёт, вес стоит —
 * суточный объём обязан был медленно падать каждый день, даже когда
 * ребёнок нормально растёт. На реальных данных: 711 мл в день
 * взвешивания -> 699 мл десятью днями позже без единого нового
 * измерения, притом что по медиане ВОЗ на том же отрезке возраста
 * объём должен РАСТИ (692 -> 772 мл к четырём месяцам).
 *
 * Экстраполяция вдоль перцентиля — стандартное клиническое допущение:
 * здоровый ребёнок в норме держится примерно одной и той же
 * z-оценки, а не одного и того же веса в кг. Считаем z в момент
 * измерения и проецируем эту же z-оценку на сегодняшний возраст.
 *
 * Если пол не задан или взвешивание за пределами таблицы ВОЗ (совсем
 * недоношенный на старте, к примеру) — используется старое поведение,
 * последнее измеренное значение без изменений: экстраполировать
 * канал, которого не знаем, было бы хуже, чем не экстраполировать
 * вовсе.
 */
export function weightKg(events, birth, sex, now = Date.now()) {
  const w = events
    .filter((e) => e.type === "weight" && !e.deleted && Number.isFinite(e.meta?.g))
    .sort((a, b) => b.start - a.start)[0];

  if (w) {
    const kgMeasured = w.meta.g / 1000;
    const ageAtMeasure = (w.start - birth) / DAY;
    const ageNow = (now - birth) / DAY;
    const gapDays = ageNow - ageAtMeasure;

    if (sex && gapDays > 0 && gapDays <= WEIGHT_EXTRAPOLATE_MAX_DAYS
        && inRange(IND.weight, ageAtMeasure) && inRange(IND.weight, ageNow)) {
      const z = zOf(IND.weight, sex, ageAtMeasure, kgMeasured);
      const projected = z != null ? valueAt(IND.weight, sex, ageNow, z) : null;
      if (projected != null) {
        return { kg: projected, measured: true, extrapolated: true, measuredKg: kgMeasured, z };
      }
    }
    return { kg: kgMeasured, measured: true, extrapolated: false };
  }

  const days = (now - birth) / DAY;
  const m = sex ? medianKg(sex, days) : null;
  return m == null ? null : { kg: m, measured: false, extrapolated: false };
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
/**
 * День считается ПОЛНЫМ, если дневник покрывает оба его края: есть
 * кормление до 9 утра и после 19 вечера. Считать по числу записей
 * нельзя — тогда «мало кормлений» и «мало отмечено» неразличимы,
 * а именно неполные дни и занижают медиану, из-за чего оценка
 * порции завышалась.
 */
function isFullDay(events, from) {
  let early = false, late = false;
  for (const e of events) {
    if (!isMilk(e) || e.deleted || e.start < from || e.start >= from + DAY) continue;
    const h = new Date(e.start).getHours();
    if (h < 9) early = true;
    if (h >= 19) late = true;
  }
  return early && late;
}

export function typicalFeedCount(events, now = Date.now(), manual = null) {
  if (Number.isFinite(manual) && manual > 0) return Math.min(Math.max(manual, 3), 20);
  const periods = illnessPeriods(events);
  const today = startOfDay(now);
  const counts = [];
  for (let i = 1; i <= 7; i += 1) {
    const from = today - i * DAY;
    if (isSickAt(from + DAY / 2, periods)) continue;
    if (!isFullDay(events, from)) continue;
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
/**
 * Объём одного кормления. По умолчанию — суточный бюджет по возрасту
 * и весу, делённый на медиану числа кормлений. Если задано `pumpMl` —
 * измеренный объём сцеживания одной груди утром — он становится
 * основой оценки напрямую (см. пояснение и оговорки в App.jsx рядом
 * с полем ввода): это не пересчёт по формуле, а замена расчётной
 * величины на измеренную, ровно как просил родитель.
 */
export function perFeedMl(events, birth, sex, now = Date.now(), manualFeeds = null, pumpMl = null) {
  const w = weightKg(events, birth, sex, now);
  if (!w) return null;
  const n = typicalFeedCount(events, now, manualFeeds) || 8;
  const refMin = typicalFeedMinutes(events, now);
  const daily = dailyMl(w.kg, (now - birth) / DAY);
  const computedMl = daily / n;
  const pumpBased = Number.isFinite(pumpMl) && pumpMl > 0;
  const ml = pumpBased ? pumpMl : computedMl;
  return {
    ml: Math.min(Math.max(ml, 20), 250),
    feeds: n,
    kg: w.kg,
    measured: w.measured,
    manual: Number.isFinite(manualFeeds) && manualFeeds > 0,
    refMin,
    daily,
    computedMl: Math.min(Math.max(computedMl, 20), 200),
    pumpBased,
  };
}

/** Объём конкретного кормления: для смеси — введённый, иначе оценка. */
/**
 * Постоянная времени молокоотдачи, минуты.
 *
 * Молоко уходит не равномерно: основная часть передаётся в первые
 * минуты, дальше кривая выполаживается. Форма взята как насыщающая
 * экспонента `1 − exp(−t/τ)`. τ = 4 мин подобрана так, чтобы к 10.5
 * минутам — средней длительности кормления в исследовании с
 * контрольным взвешиванием доношенных — передавалось около 93 %
 * от полного объёма.
 *
 * Сам масштаб из литературы НЕ берётся. В том же исследовании при
 * средних 119.5 г на кормление разброс был 34–222 г, то есть
 * шестикратный. Поэтому из литературы взята только форма кривой,
 * а величина — собственная оценка ребёнка (суточный бюджет, делённый
 * на число кормлений). Кормление типичной длительности даёт ровно
 * типичный объём, короткое — меньше, длинное — чуть больше.
 */
export const LETDOWN_TAU = 4;

/** Длительность кормления грудью, минуты, или null. */
export const feedMinutes = (e) =>
  Number.isFinite(e.meta?.sec) ? e.meta.sec / 60
    : e.end && e.end > e.start ? (e.end - e.start) / MIN
    : null;

/**
 * Объём кормления грудью по длительности. `ref` — своя медианная
 * длительность: при ней возвращается ровно `typical`, чтобы оценка
 * была привязана к собственным данным, а не к чужой средней.
 */
export function breastVolume(minutes, typical, ref) {
  if (!(minutes > 0)) return typical;
  const shape = (t) => 1 - Math.exp(-t / LETDOWN_TAU);
  const base = shape(Math.min(Math.max(ref || 10.5, 3), 30));
  return typical * (shape(Math.min(minutes, 40)) / base);
}

export const volumeOf = (e, typical, refMin) => {
  if (MEASURED.has(e.meta?.kind) && Number.isFinite(e.meta?.ml)) return e.meta.ml;
  const min = feedMinutes(e);
  return min == null ? typical : breastVolume(min, typical, refMin);
};

/**
 * Съеденный объём за сутки, мл. Использует ТЕ ЖЕ typical/refMin, что
 * и остальная модель (perFeedMl), а не пересчитывает их заново на
 * каждый день недели — иначе цифры за разные дни считались бы разными
 * весами и были бы несравнимы между собой.
 *
 * Вода и прикорм не входят: объём воды не переводится в мл надёжно
 * (её не приходится оценивать по длительности), а прикорм не имеет
 * общей единицы измерения с молоком.
 */
export function dayFeedMl(events, dayStart, typicalMl, refMin) {
  const dayEnd = dayStart + DAY;
  let ml = 0, n = 0;
  for (const e of events) {
    if (!isMilk(e) || e.deleted) continue;
    if (e.start < dayStart || e.start >= dayEnd) continue;
    ml += volumeOf(e, typicalMl, refMin);
    n += 1;
  }
  return { ml: Math.round(ml), n };
}

// сцеженное молоко опорожняется как грудное, а не как смесь
const halfLifeOf = (e) => (e.meta?.kind === "formula" ? HALF_LIFE.formula : HALF_LIFE.breast);

/** Своя медианная длительность кормления грудью, минуты. */
export function typicalFeedMinutes(events, now = Date.now()) {
  const xs = events
    .filter((e) => isMilk(e) && !e.deleted && !MEASURED.has(e.meta?.kind) && e.start >= now - 14 * DAY)
    .map(feedMinutes)
    .filter((x) => x != null && x >= 1 && x <= 45)
    .sort((a, b) => a - b);
  if (xs.length < 3) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Сколько мл остаётся в желудке к моменту ts. */
export function stomachAt(events, ts, typical, refMin = null) {
  let sum = 0;
  for (const e of events) {
    if (!isMilk(e) || e.deleted || e.start > ts) continue;
    const mins = (ts - e.start) / MIN;
    if (mins > 480) continue; // за 8 часов остаётся меньше промилле
    sum += volumeOf(e, typical, refMin) * Math.pow(0.5, mins / halfLifeOf(e));
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
export function predictFeed(events, birth, sex, now = Date.now(), manualFeeds = null, pumpMl = null) {
  const typical = perFeedMl(events, birth, sex, now, manualFeeds, pumpMl);
  if (!typical) return null;

  const milk = events.filter((e) => isMilk(e) && !e.deleted).sort((a, b) => a.start - b.start);
  const lastFeed = milk.length ? milk[milk.length - 1] : null;
  if (!lastFeed) return { typical, lastFeed: null, empty: true };

  const level = stomachAt(events, now, typical.ml, typical.refMin);
  const target = READY_FRACTION * typical.ml;

  let readyAt = now;
  if (level > target) {
    // шаг в 5 минут: точность модели такова, что минуты бессмысленны
    for (let t = now; t <= now + 8 * 3600000; t += 5 * MIN) {
      if (stomachAt(events, t, typical.ml, typical.refMin) <= target) { readyAt = t; break; }
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
export function feedNotify(events, birth, sex, now = Date.now(), manualFeeds = null, pumpMl = null) {
  const p = predictFeed(events, birth, sex, now, manualFeeds, pumpMl);
  if (!p || p.empty || p.stale || p.asleep) return null;
  if (!isDaytime(p.dueAt)) return null;
  if (p.dueAt < now - 60 * MIN) return null;
  return { at: p.dueAt, sinceLabel: Math.round(p.gapMin) };
}
