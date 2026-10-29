import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// BASE_PATH задаётся при сборке: "/" для корня, "/monitor/" для подкаталога
const base = process.env.BASE_PATH || "/";

/*
 * Версия приложения — из web/package.json.
 *
 * Раньше «свежесть» определялась по имени собранного файла (vite кладёт
 * в него хеш содержимого). Для веба это работает, но для APK не могло
 * работать НИКОГДА: автономная сборка идёт с другими BASE_PATH и
 * VITE_API_URL, содержимое отличается, значит отличается и хеш. Плашка
 * «вышла новая версия» горела на самой свежей сборке постоянно.
 *
 * Версия же одинакова у обеих сборок, если они сделаны из одного
 * коммита, — это и есть общий признак. Она попадает и в код (через
 * define), и в index.html мета-тегом, откуда её читает сервер: в образ
 * Docker кладётся только web/dist, поэтому взять её сервер может лишь
 * из собранной разметки.
 */
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version;

const stampVersion = () => ({
  name: "stamp-version",
  transformIndexHtml: (html) =>
    html.replace("</head>", `  <meta name="app-version" content="${version}">\n  </head>`),
});

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), stampVersion()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8090" },
  },
});
