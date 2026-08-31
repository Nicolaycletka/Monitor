import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  MIN, DAY, startOfDay, hhmm, dur, durShort, ageText, ageMonths, dayLabel,
  sleepNorm, isNightSleep, isNight, autoNight, nightFragments, sourceScores, pickSource, sourceLabel, TABLES, PICK_MARGIN, predictNext, daySegments, dayStats, measureBias,
  medianNapIn, typicalNap, autoBias, settleOf, settleStats,
  settleShare, settleNudge, SETTLE_KINDS, SETTLE_LABEL, SETTLE_HINT, RAW_ALARM,
  selfCheck, biasProfile,
} from "./sleep.js";
import {
  loadState, saveState, createHousehold, syncOnce, uid, liveEvents,
  inviteLink, readJoinToken, API, relink, fetchTelegramLink, MANUAL_BIAS_LIMIT,
} from "./store.js";
import {
  IND, IND_KEYS, SEX_LABEL, SEX_GEN, DAYS_PER_MONTH, maxDays, inRange,
  zOf, valueAt, medianOf, pctText, measurements, gainRate, zTrend,
  parseValue, valueText, GAIN_MIN_DAYS, Z_DROP_ALARM,
} from "./growth.js";
import {
  predictFeed, perFeedMl, isDaytime, HALF_LIFE, READY_FRACTION,
  breastVolume, typicalFeedMinutes, LETDOWN_TAU,
} from "./feed.js";

/**
 * Как мерить — по одной подсказке на показатель. Для длины и головы
 * это не формальность: домашняя погрешность здесь сопоставима с самой
 * величиной, которую мы отслеживаем (см. MEASURE_NOTE ниже).
 */
const MEASURE_HINT = {
  weight: "Можно ввести и граммы — 6350 поймётся так же, как 6,35. Взвешивайте в одно и то же время и в одинаковом виде (лучше голышом, до кормления): домашние весы дают ±20–50 г, а полный подгузник — все 200.",
  length: "Можно ввести и миллиметры — 614 поймётся так же, как 61,4. Длину меряют лёжа: ребёнок на ровной поверхности, макушка у неподвижного упора, ноги выпрямлены. Одному это сделать почти невозможно — нужен второй человек.",
  head: "Можно ввести и миллиметры — 402 поймётся так же, как 40,2. Лента идёт по самой широкой части: над бровями и через самый выступающий затылочный бугор. Меряют трижды и берут наибольшее.",
};

/** Оговорка о точности — своя у каждого показателя, и разная по силе. */
const MEASURE_NOTE = {
  weight: "Ежедневное взвешивание дома почти всегда даёт больше тревоги, чем смысла: разброс между двумя измерениями подряд сопоставим с недельной прибавкой. Раз в неделю-две достаточно.",
  length: "Здесь стоит быть особенно осторожным с домашними цифрами. Разброс длины у трёхмесячных — около 2 см на одну z-оценку, а ошибка измерения сантиметровой лентой на извивающемся ребёнке легко достигает того же сантиметра. То есть половина «изменения перцентиля» может оказаться тем, как в этот раз легли ноги. Цифрам с приёма у педиатра доверяйте больше, чем своим, и мерьте не чаще раза в месяц.",
  head: "Разброс окружности головы у трёхмесячных — около 1.2 см на одну z-оценку, а расхождение между двумя обмерами лентой подряд бывает в полсантиметра. Поэтому меряют трижды и берут наибольшее, а выводы делают по цифрам с приёма, а не по домашним.",
};

/**
 * Два раздела верхнего уровня, у каждого свой набор нижних вкладок.
 * Разделение не косметическое: «Сон» — это то, что смотрят по
 * несколько раз в день, «Здоровье» — то, что открывают раз в неделю.
 * Держать их в одном ряду значило заставлять часто нажимаемое
 * соседствовать с редким.
 *
 * Вторая вкладка раздела «Сон» называется «День», а не «Сегодня»:
 * она листается стрелками на любую прошлую дату, и «Сегодня» было бы
 * обещанием, которого экран не выполняет.
 */
const SECTIONS = {
  sleep: {
    label: "Сон",
    tabs: [["now", "Сейчас"], ["day", "День"], ["week", "Неделя"]],
  },
  health: {
    label: "Здоровье",
    tabs: IND_KEYS.map((k) => [k, IND[k].tab]),
  },
};

/** Виды уведомлений: ключ, подпись, пояснение. */
const NOTIFY_KINDS = [
  ["sleep", "Пора укладывать", "Приходит в начале фазы успокоения, по прогнозу окна сна."],
  ["feed", "Можно кормить", "Приходит, когда желудок освободился и прошёл обычный для ребёнка промежуток. Только днём, с 7 до 22."],
];

const FEED_LABEL = {
  breast: "Грудь", left: "ГВ, левая", right: "ГВ, правая",
  formula: "Смесь", ebm: "Сцеженное молоко", solid: "Прикорм", water: "Вода",
};

/** Что предлагается по кнопке «Бутылочка». */
const BOTTLE_KINDS = [["formula", "Смесь"], ["ebm", "Молоко"], ["water", "Вода"]];
const DIAPER_LABEL = { wet: "Мокрый", dirty: "Стул", mixed: "Мокрый и стул" };

// Ветка по умолчанию раньше отсутствовала, и ЛЮБОЙ незнакомый тип
// молча становился «Подгузник» — из-за этого запись о болезни
// показывалась в дневнике как подгузник.
const eventTitle = (e, nights) =>
  e.type === "sleep"
    ? isNight(e, nights) ? "Ночной сон" : "Сон"
    : e.type === "feed"
    ? FEED_LABEL[e.meta?.kind] +
      (e.meta?.ml ? ` · ${e.meta.ml} мл` : "") +
      (Number.isFinite(e.meta?.sec) ? ` · ${Math.round(e.meta.sec / 60)} мин` : "")
    : e.type === "diaper"
    ? DIAPER_LABEL[e.meta?.kind] || "Подгузник"
    : e.type === "illness"
    ? "Болезнь"
    : IND[e.type]
    ? `${IND[e.type].title} · ${valueText(IND[e.type], e.meta[IND[e.type].metaKey] || 0)} ${IND[e.type].unit}`
    : e.type;

const eventColor = (e) =>
  e.type === "sleep" ? "#6c7bd9"
    : e.type === "feed" ? "#e8a33d"
    : e.type === "illness" ? "#c46a5a"
    : IND[e.type] ? IND[e.type].color
    : "#5f9e86";

/**
 * Взвешивание записывается на полдень указанного дня. Точное время
 * никто не вводит, а полдень не уезжает в соседние сутки при смене
 * часового пояса или переводе часов.
 */
const noonOf = (isoStr) => {
  const [y, m, d] = isoStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
};

/* ================================================================== */

export default function App() {
  const [state, setState] = useState(null);
  const [section, setSection] = useState("sleep");
  const [tab, setTab] = useState("now");
  const [tick, setTick] = useState(Date.now());
  const [toast, setToast] = useState(null);
  const [quick, setQuick] = useState(null);
  const [bottle, setBottle] = useState("formula");
  const [editing, setEditing] = useState(null);
  const [offset, setOffset] = useState(0);
  const [net, setNet] = useState({ status: "idle", error: null });
  const [joinTok, setJoinTok] = useState(() => readJoinToken());
  const [joinErr, setJoinErr] = useState(null);
  const [joinBusy, setJoinBusy] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const toastTimer = useRef(null);

  useEffect(() => { loadState().then(setState); }, []);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  /* ---------- сохранение и синхронизация ---------- */

  const update = useCallback((fn) => {
    setState((prev) => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      saveState(next);
      return next;
    });
  }, []);

  const runSync = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.auth?.token) return;
    setNet((n) => ({ ...n, status: "syncing" }));
    try {
      const merged = await syncOnce(s);
      if (merged) {
        setState(merged);
        saveState(merged);
      }
      setNet({ status: "ok", error: null, at: Date.now() });
    } catch (e) {
      setNet({ status: "offline", error: e.message === "unauthorized" ? "unauthorized" : null });
    }
  }, []);

  useEffect(() => {
    if (!state?.auth?.token) return;
    runSync();
    const t = setInterval(runSync, 30000);
    const onVisible = () => document.visibilityState === "visible" && runSync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", runSync);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", runSync);
    };
  }, [state?.auth?.token, runSync]);

  const doRelink = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    setNet({ status: "syncing", error: null });
    try {
      const next = await relink(s);
      setState(next);
      saveState(next);
      const merged = await syncOnce(next);
      if (merged) {
        setState(merged);
        saveState(merged);
      }
      setNet({ status: "ok", error: null, at: Date.now() });
    } catch (e) {
      setNet({ status: "offline", error: "Не получилось перепривязать. Проверьте, что сервер отвечает." });
    }
  }, []);

  /**
   * Подключение к общему дневнику по ссылке. Локальные записи не
   * затираются: они помечаются неотправленными и уезжают на сервер,
   * а встречные приходят оттуда. Слияние по updatedAt, id у записей
   * уникальные, поэтому дублей не возникает.
   */
  const doJoin = useCallback(async (token) => {
    const s = stateRef.current;
    setJoinBusy(true);
    setJoinErr(null);
    try {
      const next = {
        ...s,
        auth: { token },
        rev: 0,
        profileDirty: false,
        events: (s.events || []).map((e) => ({ ...e, dirty: true })),
      };
      const merged = (await syncOnce(next)) || next;
      setState(merged);
      saveState(merged);
      history.replaceState(null, "", import.meta.env.BASE_URL);
      setJoinTok(null);
      setNet({ status: "ok", error: null, at: Date.now() });
    } catch (e) {
      setJoinErr(
        e.message === "unauthorized"
          ? "Ссылка не подошла — попросите прислать новую."
          : "Сервер недоступен. Попробуйте ещё раз."
      );
    } finally {
      setJoinBusy(false);
    }
  }, []);

  const flash = (text, undo) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  /* ---------- действия ---------- */

  const events = useMemo(() => liveEvents(state?.events || []), [state]);

  /*
   * Какие записи относятся к ночи с учётом склейки. Считается один раз
   * на рендер и передаётся вниз: без этого сон в 05:45 после кормления
   * в 05:19 показывался бы как дневной и попадал бы в счётчик «снов
   * днём», хотя это продолжение той же ночи.
   */
  // state.profile, а НЕ profile: деструктуризация { profile, bias } идёт
  // ниже по функции, и обращение к ней отсюда падает в мёртвую зону
  // объявления — сборка такое не ловит, приложение показывает пустой фон
  const nights = useMemo(
    () => nightFragments(events, state?.profile?.birth, tick),
    [events, state?.profile?.birth, tick]
  );
  const active = events.find((e) => e.type === "sleep" && !e.end);

  const putEvent = (ev) =>
    update((s) => {
      const rest = s.events.filter((e) => e.id !== ev.id);
      return { ...s, events: [...rest, { ...ev, updatedAt: Date.now(), dirty: true }] };
    });

  const toggleSleep = () => {
    if (active) {
      const snapshot = active;
      putEvent({ ...active, end: Date.now() });
      flash(`Проснулся · ${dur(Date.now() - active.start)}`, () => putEvent(snapshot));
    } else {
      const ev = { id: uid(), type: "sleep", start: Date.now(), end: null };
      putEvent(ev);
      flash("Заснул", () => putEvent({ ...ev, deleted: true }));
    }
    setTimeout(runSync, 800);
  };

  const logEvent = (type, meta) => {
    const ev = { id: uid(), type, start: Date.now(), end: Date.now(), meta };
    putEvent(ev);
    flash(eventTitle(ev, nights), () => putEvent({ ...ev, deleted: true }));
    setQuick(null);
    setTimeout(runSync, 800);
  };

  const setSettle = (ev, kind) => {
    const cur = settleOf(ev);
    const next = cur === kind ? undefined : kind;
    putEvent({ ...ev, meta: { ...(ev.meta || {}), settle: next } });
    setTimeout(runSync, 800);
  };

  // Период болезни задаётся датами, а не таймером: болезнь чаще всего
  // отмечают задним числом, когда уже понятно, что это была она.
  // Незакрытый период (end === null) означает «болеет до сих пор».
  const openIllness = events.find((e) => e.type === "illness" && !e.end);

  const saveIllness = ({ id, from, to }) => {
    const ev = {
      id: id || uid(),
      type: "illness",
      start: from,
      end: to,
    };
    putEvent(ev);
    flash(id ? "Период болезни обновлён" : "Период болезни добавлен");
    setTimeout(runSync, 800);
  };

  const removeIllness = (ev) => {
    const snapshot = { ...ev };
    putEvent({ ...ev, deleted: true });
    flash("Период удалён", () => putEvent(snapshot));
    setTimeout(runSync, 800);
  };

  const shift = (ev, field, mins) => putEvent({ ...ev, [field]: ev[field] + mins * MIN });

  /* ---------- кормление грудью по таймеру ---------- */

  /*
   * Незакрытое кормление — то же соглашение, что и у сна: end === null
   * означает «идёт сейчас». Длительность на закрытии кладётся в
   * meta.sec, а не выводится из end − start: запись потом можно
   * подвинуть по времени, и длительность от этого меняться не должна.
   */
  // ВСЕ незакрытые, а не первая попавшаяся: если по любой причине
  // открылось несколько, одна кнопка должна закрывать их разом,
  // иначе таймер выглядит незакрываемым
  const nursingAll = events.filter(
    (e) => e.type === "feed" && !e.end && !e.deleted && e.meta?.kind === "breast"
  );
  const nursing = nursingAll[0] || null;

  const startNursing = () => {
    if (nursing) return; // второе открытое кормление не заводим
    const ev = { id: uid(), type: "feed", start: Date.now(), end: null, meta: { kind: "breast" } };
    putEvent(ev);
    flash("Кормление грудью начато", () => putEvent({ ...ev, deleted: true }));
    setTimeout(runSync, 800);
  };

  const stopNursing = () => {
    if (!nursing) return;
    const now = Date.now();
    const snapshot = nursingAll.map((e) => ({ ...e }));
    for (const e of nursingAll) {
      const sec = Math.max(Math.round((now - e.start) / 1000), 30);
      putEvent({ ...e, end: now, meta: { ...e.meta, sec } });
    }
    const sec = Math.max(Math.round((now - nursing.start) / 1000), 30);
    flash(`Грудь · ${Math.round(sec / 60)} мин`, () => snapshot.forEach(putEvent));
    setTimeout(runSync, 800);
  };

  /* ---------- антропометрия ---------- */

  const addMeasure = (ind, value, ts) => {
    const ev = {
      id: uid(), type: ind.key, start: ts, end: ts,
      meta: { [ind.metaKey]: value },
    };
    putEvent(ev);
    flash(`${ind.title} ${valueText(ind, value)} ${ind.unit}`,
      () => putEvent({ ...ev, deleted: true }));
    setTimeout(runSync, 800);
  };

  const setSex = (sex) =>
    update((s) => ({
      ...s,
      profile: { ...s.profile, sex, updatedAt: Date.now() },
      profileDirty: true,
    }));

  const removeEvent = (ev) => {
    putEvent({ ...ev, deleted: true });
    setEditing(null);
    flash("Запись удалена", () => putEvent({ ...ev, deleted: false }));
    setTimeout(runSync, 800);
  };

  /* ---------- экраны ---------- */

  if (!state) return <Splash text="Загружаю записи…" />;

  // ссылка пришла на телефон, где приложение уже настроено
  if (
    joinTok &&
    state.auth?.token !== joinTok &&
    (state.profile || (state.events || []).length)
  ) {
    return (
      <JoinPrompt
        busy={joinBusy}
        err={joinErr}
        count={(state.events || []).filter((e) => !e.deleted).length}
        onJoin={() => doJoin(joinTok)}
        onSkip={() => {
          history.replaceState(null, "", import.meta.env.BASE_URL);
          setJoinTok(null);
        }}
      />
    );
  }

  if (!state.profile || !state.auth) {
    return <Onboarding onReady={(s) => { update(s); setTimeout(runSync, 300); }} />;
  }

  const { profile, bias } = state;
  // predictNext сам измеряет личную поправку по хвосту истории
  // (~3 мс на 90 днях) и применяет её — отдельно её считать не нужно
  const win = active ? null : predictNext(events, profile.birth, tick, bias || 0);
  const napRef = active ? typicalNap(events, active.start, 10, profile.birth) : null;
  const todayStart = startOfDay(tick);
  const pending = (state.events || []).filter((e) => e.dirty).length;

  return (
    <div className="bt">
      <div className="bt-shell">
        <header className="bt-head">
          <span className="bt-name">{profile.name}</span>
          <span className="bt-age">{ageText(profile.birth, tick)}</span>
        </header>

        <div className="seg">
          {Object.entries(SECTIONS).map(([k, sec]) => (
            <button
              key={k}
              className={"seg-b" + (section === k ? " on" : "")}
              onClick={() => {
                // переключая раздел, всегда открываем его первую вкладку:
                // иначе экран остался бы от прошлого раздела и нижние
                // кнопки показывали бы не то, что открыто
                setSection(k);
                setTab(sec.tabs[0][0]);
              }}
            >
              {sec.label}
            </button>
          ))}
        </div>

        {tab === "now" && (
          <>
            {openIllness && (
              <div className="bt-card sick">
                <div className="sick-t">Болезнь · с {dayLabel(startOfDay(openIllness.start))}</div>
                <p className="hint" style={{ marginTop: 6 }}>
                  Записи за это время не идут в обучение: приложение не запомнит
                  сбитый болезнью ритм как норму. Прогноз пока строится по тому,
                  что было до, и сейчас он менее точен. Дату выздоровления
                  проставьте на вкладке «Неделя».
                </p>
              </div>
            )}

            <div className="rib-wrap">
              <Ribbon events={events} dayStart={todayStart} showNow />
              <Axis />
            </div>

            <section className="bt-card">
              <div className="state">
                <div className="state-label">
                  {active ? (isNight(active, nights) ? "Ночной сон" : "Спит") : "Бодрствует"}
                </div>
                <div className="state-time bt-num">
                  {active ? dur(tick - active.start) : win ? dur(tick - win.wokeAt) : "—"}
                </div>
                <div className="state-since">
                  {active ? (
                    <>
                      <button className="nudge" onClick={() => shift(active, "start", -5)}>−5</button>
                      <span className="bt-num">с {hhmm(active.start)}</span>
                      <button className="nudge" onClick={() => shift(active, "start", 5)}>+5</button>
                    </>
                  ) : win ? (
                    <span className="bt-num">проснулся в {hhmm(win.wokeAt)}</span>
                  ) : (
                    <span>Первая запись — нажмите «Заснул»</span>
                  )}
                </div>
              </div>

              {win && <WindowBar win={win} now={tick} />}
              {active && !isNight(active, nights) && (
                <>
                  <NapNote start={active.start} now={tick} typical={napRef} />
                  <SettlePicker
                    value={settleOf(active)}
                    onPick={(k) => setSettle(active, k)}
                    hint="Только если было что отметить. Обычные укладывания отмечать не нужно — приложение считает их нормой."
                  />
                </>
              )}

              <button className={"big " + (active ? "wake" : "sleep")} onClick={toggleSleep}>
                {active ? "Проснулся" : "Заснул"}
              </button>
            </section>

            <div className="quick">
              <button className={"qbtn" + (nursing ? " on" : "")}
                onClick={nursing ? stopNursing : startNursing}>
                {nursing ? `Грудь · ${durShort(tick - nursing.start)}` : "Грудь"}
              </button>
              <button className="qbtn" onClick={() => setQuick(quick === "bottle" ? null : "bottle")}>Бутылочка</button>
              <button className="qbtn" onClick={() => setQuick(quick === "diaper" ? null : "diaper")}>Подгузник</button>
            </div>

            {nursing && (
              <>
                <button className="big wake" onClick={stopNursing}>
                  Закончить кормление · {durShort(tick - nursing.start)}
                </button>
                <p className="hint">
                  Длительность пересчитается в вероятный объём.
                  {nursingAll.length > 1 &&
                    ` Открытых кормлений ${nursingAll.length} — закроются все разом.`}
                </p>
              </>
            )}

            {quick === "bottle" && (
              <>
                <div className="chips">
                  {BOTTLE_KINDS.map(([k, l]) => (
                    <button key={k}
                      className={"chip" + (bottle === k ? " on" : "")}
                      onClick={() => setBottle(k)}>{l}</button>
                  ))}
                </div>
                <div className="chips">
                  {[20, 30, 40, 60, 80, 100, 120, 150, 180].map((ml) => (
                    <button key={ml} className="chip" onClick={() => {
                      logEvent("feed", { kind: bottle, ml });
                      setQuick(null);
                    }}>{ml} мл</button>
                  ))}
                </div>
                <p className="hint">
                  {bottle === "ebm"
                    ? "Сцеженное грудное молоко: объём известен точно, и опорожняется оно как грудное, а не как смесь."
                    : bottle === "water"
                    ? "Вода в расчёт наполнения желудка не идёт: уходит быстро и своих констант у нас для неё нет."
                    : "Смесь задерживается в желудке дольше грудного молока — 65 минут против 47."}
                </p>
              </>
            )}
            {quick === "diaper" && (
              <div className="chips">
                {Object.entries(DIAPER_LABEL).map(([k, v]) => (
                  <button key={k} className="chip" onClick={() => logEvent("diaper", { kind: k })}>{v}</button>
                ))}
              </div>
            )}

            <FeedNote events={events} profile={profile} now={tick} feedsPerDay={state.feedsPerDay ?? null} />

            <Kpis stats={dayStats(events, todayStart, nights)} title="Сегодня" />
          </>
        )}

        {tab === "day" && (
          <DayView events={events} nights={nights} offset={offset} setOffset={setOffset} onPick={setEditing} />
        )}

        {IND[tab] && (
          <MeasureView ind={IND[tab]} profile={profile} events={events} now={tick}
            onAdd={addMeasure} onSex={setSex} onPick={setEditing} />
        )}

        {tab === "week" && (
          <WeekView state={state} events={events} nights={nights} update={update}
            onSaveIllness={saveIllness} onRemoveIllness={removeIllness} />
        )}

        <NetLine net={net} pending={pending} onRetry={runSync} onRelink={doRelink} />
      </div>

      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { toast.undo(); setToast(null); }}>Отменить</button>}
        </div>
      )}

      {editing && (
        <EditSheet
          ev={events.find((e) => e.id === editing.id) || editing}
          nights={nights}
          onShift={(field, m) => {
            const cur = events.find((e) => e.id === editing.id);
            if (cur) shift(cur, field, m);
          }}
          onMl={(d) => {
            const cur = events.find((e) => e.id === editing.id);
            if (cur) putEvent({ ...cur, meta: { ...cur.meta, ml: Math.max(0, (cur.meta?.ml || 0) + d) } });
          }}
          onValue={(d) => {
            const cur = events.find((e) => e.id === editing.id);
            const ind = cur && IND[cur.type];
            if (!ind) return;
            const next = Math.min(Math.max((cur.meta?.[ind.metaKey] || 0) + d, ind.min), ind.max);
            putEvent({ ...cur, meta: { ...cur.meta, [ind.metaKey]: next } });
          }}
          onNight={(v) => {
            const cur = events.find((e) => e.id === editing.id);
            if (!cur) return;
            const meta = { ...cur.meta };
            if (v === null) delete meta.night;
            else meta.night = v;
            putEvent({ ...cur, meta });
          }}
          onDays={(d) => {
            const cur = events.find((e) => e.id === editing.id);
            if (!cur) return;
            const ts = cur.start + d * DAY;
            putEvent({ ...cur, start: ts, end: ts });
          }}
          onClose={() => setEditing(null)}
          onSettle={(k) => {
            const cur = events.find((e) => e.id === editing.id);
            if (cur) setSettle(cur, k);
          }}
          onDelete={() => removeEvent(events.find((e) => e.id === editing.id) || editing)}
        />
      )}

      <nav className="tabs">
        <div className="tabs-in">
          {SECTIONS[section].tabs.map(([k, l]) => (
            <button key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/* ================================================================== */

const Splash = ({ text }) => (
  <div className="bt"><div className="bt-shell"><div className="empty">{text}</div></div></div>
);

const Axis = () => (
  <div className="rib-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
);

function Ribbon({ events, dayStart, showNow, height }) {
  const segs = daySegments(events, dayStart);
  const ticks = height
    ? []
    : events.filter((e) => e.type === "feed" && e.start >= dayStart && e.start < dayStart + DAY);
  const nowPct = ((Date.now() - dayStart) / DAY) * 100;
  return (
    <div className="rib" style={height ? { height } : undefined}>
      {segs.map((s, i) => (
        <div key={i} className={"rib-seg" + (s.live ? " live" : "")}
          style={{ left: `${(s.from / DAY) * 100}%`, width: `${((s.to - s.from) / DAY) * 100}%` }} />
      ))}
      {ticks.map((t) => (
        <div key={t.id} className="rib-tick" style={{ left: `${((t.start - dayStart) / DAY) * 100}%` }} />
      ))}
      {showNow && nowPct >= 0 && nowPct <= 100 && (
        <div className="rib-now" style={{ left: `${nowPct}%` }} />
      )}
    </div>
  );
}

function WindowBar({ win, now }) {
  if (win.stale) {
    return (
      <div className="win">
        <p className="hint" style={{ marginTop: 0 }}>
          Последняя запись — {hhmm(win.wokeAt)}, это было давно. Прогноз от неё
          строить нечего: отметьте ближайший сон, и расчёт снова заработает.
        </p>
      </div>
    );
  }

  const span = win.to - win.wokeAt;
  const at = (t) => Math.min(Math.max(((t - win.wokeAt) / span) * 100, 0), 100);
  const pct = Math.min(((now - win.wokeAt) / span) * 100, 100);
  const past = now > win.to;
  const inWin = now >= win.from && now <= win.to;
  const calming = now >= win.calm && now < win.from;

  const phase = past
    ? { label: "Перегул", cls: "over" }
    : inWin
    ? { label: "Окно сна", cls: "sleep" }
    : calming
    ? { label: "Успокоение", cls: "calm" }
    : { label: "Активное бодрствование", cls: "active" };

  return (
    <div className="win">
      <div className="win-bar">
        <div className="win-zone calm"
          style={{ left: `${at(win.calm)}%`, width: `${at(win.from) - at(win.calm)}%` }} />
        <div className="win-zone" style={{ left: `${at(win.from)}%`, right: 0 }} />
        <div className="win-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className={"phase " + phase.cls}>{phase.label}</div>

      <div className="win-text bt-num">
        {past ? (
          <>Окно прошло <b>{durShort(now - win.to)}</b> назад</>
        ) : inWin ? (
          <>Окно открыто до <b>{hhmm(win.to)}</b></>
        ) : calming ? (
          <>Пора сворачивать активность · окно с <b>{hhmm(win.from)}</b></>
        ) : (
          <>Успокаиваться с <b>{hhmm(win.calm)}</b> · окно {hhmm(win.from)} – {hhmm(win.to)}</>
        )}
      </div>
      {!win.circadian && (
        <p className="hint">
          До трёх месяцев циркадный ритм ещё не сформирован — сон в этом
          возрасте определяется голодом, а не временем суток. Окно широкое
          намеренно: это возрастной ориентир, а не расчёт по режиму.
        </p>
      )}
      {win.circadian && !win.knownMorning && (
        <p className="hint">
          Утренний подъём не отмечен — считаю от 07:00. Отметьте ночной сон,
          и прогноз станет точнее.
        </p>
      )}
    </div>
  );
}

/**
 * Оценка идущего сна. Порог «короткого» — относительный, от медианы
 * дневных снов самого ребёнка: тот же 0.7, что и в predictWindow.
 * Абсолютные 45 минут в 3-5 месяцев срабатывали бы почти на каждом
 * сне, когда все они становятся односцикловыми.
 *
 * Порог «поверхностного» остаётся абсолютным намеренно: цикл сна
 * у младенца длится порядка 40-50 минут, и пробуждение до 25 минут
 * означает неполный цикл независимо от того, какая у ребёнка медиана.
 */
function NapNote({ start, now, typical }) {
  const len = (now - start) / MIN;
  const short = typical != null ? typical * 0.7 : 45;
  return (
    <div className="win-text" style={{ marginTop: 16 }}>
      {len < 25
        ? "Меньше 25 минут — сон, скорее всего, поверхностный"
        : len < short
        ? `Короткий для него${typical != null ? ` (медиана ${Math.round(typical)} мин)` : ""} · следующее окно стоит сократить`
        : "Полноценный сон"}
    </div>
  );
}

function Kpis({ stats, title }) {
  return (
    <>
      {title && <div className="sec">{title}</div>}
      <div className="kpi">
        <div><div className="kpi-v bt-num">{durShort(stats.total)}</div><div className="kpi-l">всего сна</div></div>
        <div><div className="kpi-v bt-num">{durShort(stats.day)}</div><div className="kpi-l">дневного</div></div>
        <div><div className="kpi-v bt-num">{stats.naps}</div><div className="kpi-l">снов днём</div></div>
        <div><div className="kpi-v bt-num">{stats.feeds}</div><div className="kpi-l">кормлений</div></div>
      </div>
    </>
  );
}

function NetLine({ net, pending, onRetry, onRelink }) {
  if (net.error === "unauthorized") {
    return (
      <div className="bt-card" style={{ marginTop: 22 }}>
        <p className="hint" style={{ marginTop: 0 }}>
          Сервер не узнаёт эту ссылку — обычно так бывает, если база на
          сервере пересоздалась. Записи на телефоне целы. Перепривязка
          заведёт дневник заново и отправит туда всю вашу историю.
        </p>
        <button className="sact ghost full" onClick={onRelink}>
          Перепривязать к серверу
        </button>
        <p className="hint">
          Старая ссылка для второго родителя перестанет работать — после
          перепривязки отправьте новую из раздела «Неделя».
        </p>
      </div>
    );
  }
  if (net.error) {
    return <div className="net err">{net.error}</div>;
  }
  if (pending > 0 || net.status === "offline") {
    return (
      <div className="net">
        {net.status === "offline" ? "Нет связи с сервером" : "Отправляю"}
        {pending > 0 ? ` · ${pending} записей ждут` : ""}
        <button onClick={onRetry}>Повторить</button>
      </div>
    );
  }
  return <div className="net ok">Синхронизировано</div>;
}

/* ================================================================== */

function DayView({ events, nights, offset, setOffset, onPick }) {
  const dayStart = startOfDay(Date.now()) - offset * DAY;
  // отбор по пересечению с сутками, а не по времени начала: иначе
  // ночной сон, начатый вчера, даёт минуты в статистике, но не виден
  // в списке — и суммы не сходятся
  const list = events
    .filter((e) => {
      // болезнь — период, а не запись дня: в списке ей не место
      if (e.type === "illness") return false;
      const end = e.type === "sleep" ? e.end ?? Date.now() : e.start;
      return end >= dayStart && e.start < dayStart + DAY;
    })
    .sort((a, b) => b.start - a.start);
  const s = dayStats(events, dayStart, nights);

  return (
    <>
      <div className="bt-head" style={{ marginBottom: 10 }}>
        <button className="nudge wide" onClick={() => setOffset(offset + 1)}>←</button>
        <span className="bt-name">{dayLabel(dayStart)}</span>
        <button className="nudge wide" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 1))}>→</button>
      </div>

      <div className="rib-wrap">
        <Ribbon events={events} dayStart={dayStart} showNow={offset === 0} />
        <Axis />
      </div>

      <div className="kpi">
        <div><div className="kpi-v bt-num">{durShort(s.total)}</div><div className="kpi-l">всего сна</div></div>
        <div><div className="kpi-v bt-num">{durShort(s.night)}</div><div className="kpi-l">ночного</div></div>
        <div><div className="kpi-v bt-num">{s.naps}</div><div className="kpi-l">снов днём</div></div>
        <div><div className="kpi-v bt-num">{s.feeds} / {s.diapers}</div><div className="kpi-l">кормлений / подгузников</div></div>
      </div>

      <div className="sec">Записи</div>
      <div className="bt-card list">
        {list.length === 0 ? (
          <div className="empty">За этот день записей нет.</div>
        ) : (
          list.map((e) => (
            <button className="row" key={e.id} onClick={() => onPick(e)}>
              <span className="dot" style={{ background: eventColor(e) }} />
              <span className="row-main">
                <span className="row-t">{eventTitle(e, nights)}</span>
                <span className="row-s bt-num">
                  {e.start < dayStart && "вчера "}
                  {hhmm(e.start)}{e.type === "sleep" && (e.end ? ` – ${hhmm(e.end)}` : " – сейчас")}
                </span>
              </span>
              {e.type === "sleep" && (
                <span className="row-r bt-num">{dur((e.end ?? Date.now()) - e.start)}</span>
              )}
            </button>
          ))
        )}
      </div>
      <p className="hint">Нажмите на запись, чтобы поправить время или удалить.</p>
    </>
  );
}

/** Ввод дат — YYYY-MM-DD, локальная полночь. */
const toInput = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fromInput = (v, endOfDay = false) => {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  return endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
};

/**
 * Периоды болезни задаются датами, а не таймером: болезнь обычно
 * отмечают задним числом, когда уже понятно, что это была она,
 * и «сейчас заболел / сейчас выздоровел» почти никогда не совпадает
 * с реальными границами.
 *
 * Дату окончания можно оставить пустой — тогда период открытый
 * («болеет до сих пор»).
 */
function IllnessCard({ periods, onSave, onRemove }) {
  const [editId, setEditId] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const open = (p) => {
    setEditId(p ? p.id : "new");
    setFrom(p ? toInput(p.start) : toInput(Date.now()));
    setTo(p && p.end ? toInput(p.end) : "");
  };
  const close = () => setEditId(null);

  const save = () => {
    const start = fromInput(from);
    const end = fromInput(to, true);
    if (!start) return;
    if (end && end < start) return;
    onSave({ id: editId === "new" ? null : editId, from: start, to: end });
    close();
  };

  const bad = from && to && fromInput(to, true) < fromInput(from);

  return (
    <div className="bt-card">
      <p className="hint" style={{ marginTop: 0 }}>
        Болезнь сбивает ритм сна, и если эти дни попадут в расчёт, приложение
        запомнит их как норму ребёнка. Отмеченные периоды исключаются из
        обучения, но остаются видны в дневнике.
      </p>

      {periods.length > 0 && (
        <div className="ill-list">
          {periods.map((p) => (
            <div className="ill-row" key={p.id}>
              <span className="ill-d bt-num">
                {dayLabel(startOfDay(p.start))} –{" "}
                {p.end ? dayLabel(startOfDay(p.end)) : "по сей день"}
              </span>
              <span className="ill-act">
                <button className="nudge" onClick={() => open(p)}>Изменить</button>
                <button className="nudge" onClick={() => onRemove(p)}>Убрать</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {editId ? (
        <>
          <div className="field">
            <span className="field-l">Начало</span>
            <input className="ill-in" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-l">Окончание</span>
            <input className="ill-in" type="date" value={to}
              onChange={(e) => setTo(e.target.value)} />
          </div>
          <p className="hint">
            {bad
              ? "Окончание раньше начала — исправьте даты."
              : to
              ? "День окончания входит в период целиком."
              : "Пустое окончание — болезнь продолжается."}
          </p>
          <div className="sheet-act">
            <button className="sact ghost" onClick={close}>Отмена</button>
            <button className="sact ghost" disabled={!from || bad} onClick={save}>
              Сохранить
            </button>
          </div>
        </>
      ) : (
        <button className="sact ghost full" onClick={() => open(null)}>
          Добавить период болезни
        </button>
      )}
    </div>
  );
}

function WeekView({ state, events, nights, update, onSaveIllness, onRemoveIllness }) {
  const [copied, setCopied] = useState(false);
  const [tgLink, setTgLink] = useState(null);
  const [tgErr, setTgErr] = useState(false);
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY);
  const stats = days.map((d) => dayStats(events, d, nights));
  // Из средних выбрасываются обрезанные сутки: первый день ведения
  // дневника (он всегда начат с середины) и сегодняшний, который ещё
  // не закончился. Раньше сегодняшний считался как полный и занижал
  // всё на несколько часов — по нему нельзя было читать динамику.
  const withData = stats.map((s, i) => ({ s, i })).filter(({ s }) => s.total > 0);
  const drop = new Set();
  if (withData.length > 1) drop.add(withData[0].i);
  const kept = () => withData.filter(({ i }) => !drop.has(i));
  // сегодняшний день выбрасывается только если после этого хоть что-то
  // останется: в первый же день ведения дневника средние иначе обнулятся
  if (kept().length > 1 && kept().some(({ i }) => i === 6)) drop.add(6);
  const counted = kept().map(({ s }) => s);
  const todayExcluded = drop.has(6);
  const avg = (f) => (counted.length ? counted.reduce((a, s) => a + f(s), 0) / counted.length : 0);

  const napNow = medianNapIn(events, today - 6 * DAY, today + DAY, nights);
  const napBefore = medianNapIn(events, today - 13 * DAY, today - 6 * DAY, nights);
  const norm = sleepNorm(ageMonths(state.profile.birth, Date.now()));
  const weekEnd = today + DAY;
  const illnessEvents = events
    .filter((e) => e.type === "illness" && !e.deleted)
    .sort((a, b) => b.start - a.start);
  const check = selfCheck(events, state.profile.birth);
  const shares = settleShare(events, Date.now(), state.profile.birth);
  const bias = measureBias(events, state.profile.birth);
  const auto = autoBias(bias, shares.hardShare, shares.alertShare);
  // поправка может оказаться не числом, а парой «утро/вечер»
  const profile_ = biasProfile(bias, shares.hardShare, shares.alertShare);
  const win_slope = typeof profile_ === "object" ? profile_ : null;
  const nudge = settleNudge(events, Date.now());
  // сработал ли предохранитель: фильтры по меткам съели данные,
  // а сырое расхождение велико
  const rawFallback =
    bias && !bias.usable && bias.raw && Math.abs(bias.raw.median) >= RAW_ALARM;
  const settleNow = settleStats(events, weekEnd - 7 * DAY, weekEnd, state.profile.birth);
  const settleBefore = settleStats(events, weekEnd - 14 * DAY, weekEnd - 7 * DAY, state.profile.birth);
  const link = inviteLink(state.auth.token);

  useEffect(() => {
    fetchTelegramLink(state.auth.token).then(
      (url) => (url ? setTgLink(url) : setTgErr(true)),
      () => setTgErr(true)
    );
  }, [state.auth.token]);

  return (
    <>
      <div className="sec" style={{ marginTop: 0 }}>Последние 7 дней</div>
      {days.map((d, i) => (
        <div className="week-row" key={d}>
          <span className="week-lab">
            {new Date(d).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric" })}
          </span>
          <div className="week-rib"><Ribbon events={events} dayStart={d} height={16} /></div>
          <span className="week-tot bt-num">{stats[i].total ? durShort(stats[i].total) : "—"}</span>
        </div>
      ))}

      <div className="sec">
        В среднем за сутки{counted.length ? ` · ${counted.length} дн` : ""}
      </div>
      <div className="kpi">
        <div><div className="kpi-v bt-num">{durShort(avg((s) => s.total))}</div><div className="kpi-l">всего сна</div></div>
        <div><div className="kpi-v bt-num">{durShort(avg((s) => s.night))}</div><div className="kpi-l">ночного</div></div>
        <div><div className="kpi-v bt-num">{durShort(avg((s) => s.day))}</div><div className="kpi-l">дневного</div></div>
        <div><div className="kpi-v bt-num">{avg((s) => s.naps).toFixed(1)}</div><div className="kpi-l">снов днём</div></div>
      </div>

      <p className="hint">
        {!norm
          ? "Для возраста младше 4 месяцев суточной нормы сна не существует — разброс слишком велик. Сравнивать не с чем, смотрите на динамику."
          : (() => {
              const h = avg((s) => s.total) / 3600000;
              const v = h === 0 ? "Данных пока мало." :
                h < norm[0] ? `Ниже рекомендованных ${norm[0]}–${norm[1]} ч.` :
                h > norm[1] ? `Выше рекомендованных ${norm[0]}–${norm[1]} ч.` :
                `В пределах рекомендованных ${norm[0]}–${norm[1]} ч.`;
              return `${v} Норма считается за 24 часа вместе с дневными снами. Часть снов вы наверняка забыли отметить, так что цифра снизу.`;
            })()}
      </p>

      {(napNow != null || todayExcluded) && (
        <p className="hint">
          {napNow != null && (
            <>
              Медиана дневного сна за неделю — <b>{Math.round(napNow)} мин</b>
              {napBefore != null && (
                <>, неделей раньше <b>{Math.round(napBefore)} мин</b></>
              )}.{" "}
            </>
          )}
          {todayExcluded && "Сегодняшний день в средние не входит — сутки ещё не закончились."}
        </p>
      )}

      <div className="sec">Болезнь</div>
      <IllnessCard
        periods={illnessEvents}
        onSave={onSaveIllness}
        onRemove={onRemoveIllness}
      />

      <div className="sec">Как проходят укладывания</div>
      <div className="bt-card">
        {settleNow.total === 0 ? (
          <p className="hint" style={{ marginTop: 0 }}>
            Записей за неделю пока нет.
          </p>
        ) : settleNow.marked === 0 ? (
          <p className="hint" style={{ marginTop: 0 }}>
            Отмеченных укладываний нет — приложение считает, что всё проходит
            обычно. Если ребёнок плакал и не мог уснуть или наоборот был бодрым
            и не хотел спать, отметьте это на вкладке «Сейчас» или в карточке сна.
          </p>
        ) : (
          <>
            <div className="kpi">
              <div>
                <div className="kpi-v bt-num">{settleNow.hard}</div>
                <div className="kpi-l">плакал</div>
              </div>
              <div>
                <div className="kpi-v bt-num">{settleNow.alert}</div>
                <div className="kpi-l">был бодрый</div>
              </div>
            </div>
            <p className="hint">
              Плакал — <b>{settleNow.hard}</b>
              {settleBefore.marked > 0 && <>, неделей раньше <b>{settleBefore.hard}</b></>}
              . Был бодрый — <b>{settleNow.alert}</b>
              {settleBefore.marked > 0 && <>, было <b>{settleBefore.alert}</b></>}
              {` из ${settleNow.total} дневных снов`}.
              {settleNow.hard > 0
                ? " «Плакал» сдвигает окно раньше."
                : ""}
              {settleNow.alert > 0
                ? " «Был бодрый» само окно не двигает — оно уже растянуто измеренной поправкой; метка лишь позволяет применить её полностью."
                : ""}
            </p>
          </>
        )}
      </div>

      {check && (
        <>
          <div className="sec">Самопроверка</div>
          <div className={"bt-card" + (check.failing ? " sick" : "")}>
            <div className="kpi">
              <div>
                <div className="kpi-v bt-num">{check.corrected}</div>
                <div className="kpi-l">ошибка с поправками</div>
              </div>
              <div>
                <div className="kpi-v bt-num">{check.table}</div>
                <div className="kpi-l">ошибка по голой таблице</div>
              </div>
            </div>
            <p className="hint">
              {check.failing ? (
                <>
                  По {check.n} засыпаниям голая возрастная таблица оказалась
                  точнее, чем алгоритм со всеми поправками. Поправки{" "}
                  <b>временно отключены</b> — приложение считает по таблице,
                  пока картина не изменится. Ручной сдвиг сохраняется.
                </>
              ) : (
                <>
                  По {check.n} засыпаниям поправки точнее голой возрастной
                  таблицы на {check.table - check.corrected} мин. Сравнение
                  смещено в пользу поправок: вы укладывали ребёнка по тому
                  прогнозу, который приложение показывало. Поэтому обратный
                  результат был бы сильным сигналом, а этот — умеренным.
                </>
              )}
            </p>
          </div>
        </>
      )}

      <div className="sec">Поправка на вашего ребёнка</div>
      <div className="bt-card">
        {bias && (bias.usable || bias.raw) ? (
          <>
            {bias.usable && (
              <p className="hint" style={{ marginTop: 0 }}>
                По {bias.n} дневным снам ребёнок засыпает на{" "}
                <b>{bias.median > 0 ? `${bias.median} мин позже` : `${-bias.median} мин раньше`}</b>{" "}
                середины предсказанного окна (медиана, разброс ±{bias.spread} мин).
              </p>
            )}
            {bias.raw && Math.abs(bias.raw.median - (bias.usable ? bias.median : bias.raw.median)) >= 15 && (
              <p className="hint" style={{ marginTop: bias.usable ? undefined : 0 }}>
                Без учёта меток расхождение — <b>{bias.raw.median} мин</b> по {bias.raw.n} снам.
                Разница с цифрой выше означает, что метки укладывания заметно меняют картину.
              </p>
            )}
            {rawFallback && (
              <p className="hint">
                Метки отсеяли почти все наблюдения, а расхождение велико — приложение
                опирается на сырые данные. Обычно это значит, что возрастная таблица
                просто не про вашего ребёнка.
              </p>
            )}
            <div className="field">
              <span className="field-l">Приложение применяет</span>
              <span className="field-v bt-num">
                {auto > 0 ? `+${auto}` : auto} мин
              </span>
            </div>
            {win_slope && (
              <div className="field">
                <span className="field-l">Форма дня (утро / вечер)</span>
                <span className="field-v bt-num">
                  {win_slope.early > 0 ? `+${win_slope.early}` : win_slope.early}
                  {" / "}
                  {win_slope.late > 0 ? `+${win_slope.late}` : win_slope.late} мин
                </span>
              </div>
            )}
            {nudge !== 0 && (
              <>
                <div className="field">
                  <span className="field-l">Сдвиг по меткам укладывания</span>
                  <span className="field-v bt-num">{nudge} мин</span>
                </div>
                <p className="hint">
                  Тяжёлое укладывание означает, что готовность ко сну была раньше
                  записанного засыпания. Окно сдвигается раньше, пока такие
                  укладывания не станут редкими — и сдвиг тогда уйдёт сам.
                </p>
              </>
            )}
            <p className="hint">
              {auto === 0
                ? "Почти не применяется: поправка мала, тонет в разбросе засыпаний или гасится тяжёлыми укладываниями."
                : auto > 0
                ? `Поправка «позже» берётся вполовину и тем слабее, чем чаще укладывания идут тяжело${
                    shares.hardShare ? ` (сейчас ${Math.round(shares.hardShare * 100)}%)` : ""
                  }: сдвинув окно позже, приложение заставит вас класть позже и потом измерит собственный сдвиг как факт о ребёнке.`
                : "Поправка «раньше» берётся целиком: ошибиться рано дёшево — ребёнок не уснул, попробовали через четверть часа."}
            </p>
          </>
        ) : (
          <p className="hint" style={{ marginTop: 0 }}>
            Нужно хотя бы пять дневных снов, чтобы посчитать поправку.
          </p>
        )}
        {state.biasResetFrom != null && (
          <>
            <p className="hint">
              Прежняя ручная поправка{" "}
              <b>{state.biasResetFrom > 0 ? `+${state.biasResetFrom}` : state.biasResetFrom} мин</b>{" "}
              снята. Раньше она хранила всю поправку целиком, теперь приложение
              считает её само — старое значение прибавилось бы вторым разом.
            </p>
            <button
              className="sact ghost full"
              onClick={() => update((s) => ({ ...s, biasResetFrom: null }))}
            >
              Понятно
            </button>
          </>
        )}
        <div className="field">
          <span className="field-l">Ручной сдвиг сверх этого</span>
          <div className="field-c">
            <button
              className="nudge"
              disabled={(state.bias || 0) <= -MANUAL_BIAS_LIMIT}
              onClick={() => update((s) => ({ ...s, bias: Math.max((s.bias || 0) - 5, -MANUAL_BIAS_LIMIT) }))}
            >−5</button>
            <span className="field-v bt-num">{state.bias > 0 ? `+${state.bias}` : state.bias || 0}</span>
            <button
              className="nudge"
              disabled={(state.bias || 0) >= MANUAL_BIAS_LIMIT}
              onClick={() => update((s) => ({ ...s, bias: Math.min((s.bias || 0) + 5, MANUAL_BIAS_LIMIT) }))}
            >+5</button>
          </div>
        </div>
        {(state.bias || 0) !== 0 && (
          <button className="sact ghost full" onClick={() => update((s) => ({ ...s, bias: 0 }))}>
            Сбросить в ноль
          </button>
        )}
      </div>

      <div className="sec">Второй родитель</div>
      <div className="bt-card">
        <p className="hint" style={{ marginTop: 0 }}>
          Откройте эту ссылку на втором телефоне — записи будут общими. Ссылка
          даёт полный доступ к дневнику, поэтому отправляйте её только тому, кому доверяете.
        </p>
        <input className="inp" readOnly value={link} onFocus={(e) => e.target.select()} />
        <button className="sact ghost full" onClick={async () => {
          try {
            if (navigator.share) await navigator.share({ url: link, title: "Дневник сна" });
            else await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch { /* пользователь отменил */ }
        }}>
          {copied ? "Скопировано" : "Поделиться ссылкой"}
        </button>
      </div>

      <div className="sec">Точность прогноза</div>
      <QualityCard state={state} events={events} />

      <div className="sec">Кормления</div>
      <FeedModelCard state={state} events={events} update={update} />

      <div className="sec">Уведомления в Telegram</div>
      <div className="bt-card">
        <p className="hint" style={{ marginTop: 0 }}>
          Бот пришлёт сообщение по тому же расчёту, что показан на вкладке
          «Сейчас». Откройте ссылку в Telegram на телефоне каждого родителя,
          кто хочет получать напоминания.
        </p>

        <NotifyPrefs state={state} update={update} />

        {tgLink ? (
          <a className="sact ghost full" href={tgLink} target="_blank" rel="noreferrer">
            Открыть бота
          </a>
        ) : tgErr ? (
          <p className="hint">Бот сейчас недоступен — попробуйте позже.</p>
        ) : (
          <p className="hint">Загружаю ссылку…</p>
        )}
      </div>

      <div className="sec">Откуда цифры</div>
      <div className="bt-card">
        <p className="hint" style={{ marginTop: 0 }}>
          Суточная норма сна — консенсус Американской академии медицины сна
          (AASM, 2016), поддержанный AAP. Для детей младше 4 месяцев норма не
          установлена: слишком широкий разброс.
        </p>
        <p className="hint">
          Окна бодрствования — сведённые таблицы Huckleberry и Happiest Baby.
          Это эвристика консультантов по сну, а не клинический норматив.
          Сигналы ребёнка точнее любого расчёта. Если сон вызывает тревогу —
          вопрос к педиатру, а не к приложению.
        </p>
      </div>

      <div className="sec">Данные</div>
      <div className="bt-card">
        <button className="sact ghost full" onClick={() => {
          const blob = new Blob([JSON.stringify({ profile: state.profile, events }, null, 1)],
            { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `sleep-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        }}>
          Скачать резервную копию
        </button>
      </div>
    </>
  );
}

/**
 * Переключатели видов уведомлений.
 *
 * Настройка общая на семью, а не на телефон: она едет через профиль
 * тем же LWW-механизмом, что имя и дата рождения, и второй родитель
 * получает её при ближайшей синхронизации. Раздельная настройка на
 * каждого родителя потребовала бы привязки к chat_id — это другая
 * задача, и пока непонятно, нужна ли она.
 *
 * Хранится список ОТКЛЮЧЁННЫХ видов: тогда вид, добавленный в будущей
 * версии, заработает сам, а не окажется молча выключенным.
 */
function NotifyPrefs({ state, update }) {
  const off = state.profile?.notifyOff || [];
  const toggle = (kind) =>
    update((st) => {
      const cur = st.profile?.notifyOff || [];
      const next = cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind];
      return {
        ...st,
        profile: { ...st.profile, notifyOff: next, updatedAt: Date.now() },
        profileDirty: true,
      };
    });

  return (
    <div className="nprefs">
      {NOTIFY_KINDS.map(([kind, label, hint]) => {
        const on = !off.includes(kind);
        return (
          <div className="npref" key={kind}>
            <button
              className={"npref-b" + (on ? " on" : "")}
              onClick={() => toggle(kind)}
              role="switch"
              aria-checked={on}
            >
              <span className="npref-l">{label}</span>
              <span className="npref-s">{on ? "включено" : "выключено"}</span>
            </button>
            <p className="hint" style={{ marginTop: 6 }}>{hint}</p>
          </div>
        );
      })}
      {off.length === NOTIFY_KINDS.length && (
        <p className="hint">
          Выключено всё — бот останется привязанным, но писать не будет.
        </p>
      )}
    </div>
  );
}

/**
 * Насколько прогноз попадает. Раньше этого числа не было и быть
 * не могло: окно расширялось вслед за разбросом, то есть всегда
 * «почти попадало». Ширина теперь постоянная, промах виден — значит
 * его надо показывать, а не прятать.
 */
function QualityCard({ state, events }) {
  const { profile } = state;
  const now = Date.now();
  const scores = sourceScores(events, profile.birth, now);
  const pick = pickSource(events, profile.birth, now);

  if (!scores) {
    return (
      <div className="bt-card">
        <p className="hint" style={{ marginTop: 0 }}>
          Наберётся несколько дневных снов — покажу, какой источник прогноза
          точнее на вашем ребёнке.
        </p>
      </div>
    );
  }

  const best = Math.min(...scores.map((r) => r.miss));

  return (
    <div className="bt-card">
      <div className="srcs">
        <div className="src-h">
          <span>источник</span>
          <span className="bt-num">попаданий</span>
          <span className="bt-num">промах</span>
        </div>
        {scores.map((r) => (
          <div className={"src-r" + (r.key === pick.key ? " on" : "")} key={r.key}>
            <span>{r.label}</span>
            <span className="bt-num">{r.hits}/{r.n}</span>
            <span className="bt-num">{r.miss} мин</span>
          </div>
        ))}
      </div>
      <p className="hint">
        Сейчас работает <b>{sourceLabel(pick.key)}</b>. Приложение считает
        прогноз всеми четырьмя способами и берёт тот, что промахивался меньше
        на последних {scores[0].n} дневных снах. Окно у всех одной ширины,
        поэтому числа сравнимы напрямую.
      </p>
      <p className="hint">
        Алгоритм держит фору в {PICK_MARGIN} минуты: он единственный, кто
        учится на вашем ребёнке, и менять его на статичную таблицу из-за
        минутного перевеса на десятке наблюдений значило бы выучить шум.
        Выбор идёт только по цифрам и без памяти — одни и те же данные всегда
        дают один и тот же ответ.
      </p>
      <p className="hint">
        Чужие таблицы взяты как опубликованы, без усреднения и правок.{" "}
        {TABLES.cara.label}: {TABLES.cara.note}. {TABLES.huck.label}:{" "}
        {TABLES.huck.note}. Своя — {TABLES.app.note}.
      </p>
      <p className="hint">
        Смотреть стоит не на абсолютную долю попаданий — при окне в полчаса
        и собственном разбросе засыпаний в те же полчаса половина промахов
        неизбежна, — а на то, растёт ли отрыв выбранного источника
        от остальных{best === scores[0].miss ? "" : ""}.
      </p>
    </div>
  );
}

/** Что именно приложение считает про кормления и на каких числах. */
function FeedModelCard({ state, events, update }) {
  const { birth, sex } = state.profile;
  const manual = state.feedsPerDay ?? null;
  const t = perFeedMl(events, birth, sex || null, Date.now(), manual);
  const p = predictFeed(events, birth, sex || null, Date.now(), manual);
  const setFeeds = (v) =>
    update((st) => ({ ...st, feedsPerDay: v }));

  if (!t) {
    return (
      <div className="bt-card">
        <p className="hint" style={{ marginTop: 0 }}>
          Чтобы считать объём кормления, нужен вес: укажите пол на вкладке
          «Вес» или запишите взвешивание.
        </p>
      </div>
    );
  }

  return (
    <div className="bt-card">
      <div className="field">
        <span className="field-l">Суточный объём по возрасту</span>
        <span className="field-v bt-num">{Math.round(t.daily)} мл</span>
      </div>
      <div className="field">
        <span className="field-l">Кормлений в сутки</span>
        <div className="field-c">
          <button className="nudge" onClick={() => setFeeds(Math.max((manual ?? t.feeds) - 1, 3))}>−1</button>
          <span className="field-v bt-num">{t.feeds}</span>
          <button className="nudge" onClick={() => setFeeds(Math.min((manual ?? t.feeds) + 1, 20))}>+1</button>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {manual
          ? <>Значение задано вами. <button className="linkish" onClick={() => setFeeds(null)}>Вернуть автоматическое</button></>
          : "Медиана по ПОЛНЫМ дням: тем, где есть кормление и до 9 утра, и после 19 вечера. Считать по числу записей нельзя — тогда «мало кормлений» и «мало отмечено» неразличимы, и неполные дни занижают медиану, а порция от этого завышается. Если знаете фактическое число — поправьте кнопками, расчёт пойдёт по нему."}
      </p>
      <div className="field">
        <span className="field-l">Отсюда объём кормления</span>
        <span className="field-v bt-num">≈{Math.round(t.ml)} мл</span>
      </div>
      {p && !p.empty && p.interval != null && (
        <div className="field">
          <span className="field-l">Свой промежуток между кормлениями</span>
          <span className="field-v bt-num">{Math.round(p.interval)} мин</span>
        </div>
      )}

      <p className="hint">
        Приложение не предсказывает голод — оно считает, освободился ли
        желудок. Это разные вещи: голод зависит не только от того, пусто ли
        в желудке. Поэтому формулировка везде «можно кормить», а не «пора»,
        и кормление по требованию она не заменяет.
      </p>
      <p className="hint">
        Опорожнение желудка считается экспоненциальным, период
        полувыведения — {HALF_LIFE.breast} мин для грудного молока
        и {HALF_LIFE.formula} мин для смеси (дыхательный тест
        с 13C-октановой кислотой у доношенных). Разброс в исходном
        исследовании огромный, 16–86 и 27–98 минут, так что расчёт даёт
        порядок величины, а не минуты.
      </p>
      <p className="hint">
        Кормление грудью записывается таймером, и длительность переводится
        в объём насыщающей кривой <b>1 − exp(−t/{LETDOWN_TAU})</b>: молоко
        уходит не равномерно, основная часть передаётся в первые минуты.
        Постоянная времени подобрана так, чтобы к 10.5 минутам — средней
        длительности кормления в исследовании с контрольным взвешиванием
        доношенных — передавалось около 93 % объёма.
        {t.refMin != null && <> Ваша медианная длительность — {Math.round(t.refMin)} мин,
        при ней кривая даёт ровно типичный объём.</>}
      </p>
      <p className="hint">
        Из литературы взята только ФОРМА кривой. Величина — своя: в том же
        исследовании при средних 119.5 г на кормление разброс был 34–222 г,
        то есть шестикратный, и брать оттуда абсолютные миллилитры
        бессмысленно.
      </p>
      <p className="hint">
        Объём кормления для груди никто не измеряет — это главная слабость
        расчёта. Он выводится из суточного объёма по возрасту
        ({t.measured ? "вес взят из последнего взвешивания" : "вес подставлен как медиана ВОЗ — запишите взвешивание, и он станет вашим"}),
        делённого на ваше собственное число кормлений. Для смеси берётся
        введённый объём.
      </p>
      <p className="hint">
        Пропуск в записях сам по себе ничего не значит. Но если промежуток
        закрыт отмеченным сном, приложение знает, что ребёнок не ел, —
        и считает промежуток настоящим. Длинный промежуток без сна и без
        записей считается дыркой в дневнике, и напоминание тогда
        не приходит.
      </p>
      <p className="hint">
        Через три часа от прошлого кормления в желудке остаётся около
        десятой части — поэтому расчёт «забывает» пропущенный кусок дня
        сам собой, и одного отмеченного кормления хватает, чтобы он снова
        стал осмысленным.
      </p>
      <p className="hint">
        Обучения на собственных подсказках здесь нет намеренно: иначе
        вышла бы та же петля, что с окнами сна — приложение предложило
        время, вы покормили, приложение посчитало собственный сдвиг
        фактом о ребёнке.
      </p>
    </div>
  );
}

/**
 * Состояние кормления на вкладке «Сейчас».
 *
 * Формулировки намеренно разрешительные: «можно», а не «пора».
 * Приложение не знает, голоден ли ребёнок, — оно знает только,
 * освободился ли желудок. Кормление по требованию этим подменять
 * нельзя, и сигналы ребёнка точнее любого расчёта.
 */
function FeedNote({ events, profile, now, feedsPerDay }) {
  const p = predictFeed(events, profile.birth, profile.sex || null, now, feedsPerDay);
  if (!p) return null;

  if (p.empty) {
    return (
      <div className="bt-card feed" style={{ marginTop: 12 }}>
        <div className="feed-t">Кормления</div>
        <p className="hint" style={{ marginTop: 6 }}>
          Отметьте хотя бы одно кормление — дальше приложение будет считать,
          когда желудок освободится.
        </p>
      </div>
    );
  }

  const pct = Math.round(p.fill * 100);

  return (
    <div className="bt-card feed" style={{ marginTop: 12 }}>
      <div className="feed-head">
        <span className="feed-t">
          {p.asleep
            ? "Спит — кормление подождёт"
            : p.readyNow
            ? "Можно кормить"
            : `Можно кормить с ${hhmm(p.readyAt)}`}
        </span>
        <span className="feed-pct bt-num">{pct}%</span>
      </div>
      <div className="feed-bar">
        <div className="feed-fill" style={{ width: `${pct}%` }} />
        <div className="feed-mark" style={{ left: `${Math.round(READY_FRACTION * 100)}%` }} />
      </div>
      <div className="win-text bt-num" style={{ marginTop: 8 }}>
        Последнее кормление в {hhmm(p.lastFeed.start)} · {durShort(p.gapMin * MIN)} назад
      </div>

      {p.stale ? (
        <p className="hint">
          Прошло {durShort(p.gapMin * MIN)}, и почти всё это время ребёнок не спал.
          Похоже, кормления просто не отмечены — напоминание в этом случае
          не приходит, чтобы не будить вас из-за дырки в дневнике. Отметьте
          ближайшее кормление, и расчёт восстановится за пару часов.
        </p>
      ) : p.nightly ? (
        <p className="hint">
          Следующее напоминание пришлось бы на ночь — ночью приложение
          не пишет. Ночные кормления по требованию и без подсказок.
        </p>
      ) : p.asleep ? (
        <p className="hint">
          Пока ребёнок спит, напоминание о кормлении не придёт: будить его
          пушем — худшее, что приложение может сделать.
        </p>
      ) : (
        <p className="hint">
          {p.readyNow
            ? "Желудок освободился. Это не значит «пора» — это значит, что ребёнок сейчас скорее возьмёт, чем откажется."
            : `Сейчас в желудке примерно ${Math.round(p.level)} мл. Раньше этого времени ребёнок, скорее всего, возьмёт меньше обычного.`}
          {" "}Напоминание в Telegram — в {hhmm(p.dueAt)}.
        </p>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Антропометрия: вес, длина, окружность головы                       */
/* ================================================================== */

/**
 * Кривые ВОЗ и точки ребёнка. Один компонент на все три показателя:
 * различаются они только таблицей, единицами и шагом сетки, а это
 * всё лежит в описании показателя (IND).
 *
 * Рисуется по узлам без сглаживания: кривые ВОЗ и так гладкие, а
 * ломаная по 64 точкам на экране телефона неотличима от гладкой.
 */
function GrowthChart({ ind, sex, points, ageDays }) {
  const W = 340, H = 208, padL = 30, padR = 26, padT = 10, padB = 20;
  const lastDay = points.length ? points[points.length - 1].days : 0;
  const top = maxDays(ind);
  const xMax = Math.min(top, Math.max(120, ageDays * 1.15, lastDay + 10));

  const N = 64;
  const xs = Array.from({ length: N + 1 }, (_, i) => (xMax * i) / N);
  const zLines = [-3, -2, -1, 0, 1, 2, 3];
  const curves = zLines.map((z) => xs.map((d) => valueAt(ind, sex, d, z)));

  let yLo = Math.min(...curves[0]);
  let yHi = Math.max(...curves[6]);
  for (const p of points) {
    if (p.days < 0 || p.days > xMax) continue;
    yLo = Math.min(yLo, p.value);
    yHi = Math.max(yHi, p.value);
  }
  const pad = (yHi - yLo) * 0.04;
  yLo -= pad;
  yHi += pad;

  const x = (d) => padL + (d / xMax) * (W - padL - padR);
  const y = (v) => H - padB - ((v - yLo) / (yHi - yLo)) * (H - padT - padB);

  const pt = (vals) => vals.map((v, i) => `${x(xs[i])},${y(v)}`);
  const line = (vals) => pt(vals).join(" ");
  /** Полоса между двумя кривыми: туда по верхней, обратно по нижней. */
  const band = (lo, hi) =>
    `M ${pt(curves[hi]).join(" L ")} L ${pt(curves[lo]).reverse().join(" L ")} Z`;

  const yStep = ind.ticks(yHi - yLo);
  const yTicks = [];
  for (let v = Math.ceil(yLo / yStep) * yStep; v <= yHi; v += yStep) yTicks.push(v);

  const mStep = xMax <= 200 ? 1 : xMax <= 400 ? 2 : xMax <= 800 ? 3 : 6;
  const xTicks = [];
  for (let m = 0; m * DAYS_PER_MONTH <= xMax; m += mStep) xTicks.push(m);

  const own = points.filter((p) => p.days >= 0 && p.days <= xMax);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${ind.title} относительно стандартов ВОЗ`}>
      <path d={band(0, 6)} fill="rgba(108,123,217,.07)" />
      <path d={band(1, 5)} fill="rgba(108,123,217,.11)" />

      {yTicks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#2b2739" strokeWidth="0.5" />
          <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize="8" fill="#5d5670">{v}</text>
        </g>
      ))}
      {xTicks.map((m) => (
        <text key={m} x={x(m * DAYS_PER_MONTH)} y={H - 6} textAnchor="middle"
          fontSize="8" fill="#5d5670">{m}</text>
      ))}

      {zLines.map((z, i) => (
        <polyline key={z} points={line(curves[i])} fill="none"
          stroke={z === 0 ? "#6c7bd9" : "#3c3757"}
          strokeWidth={z === 0 ? 1 : 0.7}
          strokeDasharray={z === 0 ? "3 3" : undefined} />
      ))}
      {[[5, "+2"], [3, "0"], [1, "−2"]].map(([i, lab]) => (
        <text key={lab} x={W - padR + 3} y={y(curves[i][N]) + 3} fontSize="8" fill="#6f677f">
          {lab}
        </text>
      ))}

      {own.length > 1 && (
        <polyline points={own.map((p) => `${x(p.days)},${y(p.value)}`).join(" ")}
          fill="none" stroke={ind.color} strokeWidth="1.6"
          strokeLinejoin="round" strokeLinecap="round" />
      )}
      {own.map((p, i) => (
        <circle key={p.id} cx={x(p.days)} cy={y(p.value)} r={i === own.length - 1 ? 3.2 : 2}
          fill={i === own.length - 1 ? ind.color : "#14121c"}
          stroke={ind.color} strokeWidth="1.4" />
      ))}
    </svg>
  );
}

/**
 * Вкладка одного показателя: вес, длина тела или окружность головы.
 * Кривые — WHO Child Growth Standards (weight-for-age,
 * length-for-age, head-circumference-for-age).
 *
 * Осознанные решения, общие для всех трёх:
 *   - Показываются линии z-оценок (−3…+3), а не перцентильные кривые:
 *     считаем мы всё равно z, и рисовать одно, а считать другое —
 *     верный способ разойтись на округлениях.
 *   - Темп прироста считается только по плечу от недели и длиннее,
 *     иначе погрешность измерения больше самого прироста.
 *   - Тревожная формулировка одна и мягкая. Приложение, которое
 *     пугает родителя трёхмесячного ребёнка по показаниям кухонных
 *     весов и сантиметровой ленты, приносит больше вреда, чем пользы.
 */
function MeasureView({ ind, profile, events, now, onAdd, onSex, onPick }) {
  const [raw, setRaw] = useState("");
  const [date, setDate] = useState(() => toInput(Date.now()));
  const [err, setErr] = useState(null);

  // при переключении вкладки поле должно очищаться, иначе введённые
  // килограммы уедут в сантиметры соседнего показателя
  useEffect(() => { setRaw(""); setErr(null); }, [ind.key]);

  const sex = profile.sex || null;
  const pts = useMemo(
    () => measurements(ind, events, profile.birth),
    [ind, events, profile.birth]
  );
  const ageDays = (now - profile.birth) / DAY;
  const last = pts.length ? pts[pts.length - 1] : null;
  const lastZ = sex && last && inRange(ind, last.days)
    ? zOf(ind, sex, last.days, last.value) : null;
  const gain = useMemo(() => gainRate(ind, pts, sex), [ind, pts, sex]);
  const trend = useMemo(() => zTrend(ind, pts, sex), [ind, pts, sex]);

  const submit = () => {
    const v = parseValue(ind, raw);
    if (v == null) {
      setErr(`Не понял значение. Введите ${ind.unit} (${ind.key === "weight" ? "6,35" : "61,4"}) или ${ind.stepUnit} (${ind.key === "weight" ? "6350" : "614"}).`);
      return;
    }
    const ts = noonOf(date);
    if (!Number.isFinite(ts)) { setErr("Неверная дата."); return; }
    if (ts < profile.birth - DAY) { setErr("Эта дата раньше дня рождения."); return; }
    if (ts > Date.now() + DAY) { setErr("Дата в будущем."); return; }
    onAdd(ind, v, ts);
    setRaw("");
    setErr(null);
  };

  if (!sex) {
    return (
      <>
        <div className="sec" style={{ marginTop: 0 }}>Пол ребёнка</div>
        <div className="bt-card">
          <p className="hint" style={{ marginTop: 0 }}>
            Кривые роста у мальчиков и девочек разные — к трём месяцам медианы
            расходятся сильнее, чем весь разброс, который вы будете
            отслеживать. Без пола график строить нечестно.
          </p>
          <div className="settle-row" style={{ marginTop: 12 }}>
            {["f", "m"].map((k) => (
              <button key={k} className="settle-b" onClick={() => onSex(k)}>
                {SEX_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="hint">
            Значение уедет в профиль дневника и появится на втором телефоне
            при ближайшей синхронизации.
          </p>
        </div>
      </>
    );
  }

  const outOfRange = !inRange(ind, ageDays);

  return (
    <>
      <div className="sec" style={{ marginTop: 0 }}>Записать {ind.what}</div>
      <div className="bt-card">
        <div className="wrow">
          <input className="inp wrow-w" value={raw} inputMode="decimal"
            placeholder={`${ind.unit}, например ${ind.key === "weight" ? "6,35" : "61,4"}`}
            onChange={(e) => { setRaw(e.target.value); setErr(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
          <input className="inp wrow-d" type="date" value={date} max={toInput(Date.now())}
            onChange={(e) => { setDate(e.target.value); setErr(null); }} />
        </div>
        {err && <p className="hint err">{err}</p>}
        <button className="big sleep" onClick={submit}>Записать</button>
        <p className="hint">{MEASURE_HINT[ind.key]}</p>
      </div>

      <div className="sec">График</div>
      <div className="bt-card">
        <GrowthChart ind={ind} sex={sex} points={pts} ageDays={ageDays} />
        <div className="chart-cap">
          <span>месяцы</span>
          <span>{ind.unit} · линии ВОЗ: −3 … 0 … +3 SD</span>
        </div>
        {pts.length === 0 && (
          <p className="hint">
            Записей пока нет — показаны только кривые ВОЗ для {SEX_GEN[sex]}.
            {ind.key === "weight" && " Первой точкой удобно поставить вес при рождении: выберите дату рождения в поле выше."}
          </p>
        )}
        {outOfRange && (
          <p className="hint">
            Таблица ВОЗ по этому показателю заканчивается
            на {ind.maxMonths === 24 ? "двух годах" : "пяти годах"}
            {ind.key === "length" && " — после двух лет рост измеряют стоя, и это уже другая величина"}.
            Записи сохраняются, перцентиль дальше не считается.
          </p>
        )}
      </div>

      {last && (
        <>
          <div className="sec">Последнее {ind.what}</div>
          <div className="kpi">
            <div>
              <div className="kpi-v bt-num">{valueText(ind, last.raw)}</div>
              <div className="kpi-l">{ind.unit} · {dayLabel(last.ts)}</div>
            </div>
            <div>
              <div className="kpi-v bt-num">{lastZ == null ? "—" : pctText(lastZ)}</div>
              <div className="kpi-l">перцентиль</div>
            </div>
            <div>
              <div className="kpi-v bt-num">
                {inRange(ind, last.days)
                  ? medianOf(ind, sex, last.days).toFixed(ind.key === "weight" ? 2 : 1).replace(".", ",")
                  : "—"}
              </div>
              <div className="kpi-l">медиана ВОЗ на тот возраст</div>
            </div>
            <div>
              <div className="kpi-v bt-num">
                {gain ? `${gain.perWeek > 0 ? "+" : ""}${Math.round(gain.perWeek)}` : "—"}
              </div>
              <div className="kpi-l">{ind.stepUnit === "граммы" ? "г" : "мм"} в неделю</div>
            </div>
          </div>

          {lastZ != null && (
            <p className="hint">
              Из ста детей того же возраста и пола примерно <b>{pctText(lastZ)}</b> имеют
              значение меньше{Math.abs(lastZ) > 3 ? " (у самого края таблицы это уже грубая оценка)" : ""}.
              Сам по себе перцентиль ничего не значит: тридцатый — такая же норма,
              как семидесятый. Значение имеет только то, держится он или ползёт.
            </p>
          )}

          {gain && (
            <p className="hint">
              С {dayLabel(gain.from.ts)} по {dayLabel(gain.to.ts)} ({Math.round(gain.days)} дн)
              прирост <b>{gain.delta > 0 ? "+" : ""}{gain.delta} {ind.stepUnit === "граммы" ? "г" : "мм"}</b>,
              это <b>{Math.round(gain.perWeek)} {ind.stepUnit === "граммы" ? "г" : "мм"} в неделю</b>.
              {gain.refPerWeek != null && (
                <> Медиана ВОЗ за тот же отрезок растёт
                на {Math.round(gain.refPerWeek)} {ind.stepUnit === "граммы" ? "г" : "мм"} в неделю.</>
              )}{" "}
              Это разность медиан, а не отдельный стандарт скорости прироста —
              такой у ВОЗ есть, считается иначе и по коротким отрезкам обычно
              шире. Сравнивайте порядок величины, а не единицы.
            </p>
          )}
          {!gain && pts.length >= 2 && (
            <p className="hint">
              Темп прироста посчитается, когда между измерениями наберётся
              {" "}{GAIN_MIN_DAYS} дней. На более коротком плече погрешность измерения
              больше самого прироста, и цифра будет случайной.
            </p>
          )}

          {ind.key === "weight" && ageDays < 21 && (
            <p className="hint">
              Первые дни ребёнок теряет вес — до 7–10 % от веса при рождении,
              и возвращается к нему обычно к 10–14 дню. На графике это выглядит
              как провал вниз по кривым, и это ожидаемо. Смотреть на коридор
              имеет смысл после трёх недель.
            </p>
          )}

          {trend && trend.shift >= Z_DROP_ALARM && trend.span >= 14 && (
            <div className="bt-card sick" style={{ marginTop: 12 }}>
              <div className="sick-t">
                Коридор сместился {trend.dir === "up" ? "вверх" : "вниз"}
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                С {dayLabel(trend.from.ts)} перцентиль {trend.dir === "up" ? "поднялся" : "опустился"}
                {" "}с {pctText(trend.from.z)} до {pctText(trend.last.z)}. Смещение
                на такую величину — повод показать цифры педиатру на ближайшем
                приёме, а не повод для выводов: его может дать и другая техника
                измерения, и просто индивидуальная траектория. Приложение ничего
                не диагностирует.
              </p>
            </div>
          )}
        </>
      )}

      <div className="sec">Все записи</div>
      <div className="bt-card list">
        {pts.length === 0 ? (
          <div className="empty">Записей нет.</div>
        ) : (
          pts.slice().reverse().map((p) => {
            const z = inRange(ind, p.days) ? zOf(ind, sex, p.days, p.value) : null;
            return (
              <button className="row" key={p.id}
                onClick={() => onPick(events.find((e) => e.id === p.id))}>
                <span className="dot" style={{ background: ind.color }} />
                <span className="row-main">
                  <span className="row-t">{valueText(ind, p.raw)} {ind.unit}</span>
                  <span className="row-s bt-num">
                    {dayLabel(p.ts)} · {ageText(profile.birth, p.ts)}
                  </span>
                </span>
                <span className="row-r bt-num">{z == null ? "—" : `${pctText(z)}-й`}</span>
              </button>
            );
          })
        )}
      </div>
      <p className="hint">Нажмите на запись, чтобы поправить значение или дату.</p>

      <div className="sec">Откуда цифры</div>
      <div className="bt-card">
        <p className="hint" style={{ marginTop: 0 }}>
          Кривые — WHO Child Growth Standards (2006), таблицы L/M/S:
          по неделям до 13 недель и по месяцам
          до {ind.maxMonths === 24 ? "двух лет" : "пяти лет"}. Перцентиль
          считается из z-оценки по этим параметрам, а не берётся из готовой
          таблицы, поэтому промежуточные возрасты считаются точно, а не
          округляются до ближайшей недели.
        </p>
        <p className="hint">
          Стандарт построен на доношенных детях. Для родившегося раньше срока
          возраст положено считать скорректированным — приложение этого
          не умеет, и его перцентиль будет занижен.
        </p>
        <p className="hint">{MEASURE_NOTE[ind.key]}</p>
        <p className="hint">
          Пол: {SEX_LABEL[sex]}.{" "}
          <button className="linkish" onClick={() => onSex(sex === "m" ? "f" : "m")}>
            Изменить
          </button>
        </p>
      </div>
    </>
  );
}

/**
 * Три кнопки «как прошло укладывание». Необязательны: без метки
 * расчёт работает как раньше. Повторный тап по выбранной снимает её.
 */
function SettlePicker({ value, onPick, hint }) {
  return (
    <div className="settle">
      <div className="settle-l">Что-то пошло не так?</div>
      <div className="settle-row">
        {SETTLE_KINDS.map((k) => (
          <button
            key={k}
            className={"settle-b" + (value === k ? " on" : "")}
            onClick={() => onPick(k)}
            title={SETTLE_HINT[k]}
          >
            {SETTLE_LABEL[k]}
          </button>
        ))}
      </div>
      {value && <p className="hint" style={{ marginTop: 8 }}>{SETTLE_HINT[value]}</p>}
      {!value && hint && <p className="hint" style={{ marginTop: 8 }}>{hint}</p>}
    </div>
  );
}

function EditSheet({ ev, nights, onShift, onMl, onValue, onDays, onNight, onSettle, onClose, onDelete }) {
  const ind = IND[ev.type];
  if (ind) {
    const [small, big] = ind.steps;
    return (
      <div className="sheet-bg" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h3>{ind.title}</h3>
          <div className="field">
            <span className="field-l">Дата</span>
            <div className="field-c">
              <button className="nudge" onClick={() => onDays(-1)}>−1 д</button>
              <span className="field-v bt-num">{dayLabel(ev.start)}</span>
              <button className="nudge" onClick={() => onDays(1)}>+1 д</button>
            </div>
          </div>
          <div className="field">
            <span className="field-l">Значение, {ind.unit}</span>
            <div className="field-c">
              <button className="nudge" onClick={() => onValue(-big)}>−{big}</button>
              <button className="nudge" onClick={() => onValue(-small)}>−{small}</button>
              <span className="field-v bt-num">
                {valueText(ind, ev.meta?.[ind.metaKey] || 0)}
              </span>
              <button className="nudge" onClick={() => onValue(small)}>+{small}</button>
              <button className="nudge" onClick={() => onValue(big)}>+{big}</button>
            </div>
          </div>
          <p className="hint">Шаг кнопок — {ind.stepUnit}.</p>
          <div className="sheet-act">
            <button className="sact ghost" onClick={onClose}>Готово</button>
            <button className="sact del" onClick={onDelete}>Удалить</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{eventTitle(ev, nights)}</h3>
        <Stepper label="Начало" value={hhmm(ev.start)} onChange={(m) => onShift("start", m)} />
        {ev.type === "sleep" && (
          <>
            <div className="field">
              <span className="field-l">Это</span>
              <div className="field-c">
                {[[false, "Дневной"], [true, "Ночной"], [null, "Авто"]].map(([v, l]) => (
                  <button key={String(v)}
                    className={"nudge" + ((ev.meta?.night ?? null) === v ? " on" : "")}
                    onClick={() => onNight(v)}>{l}</button>
                ))}
              </div>
            </div>
            <p className="hint">
              {(ev.meta?.night ?? null) === null
                ? `Авто: ${autoNight(ev, nights) ? "ночной" : "дневной"}. Приложение решает по непрерывности — если между снами было только кормление, считает продолжением ночи.`
                : "Ваша пометка. Она сильнее автоматики: помеченный дневным сон приложение не склеит с ночным и посчитает отдельным окном бодрствования."}
            </p>
          </>
        )}
        {ev.type === "sleep" && ev.end && (
          <>
            <Stepper label="Конец" value={hhmm(ev.end)} onChange={(m) => onShift("end", m)} />
            <div className="field">
              <span className="field-l">Длительность</span>
              <span className="field-v bt-num">{dur(ev.end - ev.start)}</span>
            </div>
          </>
        )}
        {ev.type === "sleep" && !isNight(ev, nights) && (
          <SettlePicker value={settleOf(ev)} onPick={onSettle} />
        )}
        {ev.type === "feed" && ev.meta?.kind === "formula" && (
          <div className="field">
            <span className="field-l">Объём, мл</span>
            <div className="field-c">
              <button className="nudge" onClick={() => onMl(-10)}>−10</button>
              <span className="field-v bt-num">{ev.meta.ml || 0}</span>
              <button className="nudge" onClick={() => onMl(10)}>+10</button>
            </div>
          </div>
        )}
        <div className="sheet-act">
          <button className="sact ghost" onClick={onClose}>Готово</button>
          <button className="sact del" onClick={onDelete}>Удалить</button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ label, value, onChange }) {
  return (
    <div className="field">
      <span className="field-l">{label}</span>
      <div className="field-c">
        <button className="nudge" onClick={() => onChange(-15)}>−15</button>
        <button className="nudge" onClick={() => onChange(-5)}>−5</button>
        <span className="field-v bt-num">{value}</span>
        <button className="nudge" onClick={() => onChange(5)}>+5</button>
        <button className="nudge" onClick={() => onChange(15)}>+15</button>
      </div>
    </div>
  );
}

/* ================================================================== */

function JoinPrompt({ busy, err, count, onJoin, onSkip }) {
  return (
    <div className="bt">
      <div className="bt-shell">
        <div className="state" style={{ paddingTop: 40 }}>
          <div className="state-label">Общий дневник</div>
          <div className="state-time" style={{ fontSize: 30, marginTop: 10 }}>
            Подключиться?
          </div>
        </div>
        <div className="bt-card">
          <p className="hint" style={{ marginTop: 0 }}>
            Этот телефон подключится к дневнику по присланной ссылке.
            {count > 0 && (
              <> Ваши {count} записей не пропадут — они объединятся с теми,
              что уже есть в общем дневнике.</>
            )}
          </p>
          {err && <p className="hint err">{err}</p>}
          <button className="big sleep" disabled={busy}
            style={busy ? { opacity: 0.4 } : undefined} onClick={onJoin}>
            {busy ? "Подключаю…" : "Подключиться"}
          </button>
          <button className="sact ghost full" onClick={onSkip}>
            Не сейчас
          </button>
        </div>
      </div>
    </div>
  );
}

function Onboarding({ onReady }) {
  const joinToken = readJoinToken();
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [sex, setSex] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!joinToken) return;
    (async () => {
      setBusy(true);
      try {
        const res = await fetch(`${API}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${joinToken}` },
          body: JSON.stringify({ since: 0, events: [] }),
        });
        if (!res.ok) throw new Error("Ссылка не подошла. Попросите прислать новую.");
        const data = await res.json();
        history.replaceState(null, "", import.meta.env.BASE_URL);
        onReady({
          profile: data.profile,
          events: data.events.map((e) => ({ ...e, dirty: false })),
          auth: { token: joinToken },
          rev: data.rev,
          bias: 0,
          profileDirty: false,
        });
      } catch (e) {
        setErr(e.message);
        setBusy(false);
      }
    })();
  }, [joinToken]);

  if (joinToken && !err) return <Splash text="Подключаюсь к дневнику…" />;

  const ok = name.trim() && date && sex && !busy;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const birth = new Date(date + "T09:00:00").getTime();
      const { token, householdId } = await createHousehold(name.trim(), birth, sex);
      onReady({
        profile: { name: name.trim(), birth, sex, updatedAt: Date.now() },
        events: [],
        auth: { token, householdId },
        rev: 0,
        bias: 0,
        profileDirty: false,
      });
    } catch (e) {
      setErr("Сервер недоступен. Проверьте соединение и попробуйте ещё раз.");
      setBusy(false);
    }
  };

  return (
    <div className="bt">
      <div className="bt-shell">
        <div className="state" style={{ paddingTop: 40 }}>
          <div className="state-label">Дневник сна</div>
          <div className="state-time" style={{ fontSize: 34, marginTop: 10 }}>Начнём</div>
        </div>
        <div className="bt-card">
          <label className="lab" htmlFor="n">Как зовут ребёнка</label>
          <input id="n" className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя" />
          <label className="lab" htmlFor="d">Дата рождения</label>
          <input id="d" className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label className="lab">Пол</label>
          <div className="settle-row">
            {["f", "m"].map((k) => (
              <button key={k} className={"settle-b" + (sex === k ? " on" : "")}
                onClick={() => setSex(k)}>
                {SEX_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="hint">
            Дата рождения нужна для расчёта окон бодрствования, пол — для кривых
            веса: у мальчиков и девочек они заметно разные. Больше эти данные
            никуда не идут.
          </p>
          {err && <p className="hint err">{err}</p>}
          <button className="big sleep" disabled={!ok} style={!ok ? { opacity: 0.4 } : undefined} onClick={submit}>
            {busy ? "Создаю…" : "Продолжить"}
          </button>
        </div>
        <p className="hint">
          Записи хранятся на вашем сервере и на телефоне. Второй родитель
          подключается по ссылке из раздела «Неделя».
        </p>
      </div>
    </div>
  );
}
