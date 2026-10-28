/**
 * PostgreSQL access. One shared connection pool plus three tiny helpers:
 * q() for many rows, one() for a single row, tx() for transactions.
 * All SQL in the app uses $1, $2... parameters (never string concatenation of user input).
 */
import pg from "pg";
import { config } from "./config.js";

/** Shared pool (max 10 connections). DB_SSL=true for managed databases such as RDS. */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

/** Run a query and return all rows. */
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}
/** Run a query and return the first row, or null when there is none. */
export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}
/** Runs fn inside a transaction; rolls back on any error. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
