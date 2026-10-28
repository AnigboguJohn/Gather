/**
 * Small Express helpers used by every route file:
 *  - HttpError: throw it to send a specific status + message (app.ts turns it into JSON).
 *  - ah(): lets async handlers throw instead of calling next(err) by hand.
 *  - parse(): validates input with zod and turns the first problem into a readable 400.
 *  - rateLimit(): simple in-memory throttling for codes, joins, sockets and captions.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";

/** An error with an HTTP status. `extra` fields (e.g. { field: "passcode" }) are added to the JSON reply. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

/** Validate `data` against a zod schema; on failure respond 400 "field: message" for the first issue. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      const i = e.issues[0];
      throw new HttpError(400, `${i.path.join(".") || "input"}: ${i.message}`);
    }
    throw e;
  }
}

/**
 * Fixed-window rate limiter in memory (good enough for one server; use Redis when scaling out).
 * Returns true while `key` has been used at most `max` times in the current `windowMs` window.
 */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n += 1;
  return b.n <= max;
}
// key → hits in the current window and when the window resets.
const buckets = new Map<string, { n: number; reset: number }>();
// Forget expired windows every minute so the map does not grow forever. unref() lets the process exit.
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();
