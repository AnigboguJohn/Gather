/**
 * Admin panel API (/api/admin/*), for the people who run Gather (not workspace owners).
 * Platform admins have their own accounts (platform_admins), seeded from ADMIN_EMAIL / ADMIN_PASSWORD at start-up,
 * and sign in at /admin. Their token ("admin", 12 hours) works only on these routes.
 *
 * Overview numbers · people (search, suspend, delete) · workspaces (plan changes) · meetings (live now, recent calls,
 * end a live call) · payments.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";
import { hashPasscode, passcodeMatches } from "../lib/codes.js";
import { ah, HttpError, parse, rateLimit } from "../lib/http.js";
import { effectivePlan, PLANS, type Plan } from "../lib/plans.js";
import { endMeeting, getRoom, liveRoomInfo } from "./rooms.js";

export const adminRouter = Router();

/** Who is signed in to the admin panel. */
interface PlatformAdmin { id: string; email: string; name: string }
declare global { namespace Express { interface Request { admin?: PlatformAdmin } } }

const signAdmin = (a: PlatformAdmin) => jwt.sign({ typ: "admin", sub: a.id }, config.jwtSecret, { expiresIn: "12h" });

/** Middleware: a valid admin token, for an admin that still exists. */
async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const p = jwt.verify((req.get("authorization") ?? "").replace(/^Bearer\s+/i, ""), config.jwtSecret) as any;
    if (p.typ !== "admin") throw new Error("not an admin token");
    const a = await one<PlatformAdmin>("SELECT id, email, name FROM platform_admins WHERE id = $1", [p.sub]);
    if (!a) throw new Error("admin removed");
    req.admin = a;
    next();
  } catch {
    res.status(401).json({ error: "Please sign in to the admin panel." });
  }
}

/** Create or update the admin account named in ADMIN_EMAIL / ADMIN_PASSWORD (runs at every start). */
export async function seedPlatformAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  await q(`INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, 'Gather admin', $2)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [email, hashPasscode(password)]);
  log.info({ email }, "admin panel account ready");
}

/* ---------- Sign in ---------- */
adminRouter.post("/admin/login", ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
  if (!rateLimit(`admin-login:${req.ip}`, 8, 15 * 60_000)) throw new HttpError(429, "Too many tries. Wait 15 minutes.");
  const a = await one("SELECT id, email, name, password_hash FROM platform_admins WHERE email = $1", [b.email]);
  if (!a || !passcodeMatches(b.password, a.password_hash)) throw new HttpError(400, "Wrong admin email or password.");
  await q("UPDATE platform_admins SET last_login_at = now() WHERE id = $1", [a.id]);
  log.info({ admin: a.email }, "admin signed in");
  res.json({ token: signAdmin(a), admin: { email: a.email, name: a.name } });
}));

adminRouter.use("/admin", (req, res, next) => (req.path === "/login" ? next() : requirePlatformAdmin(req, res, next)));
adminRouter.get("/admin/me", (req, res) => res.json(req.admin));

/* ---------- Overview ---------- */
adminRouter.get("/admin/overview", ah(async (_req, res) => {
  const c = await one(`SELECT
      (SELECT count(*) FROM users WHERE password_hash IS NOT NULL)::int AS users,
      (SELECT count(*) FROM users WHERE password_hash IS NULL)::int AS pending_invites,
      (SELECT count(*) FROM users WHERE suspended_at IS NOT NULL)::int AS suspended,
      (SELECT count(*) FROM organizations)::int AS workspaces,
      (SELECT count(*) FROM organizations WHERE plan <> 'free' AND paid_until > now())::int AS paying,
      (SELECT count(*) FROM meetings)::int AS meetings,
      (SELECT count(*) FROM meetings WHERE status = 'live')::int AS live,
      (SELECT count(*) FROM sessions WHERE started_at > now() - interval '1 day')::int AS calls_today,
      (SELECT count(*) FROM participants)::int AS attendees,
      (SELECT coalesce(sum(amount_minor), 0) FROM payments WHERE status = 'success' AND provider <> 'demo')::bigint AS revenue_minor,
      (SELECT coalesce(sum(amount_minor), 0) FROM payments WHERE status = 'success' AND provider = 'demo')::bigint AS demo_minor`);
  const signups = await q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT count(*) FROM users u WHERE u.created_at::date = d::date)::int AS n
     FROM generate_series(now()::date - 13, now()::date, interval '1 day') d ORDER BY d`);
  const recentUsers = await q(`SELECT u.id, u.name, u.email, u.created_at, o.name AS org FROM users u JOIN organizations o ON o.id = u.org_id
     ORDER BY u.created_at DESC LIMIT 6`);
  const recentPayments = await q(`SELECT p.reference, p.plan, p.amount_minor, p.status, p.provider, p.created_at, o.name AS org FROM payments p
     JOIN organizations o ON o.id = p.org_id ORDER BY p.created_at DESC LIMIT 6`);
  res.json({ ...c, revenue_minor: Number(c.revenue_minor), demo_minor: Number(c.demo_minor), signups, recentUsers, recentPayments });
}));

/* ---------- People ---------- */
adminRouter.get("/admin/users", ah(async (req, res) => {
  const s = String(req.query.q ?? "").trim();
  res.json(await q(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at, u.suspended_at, u.password_hash IS NULL AS pending,
            o.id AS org_id, o.name AS org, o.plan, o.paid_until,
            (SELECT count(*) FROM meetings m WHERE m.host_id = u.id)::int AS meetings
     FROM users u JOIN organizations o ON o.id = u.org_id
     WHERE $1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%' OR o.name ILIKE '%' || $1 || '%'
     ORDER BY u.created_at DESC LIMIT 300`, [s]));
}));
/** Suspend or restore someone. Suspended people are signed out everywhere and can't sign in. */
adminRouter.patch("/admin/users/:id", ah(async (req, res) => {
  const b = parse(z.object({ suspended: z.boolean() }), req.body);
  const r = await q("UPDATE users SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING email", [req.params.id, b.suspended]);
  if (!r.length) throw new HttpError(404, "Person not found.");
  log.info({ admin: req.admin!.email, user: r[0].email, suspended: b.suspended }, "admin changed suspension");
  res.json({ ok: true });
}));
/**
 * Delete someone. If they're the only person in their workspace, the workspace goes too (its meetings,
 * history and payments). A workspace owner with other members can't be deleted: they'd leave the team without an owner.
 */
adminRouter.delete("/admin/users/:id", ah(async (req, res) => {
  const u = await one("SELECT id, email, role, org_id, (SELECT count(*) FROM users x WHERE x.org_id = users.org_id)::int AS members FROM users WHERE id = $1", [req.params.id]);
  if (!u) throw new HttpError(404, "Person not found.");
  if (u.members <= 1) await q("DELETE FROM organizations WHERE id = $1", [u.org_id]);
  else if (u.role === "owner") throw new HttpError(400, "This person owns a workspace with other members. Delete the workspace instead, or remove its members first.");
  else {
    // Keep the team's history: their meetings move to the workspace owner.
    await q("UPDATE meetings SET host_id = (SELECT id FROM users WHERE org_id = $2 AND role = 'owner' LIMIT 1) WHERE host_id = $1", [u.id, u.org_id]);
    await q("DELETE FROM users WHERE id = $1", [u.id]);
  }
  log.info({ admin: req.admin!.email, user: u.email }, "admin deleted a person");
  res.json({ ok: true });
}));

/* ---------- Workspaces ---------- */
adminRouter.get("/admin/orgs", ah(async (req, res) => {
  const s = String(req.query.q ?? "").trim();
  const rows = await q(
    `SELECT o.id, o.name, o.kind, o.country, o.plan, o.paid_until, o.created_at,
            (SELECT count(*) FROM users u WHERE u.org_id = o.id)::int AS members,
            (SELECT u.email FROM users u WHERE u.org_id = o.id AND u.role = 'owner' LIMIT 1) AS owner,
            (SELECT count(*) FROM meetings m WHERE m.org_id = o.id)::int AS meetings
     FROM organizations o WHERE $1 = '' OR o.name ILIKE '%' || $1 || '%'
     ORDER BY o.created_at DESC LIMIT 300`, [s]);
  res.json(rows.map((o) => ({ ...o, effective: effectivePlan(o) })));
}));
/** Give a workspace a plan for some months (free of charge), or put it back on Free. */
adminRouter.patch("/admin/orgs/:id", ah(async (req, res) => {
  const b = parse(z.object({ plan: z.enum(["free", "pro", "business"]), months: z.number().int().min(1).max(36).default(1) }), req.body);
  const r = b.plan === "free"
    ? await q("UPDATE organizations SET plan = 'free', paid_until = NULL WHERE id = $1 RETURNING name", [req.params.id])
    : await q(`UPDATE organizations SET plan = $2, paid_until = greatest(coalesce(paid_until, now()), now()) + ($3 || ' days')::interval
               WHERE id = $1 RETURNING name`, [req.params.id, b.plan, String(30 * b.months)]);
  if (!r.length) throw new HttpError(404, "Workspace not found.");
  log.info({ admin: req.admin!.email, org: r[0].name, plan: b.plan, months: b.months }, "admin changed a plan");
  res.json({ ok: true });
}));
/** Delete a whole workspace: its people, meetings, history and payments. */
adminRouter.delete("/admin/orgs/:id", ah(async (req, res) => {
  const r = await q("DELETE FROM organizations WHERE id = $1 RETURNING name", [req.params.id]);
  if (!r.length) throw new HttpError(404, "Workspace not found.");
  log.info({ admin: req.admin!.email, org: r[0].name }, "admin deleted a workspace");
  res.json({ ok: true });
}));

/* ---------- Meetings ---------- */
adminRouter.get("/admin/meetings", ah(async (_req, res) => {
  const live = (await q(`SELECT m.slug, m.title, o.name AS org, u.name AS host FROM meetings m
      JOIN organizations o ON o.id = m.org_id JOIN users u ON u.id = m.host_id WHERE m.status = 'live' ORDER BY m.start_at DESC`))
    .map((m) => ({ ...m, info: liveRoomInfo(m.slug) })).filter((m) => m.info);
  const recent = await q(`SELECT s.id, s.started_at, s.ended_at, s.end_reason, s.summary_status, m.id AS meeting_id, m.title, o.name AS org,
        (SELECT count(*) FROM participants p WHERE p.session_id = s.id)::int AS attendees
     FROM sessions s JOIN meetings m ON m.id = s.meeting_id JOIN organizations o ON o.id = m.org_id
     ORDER BY s.started_at DESC LIMIT 100`);
  res.json({ live, recent });
}));
/** End a live call for everyone (for abuse or a stuck room). */
adminRouter.post("/admin/rooms/:slug/end", ah(async (req, res) => {
  const room = getRoom(req.params.slug);
  if (!room || room.ended) throw new HttpError(404, "That call isn't live any more.");
  await endMeeting(room, "host_ended");
  log.info({ admin: req.admin!.email, slug: req.params.slug }, "admin ended a call");
  res.json({ ok: true });
}));

/* ---------- Payments ---------- */
adminRouter.get("/admin/payments", ah(async (_req, res) => {
  res.json(await q(`SELECT p.reference, p.provider, p.plan, p.months, p.amount_minor, p.currency, p.status, p.created_at, p.paid_at,
        o.name AS org, u.email AS payer FROM payments p JOIN organizations o ON o.id = p.org_id LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.created_at DESC LIMIT 300`));
}));

/** Plan names for the panel's menus. */
adminRouter.get("/admin/plans", (_req, res) => res.json((Object.keys(PLANS) as Plan[]).map((id) => ({ id, name: PLANS[id].name, price: PLANS[id].priceNgnMonthly }))));
