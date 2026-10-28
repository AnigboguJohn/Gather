/**
 * Tiny .env loader so `npx tsx src/index.ts` works without extra packages.
 * Reads the repo-root .env first, then server/.env. Real environment variables always win
 * (Docker Compose sets them), and GATHER_SKIP_DOTENV=1 turns the loader off (used by tests).
 * Imported for its side effect by config.ts, before any setting is read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root first (the documented place), then a server-local override.
for (const file of [path.resolve(here, "../../.env"), path.resolve(here, "../.env")]) {
  if (!fs.existsSync(file) || process.env.GATHER_SKIP_DOTENV) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    // KEY=value lines only; comments and blank lines simply do not match.
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    // Strip one pair of surrounding quotes: KEY="value" → value
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
