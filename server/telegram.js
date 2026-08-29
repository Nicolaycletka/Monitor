/**
 * Тонкая обёртка над Telegram Bot API. Без сторонних зависимостей —
 * в Node 22 есть глобальный fetch.
 *
 * Доставка через long polling (getUpdates), а не webhook: не нужен
 * отдельный публичный HTTPS-эндпоинт и его настройка в nginx —
 * приложение и так работает за обратным прокси на /monitor/, заводить
 * туда ещё и приём вебхуков ради одного personal-бота избыточно.
 *
 * Если у бота ранее был включён webhook (например, из-за Mini App,
 * привязанного к нему), getUpdates будет молча возвращать пусто —
 * поэтому при старте всегда шлём deleteWebhook (это no-op, если
 * вебхука и не было).
 */

const TOKEN = process.env.TG_BOT_TOKEN || "";
const BASE = `https://api.telegram.org/bot${TOKEN}`;

export const telegramEnabled = () => Boolean(TOKEN);

export async function tgCall(method, params) {
  if (!TOKEN) return null;
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    console.warn(`telegram ${method} failed`, res.status, data?.description);
    return null;
  }
  return data.result;
}

export async function sendMessage(chatId, text) {
  return tgCall("sendMessage", { chat_id: chatId, text });
}

export async function getMe() {
  return tgCall("getMe", {});
}

export async function deleteWebhook() {
  return tgCall("deleteWebhook", {});
}

/**
 * Один цикл long polling. offset передаётся вызывающей стороной и
 * должен сохраняться между вызовами (последний update_id + 1).
 * timeout=25 — держим соединение открытым, а не дёргаем API впустую.
 */
export async function getUpdates(offset) {
  if (!TOKEN) return { updates: [], offset };
  try {
    const res = await fetch(`${BASE}/getUpdates?timeout=25&offset=${offset}`);
    const data = await res.json();
    if (!data?.ok) return { updates: [], offset };
    let next = offset;
    for (const u of data.result) next = Math.max(next, u.update_id + 1);
    return { updates: data.result, offset: next };
  } catch (e) {
    console.warn("telegram getUpdates error", e.message);
    return { updates: [], offset };
  }
}
