/**
 * Локальные уведомления о начале окна сна — на телефоне, без Telegram.
 *
 * Зачем отдельно от телеграм-пушей. Те считает и шлёт СЕРВЕР, и они
 * приходят всем участникам сразу. Эти считает приложение на телефоне и
 * показывает только на нём. Одно другому не мешает и не заменяет:
 * телеграм работает, даже когда телефон не открывали неделю, а
 * локальное уведомление приходит без интернета вовсе.
 *
 * ВЕБ. Плагина в браузере нет. Любой вызов отсюда в вебе должен быть
 * безвредным — не бросать, не логировать в консоль, просто ничего не
 * делать. Поэтому весь модуль построен вокруг одной проверки
 * `available()`, а импорт плагина ленивый: статический импорт
 * `@capacitor/local-notifications` в веб-сборке потянул бы за собой
 * код, который там никогда не выполнится.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Кнопки «Заснул» прямо в уведомлении. Она возможна,
 * но её нажатие поднимает приложение — Capacitor доставляет действие
 * через запуск активности. Полностью фоновая обработка требует
 * собственного плагина на Java с BroadcastReceiver. Решили начать с
 * простого варианта.
 */

/** Один и тот же идентификатор: новое уведомление заменяет прежнее. */
const WINDOW_ID = 1;

/** Ближе этого к текущему моменту планировать бессмысленно. */
const MIN_LEAD_MS = 60000;

/*
 * Плагин держится ЗАВЁРНУТЫМ в объект { api }, а не сам по себе.
 *
 * Объект плагина Capacitor — это Proxy, который отвечает на любое
 * обращение, включая `.then`. Возврат его напрямую из async-функции
 * заставляет рантайм принять его за thenable и дёрнуть `.then()`, а
 * Capacitor на неизвестный метод бросает
 * «LocalNotifications.then() is not implemented on web». То есть
 * попытка аккуратно проверить наличие плагина сама же и роняла бы
 * приложение. Поймано тестом notify-local, не глазами.
 */
let holder = null;
let asked = false;

async function load() {
  // Capacitor подставляет свой мост только в нативной сборке
  if (typeof window === "undefined" || !window.Capacitor?.isNativePlatform?.()) return null;
  if (holder) return holder;
  try {
    const mod = await import("@capacitor/local-notifications");
    if (!mod?.LocalNotifications) return null;
    holder = { api: mod.LocalNotifications };
    return holder;
  } catch {
    return null; // плагин не собран в эту сборку — не наша беда
  }
}

/** Есть ли вообще на чём показывать уведомления. */
export async function available() {
  return Boolean(await load());
}

/**
 * Спросить разрешение. Отдельно от планирования и вызывается по явному
 * действию пользователя: системный запрос, вылетающий на первом
 * открытии сам по себе, чаще всего получает отказ — а отказ на Android
 * повторно уже не спросишь.
 */
export async function requestPermission() {
  const p = await load();
  if (!p) return false;
  asked = true;
  try {
    const res = await p.api.requestPermissions();
    return res.display === "granted";
  } catch {
    return false;
  }
}

export async function permissionGranted() {
  const p = await load();
  if (!p) return false;
  try {
    return (await p.api.checkPermissions()).display === "granted";
  } catch {
    return false;
  }
}

/**
 * Запланировать уведомление на начало окна сна.
 *
 * `at` — момент начала окна. Прошедшее или слишком близкое время не
 * планируем: Android показал бы такое уведомление немедленно, и родитель
 * получил бы «пора укладываться» ровно в ту секунду, когда открыл
 * приложение, — бессмысленно и раздражает.
 *
 * Прежнее уведомление снимается всегда, даже если новое не ставится:
 * прогноз мог сдвинуться, и старое время уже неверно.
 */
export async function scheduleWindow(at, text) {
  const p = await load();
  if (!p) return false;
  if (!(await permissionGranted())) return false;

  try {
    await p.api.cancel({ notifications: [{ id: WINDOW_ID }] });
  } catch { /* нечего было отменять */ }

  if (!Number.isFinite(at) || at - Date.now() < MIN_LEAD_MS) return false;

  try {
    await p.api.schedule({
      notifications: [{
        id: WINDOW_ID,
        title: "Окно сна",
        body: text,
        schedule: { at: new Date(at), allowWhileIdle: true },
      }],
    });
    return true;
  } catch {
    return false;
  }
}

/** Снять запланированное — например, когда ребёнок уже заснул. */
export async function cancelWindow() {
  const p = await load();
  if (!p) return;
  try {
    await p.api.cancel({ notifications: [{ id: WINDOW_ID }] });
  } catch { /* уже снято */ }
}

export const wasAsked = () => asked;
