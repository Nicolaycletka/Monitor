/* Проверка, что модуль уведомлений безвреден в вебе. */
// jsdom тут не нужен: модуль трогает только window.Capacitor
const dom = { window: {} };
globalThis.window = dom.window;
const N = await import("../web/src/notify-local.js");

let bad = 0;
const check=(l,c,e="")=>{ if(!c) bad++; console.log((c?"  ок  ":"ПРОВАЛ")+"  "+l+(e?"  — "+e:"")); };

// в вебе window.Capacitor нет вовсе
check("в вебе плагин недоступен", (await N.available()) === false);
check("разрешение не запрашивается", (await N.requestPermission()) === false);
check("проверка разрешения не падает", (await N.permissionGranted()) === false);
check("планирование молча ничего не делает",
  (await N.scheduleWindow(Date.now() + 3600000, "тест")) === false);
let threw = false;
try { await N.cancelWindow(); } catch { threw = true; }
check("отмена не бросает исключение", !threw);

// эмулируем натив, но без установленного плагина — тоже не должно падать
dom.window.Capacitor = { isNativePlatform: () => true };
check("натив без плагина: не падает и честно возвращает false",
  (await N.scheduleWindow(Date.now() + 3600000, "тест")) === false);

// прошедшее время не планируется
check("прошедшее время отвергается", (await N.scheduleWindow(Date.now() - 1000, "тест")) === false);

console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : "\nв вебе модуль безвреден");
process.exit(bad ? 1 : 0);
