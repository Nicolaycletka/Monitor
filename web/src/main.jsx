import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

/*
 * Service worker нужен только вебу: он кеширует файлы, которые иначе
 * пришлось бы тянуть по сети. В автономном APK файлы и так лежат
 * внутри приложения — регистрировать его незачем, а его кеш оболочки
 * начал бы конкурировать с ними за то, что показать.
 */
if ("serviceWorker" in navigator && !import.meta.env.VITE_API_URL) {
  const base = import.meta.env.BASE_URL; // "/" или "/monitor/"
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(base + "sw.js", { scope: base }).catch(() => {});
  });
}
