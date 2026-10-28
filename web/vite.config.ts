/**
 * Vite build/dev configuration for the Gather web app (React + TypeScript).
 * `npm run dev` serves on :5173; `npm run build` writes static files to dist/, which the Node server serves.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the web app runs on :5173 and forwards API + socket calls to the server on :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://localhost:8080",
      "/socket.io": { target: "http://localhost:8080", ws: true },
    },
  },
  worker: { format: "es" },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
