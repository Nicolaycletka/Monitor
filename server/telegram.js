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

/** Жёсткий лимит Telegram на одно сообщение. */
const TG_LIMIT = 4096;

/*
 * Режем длинный текст по абзацам, а не по символам: рвать фразу
 * посередине хуже, чем прислать два сообщения. Если один абзац сам
 * длиннее лимита — режем его по символам, деваться некуда.
 */
export function splitMessage(text, limit = TG_LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let buf = "";
  for (const para of text.split("\n\n")) {
    const chunk = buf ? `${buf}\n\n${para}` : para;
    if (chunk.length <= limit) { buf = chunk; continue; }
    if (buf) { parts.push(buf); buf = ""; }
    if (para.length <= limit) { buf = para; continue; }
    for (let i = 0; i < para.length; i += limit) parts.push(para.slice(i, i + limit));
  }
  if (buf) parts.push(buf);
  return parts;
}

/*
 * Тексты вех развития длиннее прежних напоминаний о сне в разы, и
 * превышение лимита Telegram возвращает ошибку — а уведомление к тому
 * моменту уже помечено отправленным, то есть пропало бы молча. Ровно
 * тот способ потерять пуш, который в этом проекте уже случался, так
 * что длину проверяем здесь, а не надеемся на дисциплину авторов
 * текстов.
 */
export async function sendMessage(chatId, text) {
  const parts = splitMessage(String(text ?? ""));
  let last = null;
  for (const part of parts) {
    last = await tgCall("sendMessage", { chat_id: chatId, text: part });
    if (!last) return null; // не сыпем продолжением, если первая часть не ушла
  }
  return last;
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
