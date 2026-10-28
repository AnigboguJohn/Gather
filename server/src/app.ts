/**
 * The Express application (no listening here; index.ts does that).
 *  - /api/*  JSON API, built from the route modules in modules/
 *  - everything else: the built React app; unknown paths return index.html so deep links like
 *    /j/abc-defg-hij (join links shared on WhatsApp) open the right screen.
 * Also: CORS, basic security headers, raw-body capture for webhook signatures, one error handler.
 */
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { log } from "./log.js";
import { aiHealth } from "./lib/ai.js";
import { HttpError } from "./lib/http.js";
import { adminRouter } from "./modules/admin.routes.js";
import { authRouter } from "./modules/auth.routes.js";
import { billingRouter } from "./modules/billing.routes.js";
import { extrasRouter } from "./modules/extras.routes.js";
import { joinRouter } from "./modules/join.routes.js";
import { meetingsRouter } from "./modules/meetings.routes.js";
import { reviewsRouter } from "./modules/reviews.js";

/** Build the app. Exported separately from index.ts so tests could mount it without a port. */
export function createApp() {
  const app = express();
  // Behind one reverse proxy (load balancer / tunnel): use X-Forwarded-For for req.ip (rate limits).
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(cors({ origin: true }));
  // Keep the raw body: payment and LiveKit webhooks are verified against the exact bytes.
  app.use(express.json({ limit: "1mb", type: ["application/json", "application/webhook+json"], verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Health check for Docker/monitoring: database reachable + AI service status.
  app.get("/api/health", async (_req, res) => {
    const db = await pool.query("SELECT 1").then(() => true).catch(() => false);
    res.status(db ? 200 : 503).json({ ok: db, db, ai: await aiHealth() });
  });

  // All route modules share one /api router.
  const api = express.Router();
  api.use(authRouter, meetingsRouter, joinRouter, billingRouter, extrasRouter, reviewsRouter, adminRouter);
  app.use("/api", api);
  // Unknown API paths get JSON 404s (not the web app's index.html).
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // The web app (built by `npm run build` in web/). Deep links like /j/abc-defg-hij fall back to index.html.
  const dist = path.resolve(config.webDist);
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    // index.html is never cached, so a reload always picks up the newest build (the hashed JS/CSS it points to can be).
    app.get(/^(?!\/(api|socket\.io)\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html"), { headers: { "Cache-Control": "no-cache" } }));
  }

  // One place that turns errors into JSON: HttpError keeps its status/message; anything else is logged
  // and the user gets a generic 500 (no stack traces or SQL leak to browsers).
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err?.type === "entity.too.large" || err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File too large." });
    if (err instanceof SyntaxError) return res.status(400).json({ error: "Invalid JSON." });
    log.error({ err: err?.message, stack: err?.stack, path: req.path }, "request failed");
    res.status(500).json({ error: "Something went wrong on our side. Please try again." });
  });
  return app;
}
