/**
 * Database migrations. Applies every migrations/*.sql file in name order.
 * Each file uses IF NOT EXISTS, so it is safe to run on every start (index.ts does).
 * Run by hand: npm run migrate
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

/** Run all SQL migration files against DATABASE_URL, in alphabetical order. */
export async function migrate() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
    console.log(`migrated ${f}`);
  }
}

// Allow `tsx src/migrate.ts` as a command, while still being importable from index.ts.
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
