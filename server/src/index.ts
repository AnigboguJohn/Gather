/**
 * Entry point. Starts one Node process that serves:
 *  - the JSON API and the built web app (Express, see app.ts),
 *  - the real-time "signal" service for live calls (Socket.IO, see modules/rooms.ts),
 *  - the reminder scheduler (see modules/scheduler.ts).
 * Run: npx tsx src/index.ts (or `npm start`).
 */
import http from "node:http";
import { config } from "./config.js";
import { log } from "./log.js";
import { migrate } from "./migrate.js";
import { createApp } from "./app.js";
import { attachSignal } from "./modules/rooms.js";
import { startScheduler } from "./modules/scheduler.js";
import { seedPlatformAdmin } from "./modules/admin.routes.js";

/** Migrate the database, then start HTTP + Socket.IO + scheduler on one port. */
async function main() {
  // Migrations are idempotent, so running them on every boot is safe (AUTO_MIGRATE=false skips).
  if (process.env.AUTO_MIGRATE !== "false") await migrate();
  // The admin panel account from ADMIN_EMAIL / ADMIN_PASSWORD.
  await seedPlatformAdmin();
  const server = http.createServer(createApp());
  // Socket.IO shares the HTTP server, so browsers use the same origin and port.
  attachSignal(server);
  startScheduler();
  server.listen(config.port, () => log.info(`Gather is running on ${config.appUrl} (port ${config.port})`));
}

// Crash loudly on startup errors (bad DATABASE_URL etc.) so Docker restarts or the developer sees it.
main().catch((e) => { log.error(e); process.exit(1); });
