export const MIN = 60000;
export const DAY = 86400000;

export const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const hhmm = (ts) =>
  new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

export function dur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h === 0 ? `${r} мин` : `${h}:${String(r).padStart(2, "0")}`;
}

export function durShort(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}м`;
  if (r === 0) return `${h}ч`;
  return `${h}ч ${r}м`;
}

export function ageText(birth, now) {
  if (!birth) return "";
  const days = Math.floor((now - birth) / DAY);
  if (days < 56) {
    const w = Math.floor(days / 7);
    const d = days % 7;
    return d ? `${w} нед ${d} дн` : `${w} нед`;
  }
  const b = new Date(birth);
  const n = new Date(now);
  let months = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
  const anchor = new Date(b);
  anchor.setMonth(b.getMonth() + months);
  if (anchor > n) months -= 1;
  anchor.setMonth(b.getMonth() + months);
  const rest = Math.floor((n - anchor) / DAY);
  return rest ? `${months} мес ${rest} дн` : `${months} мес`;
}

export const ageMonths = (birth, now) => (now - birth) / (DAY * 30.44);

export const dayLabel = (ts) => {
  const t = startOfDay(Date.now());
  if (ts === t) return "Сегодня";
  if (ts === t - DAY) return "Вчера";
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};

/* ------------------------------------------------------------------ */
/*  Нормы                                                              */
/* ------------------------------------------------------------------ */

/**
 * Окна бодрствования, минуты. Сведены из открытых таблиц Huckleberry
 * и Happiest Baby. Это эвристика консультантов по сну, а не клиническая
 * норма: ориентир, который всегда уступает сигналам ребёнка.
 */
export function baseWindow(m) {
  if (m < 1) return [40, 90];
  if (m < 2) return [55, 95];
  if (m < 3) return [65, 105];
  if (m < 4) return [70, 120];
  if (m < 5) return [90, 135];
  if (m < 6) return [105, 150];
  if (m < 7) return [120, 180];
  if (m < 9) return [135, 210];
  if (m < 12) return [150, 240];
  if (m < 18) return [180, 300];
  if (m < 24) return [240, 360];
  return [300, 360];
}

/**
 * Суточная норма сна, часы. Консенсус AASM 2016 (J Clin Sleep Med 12(6):785),
 * поддержан AAP. Для детей младше 4 месяцев рекомендаций нет намеренно.
 */
export function sleepNorm(m) {
  if (m < 4) return null;
  if (m < 12) return [12, 16];
  if (m < 24) return [11, 14];
  return [10, 13];
}

/**
 * Ночной ли это сон.
 *
 * Три зоны по времени начала:
 *   22:00-05:00 — ночь при любой длительности. Ночь у младенца часто
 *                 разбита на короткие отрезки, и порог по длине увёл бы
 *                 их в дневные сны.
 *   05:00-18:00 — день всегда.
 *   18:00-22:00 — неоднозначный вечер. Ночь, если сон длится от трёх
 *                 часов или дотягивает до 22:00. Короткий досып перед
 *                 настоящим отбоем остаётся дневным.
 *
 * Ошибка здесь не косметическая: после ночного сна прогноз берёт
 * минимальное окно.
 *
 * Незаконченный сон оценивается по текущей длине, то есть остаётся
 * дневным, пока не наберёт признаков ночного.
 */
export const NIGHT_MIN_MINUTES = 180;
export const DEEP_NIGHT_HOUR = 22;

export const isNightSleep = (ev) => {
  const h = new Date(ev.start).getHours();
  if (h >= DEEP_NIGHT_HOUR || h < 5) return true;
  if (h < 18) return false;

  const end = ev.end ?? Date.now();
  if ((end - ev.start) / MIN >= NIGHT_MIN_MINUTES) return true;

  const deep = new Date(ev.start);
  deep.setHours(DEEP_NIGHT_HOUR, 0, 0, 0);
  return end >= deep.getTime();
};

/**
 * Медиана длительности последних дневных снов, минуты.
 * Нужна как точка отсчёта: «короткий сон» — понятие относительное.
 * В 3-5 месяцев при перестройке архитектуры сна почти все сны
 * становятся односцикловыми, и абсолютный порог в 40 минут
 * срабатывал бы на каждом.
 */
export function typicalNap(events, before = Date.now(), n = 10) {
  const lens = events
    .filter((e) => e.type === "sleep" && e.end && !isNightSleep(e) && e.end <= before)
    .sort((a, b) => b.end - a.end)
    .slice(0, n)
    .map((e) => (e.end - e.start) / MIN)
    .sort((a, b) => a - b);
  if (lens.length < 4) return null;
  const mid = Math.floor(lens.length / 2);
  return lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
}

/**
 * Окно следующего сна.
 *
 * Позиция в дне считается по времени суток, а не по числу записанных
 * снов: дневник почти всегда неполный — начали вести с обеда, забыли
 * отметить утренний сон. Счётчик записей в таких случаях врёт в опасную
 * сторону и даёт слишком короткое окно.
 *
 * Точка отсчёта — конец ночного сна, если он записан. Если нет,
 * берётся 07:00: грубо, но устойчиво.
 */
export function predictWindow(events, birth, now, bias = 0) {
  const sleeps = events
    .filter((e) => e.type === "sleep" && e.end)
    .sort((a, b) => a.end - b.end);
  const last = sleeps[sleeps.length - 1];
  if (!last) return null;

  const [lo, hi] = baseWindow(ageMonths(birth, now));
  const day0 = startOfDay(last.end);

  // До ~3 месяцев циркадного ритма нет: устойчивый ритм складывается
  // к 6-12 неделям, суточная выработка мелатонина — к 9-12. Раньше
  // этого срока сон определяется голодом, а не временем суток, и
  // растягивать окно "к вечеру" не по чему.
  const ageM = ageMonths(birth, now);
  const circadian = ageM >= 3;

  const nightsToday = sleeps.filter(
    (s) => isNightSleep(s) && s.end >= day0 && s.end < day0 + 14 * 3600000
  );
  const knownMorning = nightsToday.length > 0;
  const morning = knownMorning
    ? nightsToday[nightsToday.length - 1].end
    : day0 + 7 * 3600000;
  const bedtime = day0 + 20 * 3600000;

  let target;
  if (!circadian) {
    // только возрастная норма, без привязки ко времени суток
    target = (lo + hi) / 2;
  } else if (isNightSleep(last)) {
    // сразу после ночи окно самое короткое
    target = lo;
  } else {
    const progress = Math.min(Math.max((last.end - morning) / (bedtime - morning), 0), 1);
    target = lo + (hi - lo) * progress;
  }

  if (circadian ? !isNightSleep(last) : true) {
    const len = (last.end - last.start) / MIN;
    // порог относительно собственных снов ребёнка, а не абсолютный:
    // при односцикловых снах абсолютные 40 минут срабатывали бы всегда
    const ref = typicalNap(sleeps, last.start) ?? 45;
    if (len < ref * 0.7) target -= 15;
    else if (len > ref * 1.5) target += 10;
  }

  target = Math.min(Math.max(target + bias, lo - 30), hi + 30);

  // до трёх месяцев прогноз заведомо грубее — окно шире
  const half = circadian ? 12 : 25;
  const from = last.end + (target - half) * MIN;

  // Фаза успокоения перед окном. Длительность — соглашение, а не
  // норматив: у грудничков на переход от активной игры ко сну обычно
  // закладывают четверть часа, у детей постарше — больше. Не даём ей
  // занять больше трети окна бодрствования.
  const windDown = ageM < 3 ? 10 : ageM < 12 ? 15 : 20;
  const calm = Math.max(
    from - windDown * MIN,
    last.end + (from - last.end) * 0.67
  );

  return {
    wokeAt: last.end,
    calm,
    windDown,
    from,
    to: last.end + (target + half + 1) * MIN,
    target,
    range: [lo, hi],
    circadian,
    knownMorning: circadian ? knownMorning : true,
    // записей давно не было — строить прогноз от них бессмысленно
    stale: now - last.end > (hi + 120) * MIN,
  };
}

/* ------------------------------------------------------------------ */
/*  Сводки                                                             */
/* ------------------------------------------------------------------ */

export function daySegments(events, dayStart) {
  const dayEnd = dayStart + DAY;
  const segs = [];
  for (const e of events) {
    if (e.type !== "sleep") continue;
    const s = Math.max(e.start, dayStart);
    const en = Math.min(e.end ?? Date.now(), dayEnd);
    if (en > s) segs.push({ from: s - dayStart, to: en - dayStart, live: !e.end });
  }
  return segs;
}

export function dayStats(events, dayStart) {
  const dayEnd = dayStart + DAY;
  let total = 0;
  let night = 0;
  let naps = 0;
  for (const e of events) {
    if (e.type !== "sleep" || !e.end) continue;
    const s = Math.max(e.start, dayStart);
    const en = Math.min(e.end, dayEnd);
    if (en <= s) continue;
    total += en - s;
    if (isNightSleep(e)) night += en - s;
    else naps += 1;
  }
  const inDay = (e) => e.start >= dayStart && e.start < dayEnd;
  return {
    total,
    night,
    day: total - night,
    naps,
    feeds: events.filter((e) => e.type === "feed" && inDay(e)).length,
    diapers: events.filter((e) => e.type === "diaper" && inDay(e)).length,
  };
}

/** Медиана длины дневных снов в интервале, минуты. */
export function medianNapIn(events, from, to) {
  const lens = events
    .filter((e) => e.type === "sleep" && e.end && !isNightSleep(e) && e.end >= from && e.end < to)
    .map((e) => (e.end - e.start) / MIN)
    .sort((a, b) => a - b);
  if (lens.length < 3) return null;
  const mid = Math.floor(lens.length / 2);
  return lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
}

/**
 * Средняя разница между предсказанным и фактическим засыпанием.
 * Положительная — ребёнок засыпает позже прогноза.
 */
export function measureBias(events, birth) {
  const sleeps = events
    .filter((e) => e.type === "sleep" && e.end)
    .sort((a, b) => a.start - b.start);
  const diffs = [];
  for (let i = 1; i < sleeps.length; i++) {
    if (isNightSleep(sleeps[i])) continue;
    const before = sleeps.slice(0, i);
    const w = predictWindow(before, birth, sleeps[i].start, 0);
    if (!w) continue;
    const mid = (w.from + w.to) / 2;
    diffs.push((sleeps[i].start - mid) / MIN);
  }
  if (diffs.length < 5) return null;
  const recent = diffs.slice(-10);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { n: recent.length, mean: Math.round(mean) };
}
