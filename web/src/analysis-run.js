/*
 * Сами расчёты — общие для фонового потока и для запасного пути в
 * основном потоке. Держать их в одном месте важно: иначе на телефоне
 * без поддержки Worker считалась бы одна модель, а на остальных другая.
 */
import { predictNext, selfCheck, sourceScores, pickSource } from "./sleep.js";

export const RUN = {
  // окно следующего сна — то же, что раньше считалось прямо в App и в синке
  predict: ({ events, birth, now, bias }) => predictNext(events, birth, now, bias || 0),

  // диагностика для вкладки «Неделя»: самопроверка и сравнение источников
  quality: ({ events, birth, now }) => ({
    check: selfCheck(events, birth, now),
    scores: sourceScores(events, birth, now),
    pick: pickSource(events, birth, now),
  }),
};
