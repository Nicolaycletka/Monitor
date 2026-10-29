/* Проверка, что обёртка постоянного уведомления безвредна без плагина.
 *
 * Нативную часть (Java) проверить в этом окружении нечем — нет ни
 * Android SDK, ни даже компилятора Java. Поэтому здесь проверяется
 * единственное, что поддаётся проверке: что веб и сборка без плагина
 * не ломаются. Это же и самое важное: неработающее уведомление —
 * неудобство, а упавшее приложение — потеря дневника.
 */
const dom = { window: {} };
globalThis.window = dom.window;
const N = await import("../web/src/sleep-notification.js");

let bad = 0;
const check = (l, c, e = "") => { if (!c) bad++;
  console.log((c ? "  ок  " : "ПРОВАЛ") + "  " + l + (e ? "  — " + e : "")); };

check("в вебе плагин недоступен", (await N.available()) === false);
check("показ молча ничего не делает",
  (await N.showSleepNotification({ asleep: false, body: "тест" })) === false);

check("запрос пометки возвращает пусто", (await N.consumePendingAction()) === null);

let threw = false;
try { await N.hideSleepNotification(); } catch { threw = true; }
check("снятие не бросает исключение", !threw);

// натив есть, плагина нет — сборка без нативной части
dom.window.Capacitor = { isNativePlatform: () => true };
check("натив без плагина: показ не падает",
  (await N.showSleepNotification({ asleep: true, body: "x" })) === false);
check("натив без плагина: пометка не падает",
  (await N.consumePendingAction()) === null);

console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : "\nобёртка безвредна без плагина");
process.exit(bad ? 1 : 0);
