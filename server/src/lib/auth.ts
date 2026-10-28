/**
 * Two kinds of signed tokens:
 *  - session tokens for signed-in hosts and team members (Authorization: Bearer ...)
 *  - room tickets for anyone inside a call (host or guest); they authorise the real-time socket,
 *    caption uploads and recordings, and say who you are in that meeting.
 */
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { one } from "../db.js";

/** A signed-in host or team member, loaded fresh from the database on each request. */
export interface AuthUser { id: string; orgId: string; email: string; name: string; role: "owner" | "admin" | "member" }
/** Who you are inside one live meeting (host, co-host or guest). Carried as a signed JWT. */
export interface RoomTicket {
  meetingId: string; slug: string; sessionId: string; identity: string; name: string;
  role: "host" | "cohost" | "guest"; lang: string; userId?: string;
}

// Make req.user / req.ticket typed on every Express request.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: AuthUser; ticket?: RoomTicket } }
}

/**
 * Session token for hosts. "Remember me" keeps it 30 days; otherwise 12 hours (and the browser forgets it when
 * the tab closes). Contains only the user id; the rest is reloaded per request.
 */
export const signSession = (u: AuthUser, remember = true) =>
  jwt.sign({ typ: "session", sub: u.id }, config.jwtSecret, { expiresIn: remember ? "30d" : "12h" });

/** Room ticket for anyone admitted to a call; valid a little longer than the longest meeting (24 h). */
export const signTicket = (t: RoomTicket) =>
  jwt.sign({ typ: "ticket", ...t }, config.jwtSecret, { expiresIn: "26h" });

/** Check a room ticket's signature and type, and return its fields (throws if invalid or expired). */
export function verifyTicket(token: string): RoomTicket {
  const p = jwt.verify(token, config.jwtSecret) as any;
  if (p.typ !== "ticket") throw new Error("not a room ticket");
  const { typ, iat, exp, ...t } = p;
  return t as RoomTicket;
}

/** Proof that someone just verified this email with a code; lets them finish sign-up (30 minutes). */
export const signSignup = (email: string) =>
  jwt.sign({ typ: "signup", email }, config.jwtSecret, { expiresIn: "30m" });
/** Proof that someone just verified this email for a password reset; lets them choose a new one (15 minutes). */
export const signReset = (email: string) =>
  jwt.sign({ typ: "reset", email }, config.jwtSecret, { expiresIn: "15m" });
/** Check a reset token and return its email (throws if invalid or expired). */
export function verifyReset(token: string): string {
  const p = jwt.verify(token, config.jwtSecret) as any;
  if (p.typ !== "reset") throw new Error("not a reset token");
  return p.email;
}
/** Check a sign-up token and return its email (throws if invalid or expired). */
export function verifySignup(token: string): string {
  const p = jwt.verify(token, config.jwtSecret) as any;
  if (p.typ !== "signup") throw new Error("not a sign-up token");
  return p.email;
}

/** Short-lived token a waiting-room guest uses to listen for "admitted". */
export const signWait = (w: { slug: string; waitId: string }) =>
  jwt.sign({ typ: "wait", ...w }, config.jwtSecret, { expiresIn: "2h" });
/** Check a waiting-room token (throws if invalid). */
export function verifyWait(token: string): { slug: string; waitId: string } {
  const p = jwt.verify(token, config.jwtSecret) as any;
  if (p.typ !== "wait") throw new Error("not a wait token");
  return { slug: p.slug, waitId: p.waitId };
}

// Read "Authorization: Bearer <token>"; empty string when missing.
const bearer = (req: Request) => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
};

/** Loads the signed-in user fresh from the database (so removed users lose access at once). */
/**
 * Middleware: only signed-in users. Sets req.user.
 * The user row is re-read so a removed team member loses access immediately, even with a valid token.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const p = jwt.verify(bearer(req), config.jwtSecret) as any;
    if (p.typ !== "session") throw new Error("wrong token");
    const u = await one<AuthUser & { suspended_at: Date | null }>(
      "SELECT id, org_id AS \"orgId\", email, name, role, suspended_at FROM users WHERE id = $1", [p.sub]);
    if (!u) return res.status(401).json({ error: "Please sign in again." });
    if (u.suspended_at) return res.status(401).json({ error: "This account has been suspended." });
    const { suspended_at, ...user } = u;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Please sign in." });
  }
}

/** Middleware (after requireAuth): owners and admins only; plain members get 403. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role === "member") return res.status(403).json({ error: "Only workspace admins can do this." });
  next();
}

/**
 * Middleware: only people inside a meeting. Accepts the ticket as a Bearer header or ?ticket= (for uploads).
 * Sets req.ticket.
 */
export function requireTicket(req: Request, res: Response, next: NextFunction) {
  try {
    req.ticket = verifyTicket(bearer(req) || String(req.query.ticket ?? ""));
    next();
  } catch {
    res.status(401).json({ error: "Not in this meeting." });
  }
}
