import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  MIN, DAY, startOfDay, hhmm, dur, durShort, ageText, ageMonths, dayLabel,
  sleepNorm, isNightSleep, predictWindow, daySegments, dayStats, measureBias,
  medianNapIn,
} from "./sleep.js";
import {
  loadState, saveState, createHousehold, syncOnce, uid, liveEvents,
  inviteLink, readJoinToken, API, relink,
} from "./store.js";

const FEED_LABEL = {
  left: "ГВ, левая", right: "ГВ, правая", formula: "Смесь",
  solid: "Прикорм", water: "Вода",
};
const DIAPER_LABEL = { wet: "Мокрый", dirty: "Стул", mixed: "Мокрый и стул" };

const eventTitle = (e) =>
  e.type === "sleep"
    ? isNightSleep(e) ? "Ночной сон" : "Сон"
    : e.type === "feed"
    ? FEED_LABEL[e.meta?.kind] + (e.meta?.ml ? ` · ${e.meta.ml} мл` : "")
    : DIAPER_LABEL[e.meta?.kind] || "Подгузник";

const eventColor = (e) =>
  e.type === "sleep" ? "#6c7bd9" : e.type === "feed" ? "#e8a33d" : "#5f9e86";

/* ================================================================== */

export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("now");
  const [tick, setTick] = useState(Date.now());
  const [toast, setToast] = useState(null);
  const [quick, setQuick] = useState(null);
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
    flash(eventTitle(ev), () => putEvent({ ...ev, deleted: true }));
    setQuick(null);
    setTimeout(runSync, 800);
  };

  const shift = (ev, field, mins) => putEvent({ ...ev, [field]: ev[field] + mins * MIN });

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
  const win = active ? null : predictWindow(events, profile.birth, tick, bias || 0);
  const todayStart = startOfDay(tick);
  const pending = (state.events || []).filter((e) => e.dirty).length;

  return (
    <div className="bt">
      <div className="bt-shell">
        <header className="bt-head">
          <span className="bt-name">{profile.name}</span>
          <span className="bt-age">{ageText(profile.birth, tick)}</span>
        </header>

        {tab === "now" && (
          <>
            <div className="rib-wrap">
              <Ribbon events={events} dayStart={todayStart} showNow />
              <Axis />
            </div>

            <section className="bt-card">
              <div className="state">
                <div className="state-label">
                  {active ? (isNightSleep(active) ? "Ночной сон" : "Спит") : "Бодрствует"}
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
              {active && !isNightSleep(active) && <NapNote start={active.start} now={tick} />}

              <button className={"big " + (active ? "wake" : "sleep")} onClick={toggleSleep}>
                {active ? "Проснулся" : "Заснул"}
              </button>
            </section>

            <div className="quick">
              <button className="qbtn" onClick={() => logEvent("feed", { kind: "left" })}>ГВ · левая</button>
              <button className="qbtn" onClick={() => logEvent("feed", { kind: "right" })}>ГВ · правая</button>
              <button className="qbtn" onClick={() => setQuick(quick === "formula" ? null : "formula")}>Смесь</button>
              <button className="qbtn" onClick={() => setQuick(quick === "diaper" ? null : "diaper")}>Подгузник</button>
            </div>

            {quick === "formula" && (
              <div className="chips">
                {[30, 60, 90, 120, 150, 180, 210].map((ml) => (
                  <button key={ml} className="chip" onClick={() => logEvent("feed", { kind: "formula", ml })}>{ml} мл</button>
                ))}
                <button className="chip" onClick={() => logEvent("feed", { kind: "solid" })}>Прикорм</button>
                <button className="chip" onClick={() => logEvent("feed", { kind: "water" })}>Вода</button>
              </div>
            )}
            {quick === "diaper" && (
              <div className="chips">
                {Object.entries(DIAPER_LABEL).map(([k, v]) => (
                  <button key={k} className="chip" onClick={() => logEvent("diaper", { kind: k })}>{v}</button>
                ))}
              </div>
            )}

            <Kpis stats={dayStats(events, todayStart)} title="Сегодня" />
          </>
        )}

        {tab === "day" && (
          <DayView events={events} offset={offset} setOffset={setOffset} onPick={setEditing} />
        )}

        {tab === "week" && (
          <WeekView state={state} events={events} update={update} />
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
          onShift={(field, m) => {
            const cur = events.find((e) => e.id === editing.id);
            if (cur) shift(cur, field, m);
          }}
          onMl={(d) => {
            const cur = events.find((e) => e.id === editing.id);
            if (cur) putEvent({ ...cur, meta: { ...cur.meta, ml: Math.max(0, (cur.meta?.ml || 0) + d) } });
          }}
          onClose={() => setEditing(null)}
          onDelete={() => removeEvent(events.find((e) => e.id === editing.id) || editing)}
        />
      )}

      <nav className="tabs">
        <div className="tabs-in">
          {[["now", "Сейчас"], ["day", "День"], ["week", "Неделя"]].map(([k, l]) => (
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

function NapNote({ start, now }) {
  const len = (now - start) / MIN;
  return (
    <div className="win-text" style={{ marginTop: 16 }}>
      {len < 25
        ? "Меньше 25 минут — сон, скорее всего, поверхностный"
        : len < 45
        ? "Короткий сон · следующее окно стоит сократить"
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

function DayView({ events, offset, setOffset, onPick }) {
  const dayStart = startOfDay(Date.now()) - offset * DAY;
  // отбор по пересечению с сутками, а не по времени начала: иначе
  // ночной сон, начатый вчера, даёт минуты в статистике, но не виден
  // в списке — и суммы не сходятся
  const list = events
    .filter((e) => {
      const end = e.type === "sleep" ? e.end ?? Date.now() : e.start;
      return end >= dayStart && e.start < dayStart + DAY;
    })
    .sort((a, b) => b.start - a.start);
  const s = dayStats(events, dayStart);

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
                <span className="row-t">{eventTitle(e)}</span>
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

function WeekView({ state, events, update }) {
  const [copied, setCopied] = useState(false);
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY);
  const stats = days.map((d) => dayStats(events, d));
  // первый день ведения дневника всегда обрезан — он занижает средние
  const firstWith = stats.findIndex((s) => s.total > 0);
  const counted = stats
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.total > 0 && !(i === firstWith && stats.filter((x) => x.total > 0).length > 1))
    .map(({ s }) => s);
  const avg = (f) => (counted.length ? counted.reduce((a, s) => a + f(s), 0) / counted.length : 0);

  const napNow = medianNapIn(events, today - 6 * DAY, today + DAY);
  const napBefore = medianNapIn(events, today - 13 * DAY, today - 6 * DAY);
  const norm = sleepNorm(ageMonths(state.profile.birth, Date.now()));
  const bias = measureBias(events, state.profile.birth);
  const link = inviteLink(state.auth.token);

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

      {napNow != null && (
        <p className="hint">
          Медиана дневного сна за неделю — <b>{Math.round(napNow)} мин</b>
          {napBefore != null && (
            <>, неделей раньше <b>{Math.round(napBefore)} мин</b></>
          )}.
        </p>
      )}

      <div className="sec">Поправка на вашего ребёнка</div>
      <div className="bt-card">
        {bias ? (
          <p className="hint" style={{ marginTop: 0 }}>
            По {bias.n} дневным снам ребёнок засыпает в среднем на{" "}
            <b>{bias.mean > 0 ? `${bias.mean} мин позже` : `${-bias.mean} мин раньше`}</b>{" "}
            середины предсказанного окна.
          </p>
        ) : (
          <p className="hint" style={{ marginTop: 0 }}>
            Нужно хотя бы пять дневных снов, чтобы посчитать поправку.
          </p>
        )}
        <div className="field">
          <span className="field-l">Сдвиг окна</span>
          <div className="field-c">
            <button className="nudge" onClick={() => update((s) => ({ ...s, bias: (s.bias || 0) - 5 }))}>−5</button>
            <span className="field-v bt-num">{state.bias > 0 ? `+${state.bias}` : state.bias || 0}</span>
            <button className="nudge" onClick={() => update((s) => ({ ...s, bias: (s.bias || 0) + 5 }))}>+5</button>
          </div>
        </div>
        {bias && Math.abs(bias.mean - (state.bias || 0)) >= 5 && (
          <button className="sact ghost full"
            onClick={() => update((s) => ({ ...s, bias: bias.mean }))}>
            Применить измеренную поправку
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

function EditSheet({ ev, onShift, onMl, onClose, onDelete }) {
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{eventTitle(ev)}</h3>
        <Stepper label="Начало" value={hhmm(ev.start)} onChange={(m) => onShift("start", m)} />
        {ev.type === "sleep" && ev.end && (
          <>
            <Stepper label="Конец" value={hhmm(ev.end)} onChange={(m) => onShift("end", m)} />
            <div className="field">
              <span className="field-l">Длительность</span>
              <span className="field-v bt-num">{dur(ev.end - ev.start)}</span>
            </div>
          </>
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

  const ok = name.trim() && date && !busy;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const birth = new Date(date + "T09:00:00").getTime();
      const { token, householdId } = await createHousehold(name.trim(), birth);
      onReady({
        profile: { name: name.trim(), birth, updatedAt: Date.now() },
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
          <p className="hint">Дата нужна только для расчёта окон бодрствования — они меняются с возрастом.</p>
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
