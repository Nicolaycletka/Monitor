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
 * Минимум наблюдений, ниже которого статистика не считается вовсе.
 * Одно число на все проверки: раньше здесь были вразнобой 3, 4 и 5
 * без каких-либо оснований для разницы. Четыре — примерно объём
 * данных за одни сутки.
 */
export const MIN_SAMPLES = 4;

/** Ограничение в [0, 1] — используется всюду, где нужен плавный переход вместо порога. */
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/**
 * Окна бодрствования, минуты. Сведены из открытых таблиц Huckleberry
 * и Happiest Baby. Это эвристика консультантов по сну, а не клиническая
 * норма: ориентир, который всегда уступает сигналам ребёнка.
 *
 * Источники дают ступеньки по возрастным полосам. Ступенька — форма
 * подачи, а не факт о ребёнке: за одну ночь на границе полосы окно
 * прыгало на 10-15 минут. Поэтому значения источников закреплены за
 * серединами полос, а между ними интерполируются линейно. Сама
 * интерполяция — наше соглашение; числа в узлах взяты из таблиц
 * без изменений.
 */
const WINDOW_ANCHORS = [
  [0.5, 40, 90],
  [1.5, 55, 95],
  [2.5, 65, 105],
  [3.5, 70, 120],
  [4.5, 90, 135],
  [5.5, 105, 150],
  [6.5, 120, 180],
  [8, 135, 210],
  [10.5, 150, 240],
  [15, 180, 300],
  [21, 240, 360],
  [24, 300, 360],
];

export function baseWindow(m) {
  const a = WINDOW_ANCHORS;
  if (m <= a[0][0]) return [a[0][1], a[0][2]];
  const end = a[a.length - 1];
  if (m >= end[0]) return [end[1], end[2]];
  for (let i = 1; i < a.length; i++) {
    if (m > a[i][0]) continue;
    const [m0, lo0, hi0] = a[i - 1];
    const [m1, lo1, hi1] = a[i];
    const t = (m - m0) / (m1 - m0);
    return [Math.round(lo0 + (lo1 - lo0) * t), Math.round(hi0 + (hi1 - hi0) * t)];
  }
  return [end[1], end[2]];
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

/* ---------- периоды болезни ---------- */

/**
 * Болезнь ломает сон: он фрагментируется, ребёнок засыпает вне всякого
 * ритма, укладывания идут тяжело по причинам, к времени суток
 * отношения не имеющим. Если такие дни попадут в обучение, приложение
 * запомнит их как норму этого ребёнка и будет ошибаться ещё неделю
 * после выздоровления.
 *
 * Отметка ставится руками и намеренно НЕ определяется автоматически:
 * детектор аномалий не отличил бы болезнь от настоящего сброса сна,
 * а следовать за сбросом приложение как раз должно.
 *
 * Что исключается и что нет:
 *   исключается  — measureBias, typicalNap, settleShare, недельные
 *                  средние. Всё, что описывает НОРМУ ребёнка.
 *   не исключается — carryOver. Ребёнок действительно спал, давление
 *                  действительно рассеялось; это физика последних
 *                  часов, а не суждение о норме.
 *   не исключается — показ на вкладках «День» и «Неделя». Записи
 *                  настоящие, прятать их незачем.
 *
 * Незакрытый период (end == null) означает «болеет прямо сейчас».
 */
export const illnessPeriods = (events) =>
  events
    .filter((e) => e.type === "illness" && !e.deleted)
    .map((e) => ({ start: e.start, end: e.end ?? Infinity }))
    .sort((a, b) => a.start - b.start);

export const isSickAt = (ts, periods) =>
  periods.some((p) => ts >= p.start && ts < p.end);

/** Идёт ли болезнь прямо сейчас. */
export const sickNow = (events, now = Date.now()) =>
  isSickAt(now, illnessPeriods(events));

/** Сны вне периодов болезни — то, по чему приложение учится. */
export function healthySleeps(events) {
  const periods = illnessPeriods(events);
  if (!periods.length) return events;
  return events.filter((e) => e.type !== "sleep" || !isSickAt(e.start, periods));
}

/* ---------- склейка фрагментированного сна ---------- */

/**
 * Доля минимального возрастного окна, ниже которой промежуток между
 * снами считается не бодрствованием, а пробуждением ВНУТРИ одного
 * периода сна.
 *
 * Так это и делают в актиграфии: ночь определяют как интервал от
 * засыпания до утреннего подъёма, а пробуждения внутри него считают
 * WASO — временем бодрствования внутри периода, а не его концом.
 * Сама доля — соглашение: у трёхмесячного минимальное окно ~68 минут,
 * половина даёт порог ~34 минуты, то есть ночное кормление период
 * не разрывает, а настоящее бодрствование разрывает.
 */
export const MERGE_GAP_FRACTION = 0.5;

/**
 * Ночью порог другой и фиксированный. Днём промежуток проверяется на
 * «тянет ли он на окно бодрствования», но НОЧЬЮ понятия окна нет
 * вообще: ребёнок не должен бодрствовать, а кормление с переодеванием
 * занимает 30-50 минут. Возрастная доля тут дала бы 33 минуты
 * у трёхмесячного, и обычное ночное кормление рвало бы ночь надвое.
 *
 * Окно 22:00-07:00 захватывает и утреннюю фрагментацию: подъём в 5:30,
 * потом сон с 6:05 — это хвост ночи, а не первый дневной сон.
 */
export const NIGHT_MERGE_GAP = 60;
const inNightHours = (ts) => {
  const h = new Date(ts).getHours();
  return h >= DEEP_NIGHT_HOUR || h < 7;
};

/**
 * Сны, склеенные в периоды. Два сна с коротким промежутком между ними —
 * это один фрагментированный сон, а не два.
 *
 * Без склейки ломалось сразу несколько вещей:
 *   - ночь, прерванная кормлением в 4:00, распадалась на два события,
 *     и второе (начало в 4:40) по часам попадало в «ночь», а вот сон
 *     с 6:15 после подъёма в 5:30 уже классифицировался как ДЕНЬ —
 *     то есть как первый дневной сон, хотя это хвост ночи;
 *   - typicalNap видел два коротких сна вместо одного нормального
 *     и занижал медиану, а за ней и штраф за короткий сон;
 *   - measureBias по фрагменту строил ВТОРОЕ наблюдение, где окно
 *     бодрствования равнялось двадцати минутам — чистый мусор;
 *   - «снов днём» в статистике завышалось.
 *
 * Склейка применяется там, где приложение УЧИТСЯ и классифицирует.
 * carryOver работает по сырым записям: за двадцать минут бодрствования
 * давление действительно частично восстановилось, и рекурсивная
 * формула это уже учитывает правильно.
 *
 * Показ на вкладках «День» и «Неделя» тоже остаётся сырым: родитель
 * записал два события и должен видеть два.
 */
export function mergeSleeps(events, birth) {
  const sleeps = events
    .filter((e) => e.type === "sleep" && e.end && !e.deleted)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sleeps) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = (s.start - prev.end) / MIN;
      // без даты рождения ageMonths дал бы огромное число, baseWindow —
      // последний узел (300 мин), и порог склейки стал бы 150 минут:
      // склеился бы весь день. Запасное значение консервативное.
      const [lo] = Number.isFinite(birth) ? baseWindow(ageMonths(birth, s.start)) : [60];
      const limit = inNightHours(prev.end) ? NIGHT_MERGE_GAP : lo * MERGE_GAP_FRACTION;
      if (gap >= 0 && gap < limit) {
        prev.end = s.end;
        prev.fragments = (prev.fragments || 1) + 1;
        prev.waso = (prev.waso || 0) + gap;
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * Медиана длительности последних дневных снов, минуты.
 * Нужна как точка отсчёта: «короткий сон» — понятие относительное.
 * В 3-5 месяцев при перестройке архитектуры сна почти все сны
 * становятся односцикловыми, и абсолютный порог в 40 минут
 * срабатывал бы на каждом.
 */
export function typicalNap(events, before = Date.now(), n = 10, birth = null) {
  const lens = mergeSleeps(healthySleeps(events), birth)
    .filter((e) => e.end && !isNightSleep(e) && e.end <= before)
    .sort((a, b) => b.end - a.end)
    .slice(0, n)
    .map((e) => (e.end - e.start) / MIN)
    .sort((a, b) => a - b);
  if (lens.length < MIN_SAMPLES) return null;
  const mid = Math.floor(lens.length / 2);
  return lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
}

/**
 * Константа диссипации давления сна, минуты.
 *
 * СОГЛАШЕНИЕ, а не измеренная у младенцев величина — получена
 * масштабированием, и в коде это должно быть видно. У взрослых
 * константа рассеивания Процесса S ≈ 2,4 ч ≈ 144 мин при бодрствовании
 * ~16 ч, отношение ≈ 6,7. При окне бодрствования младенца ~110 мин
 * то же отношение даёт ≈ 16 мин.
 */
export const TAU = 15;

/**
 * Накопленное давление сна на момент конца последнего сна,
 * в «минутах бодрствования».
 *
 * Бодрствование копит давление 1:1, сон рассеивает его экспоненциально:
 * P *= exp(−d/TAU). Смысл в том, что короткая дремота в автокресле
 * физиологически не обнуляет давление, а лишь снижает его — раньше
 * любой сон любой длины сбрасывал таймер целиком, и день после пары
 * микроснов рассыпался.
 *
 * Ночной сон отдельной ветки не требует: при TAU=15 любой сон длиннее
 * часа даёт exp(−60/15) ≈ 0,018, то есть формула сама вырождается
 * в прежнее поведение «сон обнуляет всё».
 *
 *   5 мин  -> остаётся 72%     25 мин -> 19%
 *   10 мин -> 51%              50 мин -> 3,6%   (полный цикл)
 *   15 мин -> 37%              6 часов -> ~0
 *
 * Хвоста истории достаточно: давление до него всё равно умножено
 * на десяток экспонент и практически обнулено.
 */
export function carryOver(events, tail = 10) {
  const sleeps = events
    .filter((e) => e.type === "sleep" && e.end)
    .sort((a, b) => a.start - b.start)
    .slice(-tail);
  let P = 0, prevEnd = null;
  for (const s of sleeps) {
    if (prevEnd != null) P += (s.start - prevEnd) / MIN;
    P *= Math.exp(-((s.end - s.start) / MIN) / TAU);
    prevEnd = s.end;
  }
  return P;
}

/** Минимальный остаток окна: не говорить «класть немедленно» в момент пробуждения. */
export const WINDOW_FLOOR = 20;

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
export function predictWindow(events, birth, now, bias = 0, spread = 0) {
  // склеенные периоды: фрагмент ночи не должен становиться «последним
  // сном», от конца которого отсчитывается окно
  const sleeps = mergeSleeps(events, birth).sort((a, b) => a.end - b.end);
  const last = sleeps[sleeps.length - 1];
  if (!last) return null;

  const [lo, hi] = baseWindow(ageMonths(birth, now));
  const day0 = startOfDay(last.end);

  // Циркадный ритм складывается к 6-12 неделям, суточная выработка
  // мелатонина — к 9-12. До этого сон определяется голодом, а не
  // временем суток, и растягивать окно "к вечеру" не по чему.
  //
  // Переход намеренно плавный: жёсткий порог ageM >= 3 давал разрыв
  // до 40 минут за одну ночь и вдвое сужал окно, хотя за эту ночь
  // с ребёнком ничего не происходит. Вес идёт от 0 на 2,5 месяцах
  // до 1 на 3,5.
  const ageM = ageMonths(birth, now);
  const cw = clamp01((ageM - 2.5) / 1);
  const circadian = cw > 0;

  const nightsToday = sleeps.filter(
    (s) => isNightSleep(s) && s.end >= day0 && s.end < day0 + 14 * 3600000
  );
  const knownMorning = nightsToday.length > 0;
  const morning = knownMorning
    ? nightsToday[nightsToday.length - 1].end
    : day0 + 7 * 3600000;
  const bedtime = day0 + 20 * 3600000;

  // Возрастной ориентир без привязки ко времени суток...
  const flat = (lo + hi) / 2;
  // ...и расчёт по режиму дня. Смешиваются по весу cw.
  let structured;
  // Прогресс дня. После ночного сна он равен нулю: день только начался,
  // и это ровно то же, что structured = lo. Раньше здесь стоял null,
  // и первый дневной сон — тот, которому утренняя поправка нужнее
  // всего — не попадал в утреннюю половину вовсе и получал среднюю.
  const progress = isNightSleep(last)
    ? 0
    : clamp01((last.end - morning) / (bedtime - morning));
  structured = lo + (hi - lo) * progress;
  let target = flat + (structured - flat) * cw;

  // Поправка на длину предыдущего дневного сна.
  //
  // «Короткий сон -> окно раньше» и перенос давления (carryOver)
  // описывают РАЗНЫЕ явления и потому оба нужны, но складывать их
  // нельзя — в области очень коротких снов они сработали бы дважды:
  //
  //   carryOver      — нерассеянное гомеостатическое давление.
  //                    Правит бал до ~25 минут, дальше быстро гаснет.
  //   короткий сон   — неполное восстановление относительно нормы
  //                    САМОГО ребёнка. Работает там, где давление уже
  //                    рассеялось: сон 55 мин при медиане 100 даёт
  //                    переноса всего 3 минуты, хотя ребёнок недоспал.
  //
  // Поэтому берётся максимум из двух, а не сумма.
  //
  // Порог относительный, а не абсолютные 40 минут: у младенца цикл сна
  // 50-60 мин и удлиняется с возрастом, то есть это не константа,
  // а при односцикловых снах в 3-5 месяцев абсолютный порог срабатывал
  // бы на каждом сне.
  //
  // Ветка «необычно длинный сон -> окно позже» переносом не покрывается
  // (после любого полного сна давление уже ~0). Это самое слабое место
  // формулы: единственный неподкреплённый источниками член, толкающий
  // окно позже.
  // Обе ветки сглажены, без ступенек: скачок штрафа на пороге — такой
  // же искусственный костыль, как жёсткий порог доли тяжёлых укладываний.
  // Штраф нарастает линейно от 0 при длине сна = медиане до 15 минут
  // при 70% медианы и ниже.
  //
  // Симметричной ветки «необычно длинный сон -> окно позже» здесь нет
  // намеренно. Она была снята: после любого полного сна давление и так
  // рассеяно до нуля, то есть переносом она не подкреплена, источниками
  // тоже, а толкала окно позже — в ту самую сторону, где ошибка сама
  // себя воспроизводит.
  let shortPenalty = 0;
  if (!isNightSleep(last)) {
    const len = (last.end - last.start) / MIN;
    const ref = typicalNap(sleeps, last.start, 10, birth);
    if (ref != null) shortPenalty = 15 * clamp01((ref - len) / (ref * 0.3));
  }

  // Поправка может быть не числом, а парой «утро/вечер»: тогда она
  // разрешается по прогрессу дня. Значения — медианы по половинам дня,
  // то есть относятся примерно к прогрессу 0,25 и 0,75; между ними
  // интерполируем, за краями держим ровно (экстраполировать наклон,
  // измеренный по двум точкам, было бы самонадеянно).
  if (bias && typeof bias === "object") {
    const t = clamp01((progress - 0.25) / 0.5);
    bias = bias.early + (bias.late - bias.early) * t;
  }

  // Кламп симметричен: вся логика демпфирования живёт в autoBias, и
  // дублировать её здесь означало бы гасить положительный сдвиг дважды,
  // непредсказуемым произведением двух множителей.
  const loBound = lo - 30 + Math.min(0, bias);
  const hiBound = hi + 30 + Math.max(0, bias);
  target = Math.min(Math.max(target + bias, loBound), hiBound);

  // target — полное окно, которое нужно этому ребёнку с нулевого
  // давления. Остаток — сколько от него ещё предстоит бодрствовать.
  const carry = carryOver(sleeps);
  const reduction = Math.max(carry, shortPenalty);
  const remaining = Math.max(target - reduction, WINDOW_FLOOR);

  // до трёх месяцев прогноз заведомо грубее — окно шире.
  // Плюс расширение по измеренному разбросу засыпаний: если ребёнок
  // ложится вразброс, узкое окно — это ложная точность. Приложение
  // знает свой разброс, честнее его показать. Ограничено 15 минутами,
  // иначе окно перестаёт что-либо означать.
  const half = 25 + (12 - 25) * cw + Math.min(spread * 0.5, 15);
  const from = last.end + (remaining - half) * MIN;

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
    to: last.end + (remaining + half + 1) * MIN,
    target,
    carry,
    reduction,
    remaining,
    progress,
    appliedBias: bias,
    range: [lo, hi],
    circadian,
    circadianWeight: cw,
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
  const lens = healthySleeps(events)
    .filter((e) => e.type === "sleep" && e.end && !isNightSleep(e) && e.end >= from && e.end < to)
    .map((e) => (e.end - e.start) / MIN)
    .sort((a, b) => a - b);
  if (lens.length < MIN_SAMPLES) return null;
  const mid = Math.floor(lens.length / 2);
  return lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
}

/* ---------- как прошло укладывание ---------- */

/**
 * Метка на сне: что пошло не так при укладывании. Ставится родителем
 * только тогда, когда есть что отметить.
 *
 * Смысл не в «перегуле» — доказательная база вокруг этого понятия
 * спорная, и приложение на ней ничего не строит. Смысл чисто
 * статистический: записанное время засыпания — это момент, когда
 * РОДИТЕЛЯМ удалось уложить, а не момент, когда ребёнок был готов.
 * Без метки эти две величины неразличимы.
 *
 *   hard  — плакал, не мог уснуть. Положили ПОЗДНО, окно упущено.
 *           Готовность была раньше на неизвестную величину. Засыпание
 *           позже прогноза в этом случае ничего не доказывает и
 *           отбрасывается; раньше прогноза — учитывается.
 *   alert — не хотел спать, был бодрый. Положили РАНО, ребёнок ещё
 *           не готов. Момент засыпания и есть его настоящая готовность,
 *           то есть это самое информативное наблюдение из всех.
 *           Ничего не отбрасывается.
 *
 * Отсутствие метки означает «ничего особенного» и идёт в измерение
 * как есть. Отдельных меток «уснул сразу» и «повозился» БОЛЬШЕ НЕТ:
 * на прогонах всех четырёх сценариев они не давали ничего (разница
 * с двумя метками в пределах минуты), а требовали отмечать каждый сон.
 *
 * Знаменатель долей — ВСЕ дневные сны за неделю, а не только
 * размеченные. Это принципиально: если считать долю по размеченным,
 * то родитель, отмечающий лишь проблемные укладывания (единственное
 * человеческое поведение), получает долю ровно 1.0 и максимальный
 * сдвиг −30 минут с пятой отметки, а с четвёртой — ноль. Ступенька
 * в полчаса от одной отметки. По всем снам те же 5 плохих из 20 дают
 * −8 минут, и зависимость плавная.
 */
export const SETTLE_KINDS = ["hard", "alert"];
export const SETTLE_LABEL = { hard: "Плакал", alert: "Был бодрый" };
export const SETTLE_HINT = {
  hard: "не мог уснуть, плакал — похоже, положили поздно",
  alert: "не хотел спать, был весёлый — похоже, положили рано",
};
export const settleOf = (e) =>
  SETTLE_KINDS.includes(e?.meta?.settle) ? e.meta.settle : null;

/** Сколько укладываний каждого вида за период. */
export function settleStats(events, from, to, birth = null) {
  const out = { hard: 0, alert: 0, unmarked: 0, marked: 0, total: 0 };
  for (const e of mergeSleeps(healthySleeps(events), birth)) {
    if (!e.end || isNightSleep(e)) continue;
    if (e.start < from || e.start >= to) continue;
    out.total++;
    const s = settleOf(e);
    if (s) { out[s]++; out.marked++; }
    else out.unmarked++;
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const stats = (xs) => {
  const recent = xs.slice(-10);
  const med = median(recent);
  return {
    n: recent.length,
    median: Math.round(med),
    spread: Math.round(median(recent.map((d) => Math.abs(d - med)))),
  };
};

/**
 * Разница между предсказанным и фактическим засыпанием.
 * Положительная — ребёнок засыпает позже прогноза.
 *
 * Медиана, а не среднее: один сон, отмеченный с опозданием на полчаса
 * (с младенцем это норма), утягивал среднее за собой. Рядом считается
 * разброс (MAD) — по нему видно, поправка это или шум.
 *
 * Считаются ДВЕ оценки:
 *   отфильтрованная — с учётом меток укладывания (см. SETTLE_KINDS);
 *   сырая (raw)     — по всем дневным засыпаниям без разбора.
 *
 * Сырая нужна как предохранитель против собственных фильтров. Если
 * фильтры съели почти всё, а расхождение при этом велико и устойчиво,
 * значит возрастная модель просто не про этого ребёнка, и опираться
 * не на что, кроме сырых данных.
 *
 * Считается только по хвосту истории: в оценку всё равно идут
 * последние 10 засыпаний, а прогонять predictWindow по всем 90 дням
 * ради них — лишние секунды на телефоне при каждом пересчёте.
 */
export function measureBias(events, birth) {
  // дни болезни в обучение не идут (см. illnessPeriods), фрагменты
  // склеены (см. mergeSleeps): иначе пробуждение внутри ночи давало бы
  // второе наблюдение с окном бодрствования в двадцать минут
  const sleeps = mergeSleeps(healthySleeps(events), birth)
    .sort((a, b) => a.start - b.start);
  const diffs = [];
  const rawDiffs = [];
  // те же наблюдения, разложенные по половинам дня: одна общая поправка
  // умеет только сдвинуть весь день целиком, а если у ребёнка форма дня
  // не та, что в таблице, ошибка систематически едет от утра к вечеру
  const early = [], late = [];
  const from = Math.max(1, sleeps.length - 20);
  for (let i = from; i < sleeps.length; i++) {
    if (isNightSleep(sleeps[i])) continue;
    const before = sleeps.slice(0, i);
    const w = predictWindow(before, birth, sleeps[i].start, 0);
    if (!w) continue;
    const d = (sleeps[i].start - (w.from + w.to) / 2) / MIN;
    rawDiffs.push(d);

    const kind = settleOf(sleeps[i]);
    // плакал: окно упущено, засыпание позже прогноза ничего не доказывает,
    // это последствие опоздания. Раньше прогноза — доказывает.
    // Для «был бодрый» такого отбрасывания НЕТ: там момент засыпания
    // и есть настоящая готовность ребёнка, это лучшее наблюдение из всех.
    if (kind === "hard" && d >= 0) continue;
    diffs.push(d);
    if (Number.isFinite(w.progress)) (w.progress < 0.5 ? early : late).push(d);
  }
  const filtered = diffs.length >= MIN_SAMPLES ? stats(diffs) : null;
  const raw = rawDiffs.length >= MIN_SAMPLES ? stats(rawDiffs) : null;
  if (!filtered && !raw) return null;
  return {
    ...(filtered || { n: 0, median: 0, spread: 0 }),
    usable: Boolean(filtered),
    raw,
    early: early.length >= MIN_SAMPLES ? stats(early) : null,
    late: late.length >= MIN_SAMPLES ? stats(late) : null,
  };
}

/** Насколько велико должно быть сырое расхождение, чтобы фильтры отошли в сторону. */
export const RAW_ALARM = 30;

/**
 * Какую часть измеренной поправки приложение применяет само.
 *
 * Соглашение, а не норматив. Сдерживающие множители:
 *   n/(n+3)      — доверие растёт с числом наблюдений: при четырёх снах
 *                  берётся 57% поправки, при десяти — 77%. Полностью
 *                  не берётся никогда, дневник в 2-3 дня легко поймать
 *                  на нетипичном дне.
 *   |med|/spread — если разброс сопоставим с самой поправкой, это шум,
 *                  а не систематический сдвиг, и доверия меньше.
 *
 * Стороны неравноправны. Ошибиться рано дёшево: ребёнок не уснул,
 * попробовали через четверть часа. Ошибиться поздно дороже, и эта
 * ошибка сама себя воспроизводит: приложение сдвигает окно позже,
 * родители кладут позже, приложение измеряет собственный сдвиг как
 * факт о ребёнке. Поэтому отрицательная поправка идёт целиком,
 * положительная — через множитель доверия:
 *
 *   trust = clamp01(0.5 + 0.5·доля«был бодрый» − доля«плакал»)
 *
 * Без меток это прежние 0,5. Сплошь «плакал» — ноль (позднее засыпание
 * в таком состоянии след опоздания, а не потребности). Сплошь «был
 * бодрый» — полная единица: это прямое свидетельство, что клали рано,
 * и ребёнку окно действительно нужно длиннее.
 *
 * Здесь ЕДИНСТВЕННОЕ место демпфирования во всей цепочке: кламп границ
 * в predictWindow симметричен намеренно, иначе два множителя гасили бы
 * положительный сдвиг вложенно и непредсказуемо.
 *
 * Поправка меньше 5 минут игнорируется: это уже уровень округления
 * при ручной отметке времени.
 */
export function autoBias(m, hardShare = null, alertShare = null) {
  if (!m) return 0;

  // Предохранитель: фильтры по меткам съели данные, а сырое расхождение
  // велико — значит модель не про этого ребёнка. Опираемся на сырое.
  const src =
    !m.usable && m.raw && Math.abs(m.raw.median) >= RAW_ALARM ? m.raw : m.usable ? m : null;
  if (!src || Math.abs(src.median) < 5) return 0;

  const byCount = src.n / (src.n + 3);
  const byNoise = Math.min(1, Math.abs(src.median) / Math.max(src.spread, 1));
  let v = src.median * byCount * byNoise;
  if (v > 0) v *= clamp01(0.5 + 0.5 * (alertShare || 0) - (hardShare || 0));
  return Math.round(v);
}

/**
 * Доли укладываний за последнюю неделю среди размеченных.
 * Одно место расчёта на все механики — иначе они считают «часто ли
 * бывает тяжело» по разным выборкам и колеблются друг относительно друга.
 */
export function settleShare(events, now = Date.now(), birth = null) {
  const from = now - 7 * DAY;
  let hard = 0, alert = 0, marked = 0, total = 0;
  for (const e of mergeSleeps(healthySleeps(events), birth)) {
    if (!e.end || isNightSleep(e)) continue;
    if (e.start < from) continue;
    total++;
    const k = settleOf(e);
    if (!k) continue;
    marked++;
    if (k === "hard") hard++;
    else if (k === "alert") alert++;
  }
  // знаменатель — ВСЕ дневные сны, а не только размеченные (см. выше)
  const ok = total >= MIN_SAMPLES;
  return {
    hard,
    alert,
    marked,
    total,
    hardShare: ok ? hard / total : null,
    alertShare: ok ? alert / total : null,
  };
}

/**
 * Сдвиг окна по меткам укладывания. ОДНОСТОРОННИЙ, только от «плакал».
 *
 * Асимметрия здесь не произвол, а следствие того, что measureBias
 * делает с каждой меткой:
 *
 *   «плакал»     — measureBias эти наблюдения ОТБРАСЫВАЕТ (засыпание
 *                  позже прогноза там ничего не доказывает). Значит
 *                  сигнал «положили поздно» больше проходить некуда,
 *                  и сдвиг — его единственный канал.
 *   «был бодрый» — measureBias эти наблюдения УЧИТЫВАЕТ полностью,
 *                  и растянутое окно уже отражается в поправке. Свой
 *                  сдвиг сверху был бы тем же сигналом, посчитанным
 *                  дважды. На прогонах двусторонний сдвиг проигрывал
 *                  одностороннему: норма +9 против −1, сброс сна +9
 *                  против −4. Поэтому «был бодрый» влияет ТОЛЬКО
 *                  на множитель доверия в autoBias — он не измеряет
 *                  ничего заново, а разрешает применить уже измеренное.
 *
 * Величина — соглашение, а не измерение: насколько именно раньше была
 * готовность, наблюдение не говорит.
 *
 * Работает как регулятор, а не как накопитель: сдвиг каждый раз
 * считается заново от текущей доли. Окно уезжает раньше -> укладывания
 * даются легче -> доля падает -> сдвиг сам сходит на нет. Убегания
 * быть не может, потолок 30 минут.
 *
 * Зависимость линейная и без порогов.
 */
export const SETTLE_NUDGE_MAX = 30;

export function settleNudge(events, now = Date.now(), birth = null) {
  const { hardShare } = settleShare(events, now, birth);
  if (hardShare == null) return 0;
  return -Math.round(SETTLE_NUDGE_MAX * hardShare);
}

/**
 * Самопроверка: что бы предсказало точнее — алгоритм со всеми
 * поправками или голая возрастная таблица без них?
 *
 * Считается задним числом по последним засыпаниям: для каждого
 * строятся оба прогноза по данным ДО него и сравниваются с фактом.
 * Возвращаются медианы абсолютной ошибки.
 *
 * ВАЖНАЯ ОГОВОРКА о честности сравнения. История не независима от
 * модели: родители укладывали ребёнка по тому прогнозу, который им
 * показывали, поэтому засыпания подтянуты к применённому варианту.
 * То есть тест СМЕЩЁН В ПОЛЬЗУ поправок. Именно поэтому обратный
 * результат — когда голая таблица всё равно оказывается точнее —
 * является сильным свидетельством, а не шумом: поправки проиграли,
 * имея фору.
 *
 * Порог MIN_SAMPLES * 2 и запас в 5 минут — соглашение, чтобы
 * случайная неделя не выключала обучение.
 */
export const SELFCHECK_MARGIN = 5;

/**
 * Кэш самопроверки. Внутри неё measureBias вызывается в цикле, то есть
 * работа квадратичная: без кэша выходило 56 мс на вызов против 2,7 мс
 * у остального прогноза, и это на каждый тик часов раз в 15 секунд.
 *
 * Ключ — дешёвая подпись входа. Самопроверка меняется медленно, так что
 * даже промах в одну отрисовку безвреден.
 */
let checkCache = { key: null, value: null };

export function selfCheck(events, birth, now = Date.now()) {
  const last = events[events.length - 1];
  const key = `${events.length}:${last?.id}:${last?.end}:${birth}`;
  if (checkCache.key === key) return checkCache.value;

  const value = computeSelfCheck(events, birth, now);
  checkCache = { key, value };
  return value;
}

function computeSelfCheck(events, birth, now) {
  const sleeps = mergeSleeps(healthySleeps(events), birth).sort((a, b) => a.start - b.start);
  const withCorr = [], bare = [];
  const from = Math.max(1, sleeps.length - 20);
  for (let i = from; i < sleeps.length; i++) {
    if (isNightSleep(sleeps[i])) continue;
    const before = sleeps.slice(0, i);
    const at = sleeps[i].start;

    const m = measureBias(before, birth);
    const sh = settleShare(before, at, birth);
    // ровно то, что применяется в predictNext, иначе сравнение мерит
    // не ту модель, которая работает
    const prof = biasProfile(m, sh.hardShare, sh.alertShare);
    const shift = settleNudge(before, at, birth);
    const corr =
      typeof prof === "object"
        ? { early: prof.early + shift, late: prof.late + shift }
        : prof + shift;

    const a = predictWindow(before, birth, at, corr, m ? m.spread : 0);
    const b = predictWindow(before, birth, at, 0, 0);
    if (!a || !b) continue;
    withCorr.push(Math.abs(at - (a.from + a.to) / 2) / MIN);
    bare.push(Math.abs(at - (b.from + b.to) / 2) / MIN);
  }
  if (withCorr.length < MIN_SAMPLES * 2) return null;
  const corrected = Math.round(median(withCorr));
  const table = Math.round(median(bare));
  return {
    n: withCorr.length,
    corrected,
    table,
    // таблица выиграла с запасом — поправки делают хуже
    failing: table + SELFCHECK_MARGIN < corrected,
  };
}

/**
 * Поправка целиком: число или пара «утро/вечер».
 *
 * Одна общая поправка умеет только сдвинуть весь день. Если у ребёнка
 * форма дня не та, что предполагает таблица (окна одинаковые весь день,
 * или растут круче), ошибка систематически едет от утра к вечеру, и
 * скаляр её не берёт: на прогонах размах доходил до 46 минут между
 * первым и последним сном.
 *
 * Чинится наклоном поправки, а НЕ подстройкой под номер сна. Номер
 * сна — координата ненадёжная: дневник почти всегда неполный, забыли
 * отметить утренний сон — и все подстройки поехали на слот. Прогресс
 * дня по часам к пропускам устойчив, и по нему уже считается вся
 * остальная модель.
 *
 * Раздельные половины применяются, только если в каждой хватает
 * наблюдений И расхождение между ними больше шума. Иначе это тот же
 * скаляр, посчитанный по вдвое меньшей выборке.
 */
export const SLOPE_MIN_GAP = 10;

export function biasProfile(m, hardShare = null, alertShare = null) {
  const flat = autoBias(m, hardShare, alertShare);
  if (!m || !m.early || !m.late) return flat;

  const gap = Math.abs(m.late.median - m.early.median);
  const noise = Math.max(m.early.spread, m.late.spread, 1);
  if (gap < Math.max(SLOPE_MIN_GAP, noise)) return flat;

  const e = autoBias({ ...m.early, usable: true, raw: null }, hardShare, alertShare);
  const l = autoBias({ ...m.late, usable: true, raw: null }, hardShare, alertShare);
  // если демпфирование съело обе половины, наклон обсуждать не о чем
  if (e === 0 && l === 0) return flat;
  return { early: e, late: l };
}

/**
 * Прогноз с уже применённой личной поправкой.
 *
 * ЕДИНСТВЕННАЯ точка входа: её вызывают и экран «Сейчас», и расчёт
 * времени уведомления в Telegram, и любые подсказки в интерфейсе.
 * Отдельной функции effectiveBias больше нет — она дублировала эту
 * же сборку вторым куском кода, и разойтись они могли молча.
 */
export function predictNext(events, birth, now, manual = 0) {
  const m = measureBias(events, birth);
  const { hardShare, alertShare } = settleShare(events, now, birth);
  const check = selfCheck(events, birth, now);
  // поправки проиграли голой таблице — применять их нельзя,
  // пока картина не изменится. Ручной сдвиг родителя остаётся.
  const off = Boolean(check && check.failing);
  const auto = off ? 0 : biasProfile(m, hardShare, alertShare);
  const nudge = off ? 0 : settleNudge(events, now, birth);
  // сдвиг по меткам и ручная добавка — скаляры, кладутся на обе половины
  const shift = nudge + (manual || 0);
  const bias =
    typeof auto === "object"
      ? { early: auto.early + shift, late: auto.late + shift }
      : auto + shift;
  const w = predictWindow(events, birth, now, bias, off || !m ? 0 : m.spread);
  return w && {
    ...w,
    autoBias: auto,
    settleNudge: nudge,
    slope: typeof auto === "object" ? auto : null,
    manualBias: manual || 0,
    measured: m,
    selfCheck: check,
    correctionsOff: off,
    sick: sickNow(events, now),
  };
}
