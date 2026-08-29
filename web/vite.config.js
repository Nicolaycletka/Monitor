import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH задаётся при сборке: "/" для корня, "/monitor/" для подкаталога
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8090" },
  },
});
