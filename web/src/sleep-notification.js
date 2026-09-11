/**
 * Постоянное уведомление о сне с кнопкой «Заснул» / «Проснулся».
 *
 * Работает только в автономном APK: нужен нативный плагин
 * SleepNotification (android/app/src/main/java/.../SleepNotificationPlugin.java).
 * В вебе и в сборке без плагина всё здесь — пустышка, как и в
 * notify-local.js, и по той же причине: обёртка обязана быть
 * безвредной там, где её некому обслужить.
 *
 * КАК РАБОТАЕТ КНОПКА. Она запускает приложение с пометкой в интенте,
 * а запись создаёт уже приложение — теми же функциями, что и кнопка на
 * экране. Поэтому в плагин уходит только текст и состояние: ни токена,
 * ни адреса API ему не нужно, и хранить их негде и незачем.
 *
 * Такой путь работает без сети: запись ложится в местную базу и уедет
 * на сервер при первой возможности. Фоновая отправка прямо на сервер
 * без связи теряла бы отметку.
 *
 * ЗРИТЕЛЬ. Участник с ролью viewer ничего не пишет, поэтому кнопка ему
 * не показывается вовсе — уведомление для него просто не поднимается.
 * Сервер такую запись всё равно отбросил бы, но предлагать кнопку,
 * которая молча ничего не делает, хуже, чем не предлагать её.
 */

let holder = null;

async function load() {
  if (typeof window === "undefined" || !window.Capacitor?.isNativePlatform?.()) return null;
  if (holder) return holder;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const api = registerPlugin("SleepNotification");
    if (!api) return null;
    /*
     * Тот же приём, что в notify-local.js: объект плагина Capacitor —
     * это Proxy, отвечающий на любое обращение, включая `.then`.
     * Возврат его напрямую из async-функции заставляет рантайм принять
     * его за thenable и дёрнуть `.then()`, а плагин на неизвестный
     * метод бросает исключение. Держим завёрнутым.
     */
    holder = { api };
    return holder;
  } catch {
    return null;
  }
}

/** Есть ли нативный плагин в этой сборке. */
export async function available() {
  const p = await load();
  if (!p) return false;
  try {
    const res = await p.api.available();
    return Boolean(res?.value);
  } catch {
    return false; // плагин не собран, хотя обёртка есть
  }
}

/**
 * Показать или обновить уведомление.
 *
 * Зовётся при каждом изменении состояния сна и окна: уведомление
 * обязано отражать то же, что экран, иначе кнопка соврёт. Обновление
 * идёт тем же идентификатором, поэтому копий не плодится, а канал
 * заведён без звука — постоянное уведомление не должно звенеть при
 * каждой перерисовке.
 */
export async function showSleepNotification({ asleep, body }) {
  const p = await load();
  if (!p) return false;
  try {
    await p.api.show({ body: body || "", asleep: Boolean(asleep) });
    return true;
  } catch {
    return false; // разрешение не выдано или канал выключен
  }
}

/**
 * Забрать пометку, оставленную нажатием кнопки в уведомлении.
 *
 * Возвращает `{ action, at }`, где action — "fall_asleep" | "wake_up"
 * | "" (нечего применять), а at — момент НАЖАТИЯ, не момент запуска
 * приложения. Разница в секунду-другую, но врать на неё при каждой
 * отметке незачем.
 *
 * Плагин гасит пометку в тот же момент, когда отдаёт: повторный вызов
 * при перезагрузке WebView или возврате из фона не должен применить
 * одну отметку дважды.
 */
export async function consumePendingAction() {
  const p = await load();
  if (!p) return null;
  try {
    const res = await p.api.consumeAction();
    if (!res?.action) return null;
    return { action: res.action, at: Number(res.at) || Date.now() };
  } catch {
    return null;
  }
}

export async function hideSleepNotification() {
  const p = await load();
  if (!p) return;
  try {
    await p.api.hide();
  } catch {
    /* уже снято */
  }
}
