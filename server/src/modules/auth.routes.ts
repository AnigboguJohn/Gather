/**
 * Host accounts. Sign-up proves the email with a 6-digit code, then collects details and a password;
 * after that people sign in with email + password (individual or company workspace).
 * Guests never use these routes.
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { one, q, tx } from "../db.js";
import { log } from "../log.js";
import { requireAdmin, requireAuth, signReset, signSession, signSignup, verifyReset, verifySignup } from "../lib/auth.js";
import { CODE_MAX_ATTEMPTS, CODE_TTL_MINUTES, codeMatches, generateCode, hashCode, hashPasscode, passcodeMatches } from "../lib/codes.js";
import { ah, HttpError, parse, rateLimit } from "../lib/http.js";
import { isLanguage, LANGUAGES } from "../lib/languages.js";
import { emailLayout, escapeHtml, sendEmail, smsEnabled, whatsappEnabled } from "../lib/notify.js";
import { assertPhoneFree, assertStrongPassword, normalizePhone } from "../lib/security.js";
import { effectivePlan, meetingLimitMinutes, PLANS } from "../lib/plans.js";

// Routes: /auth/signup/*, /auth/login, /auth/code/*, /auth/reset/*, /auth/start, /auth/verify, /me, /org, /team (under /api).
export const authRouter = Router();
// Emails are trimmed and lower-cased so "Ada@X.com" and "ada@x.com" are the same account.
const email = z.string().trim().toLowerCase().email().max(200);

/** Create a code, store its hash and email it. Shared with guest verification. */
/**
 * Create a 6-digit code, store only its HMAC, and email it.
 * `purpose` separates code types: "login" for hosts, "guest:<slug>" for guest email checks.
 * Rate limit: 5 codes per email+purpose per 15 minutes.
 */
export async function issueCode(to: string, purpose: string, label: string) {
  if (!rateLimit(`code:${to}:${purpose}`, 5, 15 * 60_000)) throw new HttpError(429, "Too many codes requested. Try again in 15 minutes.");
  const code = generateCode();
  await q("INSERT INTO login_codes (email, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + $4::interval)",
    [to, purpose, hashCode(code, config.codeSecret), `${CODE_TTL_MINUTES} minutes`]);
  /**   // Local development convenience: the code also appears in the server log. */
  if (config.devShowCodes) log.info({ to, purpose, code }, "one-time code (DEV_SHOW_CODES=true)");
  // A full, friendly message (formatted + plain text): bare one-line emails with a number are what spam filters flag.
  const status = await sendEmail({
    to, kind: "code", subject: `Your Gather ${label} code: ${code}`,
    text: [
      "Hello,", "",
      `Your Gather ${label} code is:`, "", `    ${code}`, "",
      `Type it on the Gather page to continue. It expires in ${CODE_TTL_MINUTES} minutes and works once.`, "",
      "Didn't ask for this? You can ignore this email: someone may have typed your address by mistake. Never share this code with anyone.", "",
      "The Gather team", config.appUrl,
    ].join("\n"),
    html: emailLayout({
      preheader: `Your ${label} code expires in ${CODE_TTL_MINUTES} minutes.`,
      body: `<p style="margin:0 0 12px">Hello,</p>
<p style="margin:0 0 16px">Your Gather ${escapeHtml(label)} code is:</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;color:#064e3b;background:#ecfdf5;border-radius:12px;padding:14px 0;text-align:center">${code}</p>
<p style="margin:0 0 12px">Type it on the Gather page to continue. It expires in <b>${CODE_TTL_MINUTES} minutes</b> and works once.</p>
<p style="margin:0;color:#78716c;font-size:13px">Didn't ask for this? You can ignore this email: someone may have typed your address by mistake. Never share this code with anyone.</p>`,
    }),
  });
  // Don't send people to a code screen for an email that never left the server.
  if (status !== "sent") throw new HttpError(502, "We couldn't send the email. Check the address and try again in a minute.");
}

/** Check the newest unused code; locks after 5 wrong tries. */
/**
 * Verify the newest unused code for this email+purpose. Throws a readable 400/429 when it is wrong,
 * expired or locked (after 5 wrong tries). A correct code is marked used, so it works only once.
 */
export async function checkCode(to: string, purpose: string, code: string) {
  const row = await one<{ id: string; code_hash: string; attempts: number; expired: boolean }>(
    `SELECT id, code_hash, attempts, expires_at < now() AS expired FROM login_codes
     WHERE email = $1 AND purpose = $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, [to, purpose]);
  if (!row || row.expired) throw new HttpError(400, "That code has expired. Ask for a new one.");
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw new HttpError(429, "Too many wrong tries. Ask for a new code.");
  if (!codeMatches(code, row.code_hash, config.codeSecret)) {
    await q("UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    throw new HttpError(400, "Wrong code. Check the email and try again.");
  }
  await q("UPDATE login_codes SET used_at = now() WHERE id = $1", [row.id]);
}

/* ---------- Sign-up: email → code → details + password, then sign in with email + password ---------- */

// Seconds a person must wait before asking for another sign-up code.
const RESEND_SECONDS = 60;
// Length only here; the full strength rules and the breach check run in assertStrongPassword.
const password = z.string().min(1, "Choose a password.").max(200);
/** Suspended accounts can't sign in. */
const SUSPENDED = "This account has been suspended. Contact Gather support if you think this is a mistake.";

/** Sign-up step 1: email a code. Emails that already have a password are sent to sign in instead. */
authRouter.post("/auth/signup/start", ah(async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  const user = await one<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE email = $1", [b.email]);
  if (user?.password_hash) throw new HttpError(409, "This email already has an account. Sign in instead.");
  if (!rateLimit(`signup-resend:${b.email}`, 1, RESEND_SECONDS * 1000)) throw new HttpError(429, `Wait ${RESEND_SECONDS} seconds before asking for another code.`);
  await issueCode(b.email, "signup", "sign-up");
  res.json({ sent: true, expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: RESEND_SECONDS });
}));

/** Sign-up step 2: check the code and hand back a short-lived token for the details step. */
authRouter.post("/auth/signup/verify", ah(async (req, res) => {
  const b = parse(z.object({ email, code: z.string().trim().min(6).max(12) }), req.body);
  await checkCode(b.email, "signup", b.code);
  // Someone an admin added to a team (row exists, no password yet) joins that workspace instead of creating one.
  const invited = await one("SELECT o.name FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.email = $1 AND u.password_hash IS NULL", [b.email]);
  res.json({ signupToken: signSignup(b.email), invitedTo: invited?.name ?? null });
}));

/**
 * Sign-up step 3: name, phone, password (+ workspace) → account saved. No session: the web app sends
 * people to sign in next. Invited team members (row exists, no password) keep their workspace and just
 * get their details and password set.
 */
authRouter.post("/auth/signup/complete", ah(async (req, res) => {
  const b = parse(z.object({
    signupToken: z.string(),
    name: z.string().trim().min(1, "Enter your name.").max(80),
    phone: z.string().trim().min(7, "Enter your phone number.").max(30),
    password,
    accountType: z.enum(["individual", "company"]).default("individual"),
    orgName: z.string().trim().max(120).optional(),
    language: z.string().optional(),
    country: z.string().trim().max(2).optional(),
  }), req.body);
  let to: string;
  try { to = verifySignup(b.signupToken); } catch { throw new HttpError(401, "Your sign-up session expired. Start again with your email."); }
  const existing = await one<{ id: string; password_hash: string | null }>("SELECT id, password_hash FROM users WHERE email = $1", [to]);
  if (existing?.password_hash) throw new HttpError(409, "This email already has an account. Sign in instead.");
  const phone = normalizePhone(b.phone);
  await assertPhoneFree(phone, existing?.id);
  await assertStrongPassword(b.password, { email: to, name: b.name });
  const lang = isLanguage(b.language) ? b.language : "en";
  if (existing) {
    await q("UPDATE users SET name = $2, phone = $3, preferred_language = $4, password_hash = $5 WHERE id = $1",
      [existing.id, b.name, phone, lang, hashPasscode(b.password)]);
  } else {
    // Organization + owner are created together, or not at all.
    await tx(async (c) => {
      const org = (await c.query(
        "INSERT INTO organizations (name, kind, country) VALUES ($1,$2,$3) RETURNING id",
        [b.accountType === "company" ? (b.orgName || `${b.name}'s company`) : b.name, b.accountType, (b.country || "NG").toUpperCase()])).rows[0];
      await c.query(
        `INSERT INTO users (org_id, name, email, phone, preferred_language, role, password_hash) VALUES ($1,$2,$3,$4,$5,'owner',$6)`,
        [org.id, b.name, to, phone, lang, hashPasscode(b.password)]);
    });
  }
  res.status(201).json({ ok: true, email: to });
}));

/** Sign in with email + password → session token ("remember" = 30 days, otherwise 12 hours). */
authRouter.post("/auth/login", ah(async (req, res) => {
  const b = parse(z.object({ email, password: z.string().min(1).max(200), remember: z.boolean().default(true) }), req.body);
  if (!rateLimit(`login:${b.email}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many tries. Wait 15 minutes and try again.");
  const user = await one("SELECT id, org_id, email, name, role, password_hash, suspended_at FROM users WHERE email = $1", [b.email]);
  if (user?.suspended_at) throw new HttpError(403, SUSPENDED);
  if (user && !user.password_hash) throw new HttpError(400, "This account has no password yet. Choose \"Create account\" with this email to set one.");
  if (!user) throw new HttpError(404, "There's no Gather account with this email. Check it, or create an account.");
  if (!passcodeMatches(b.password, user.password_hash)) throw new HttpError(400, "Wrong password. Try again, or use \"Forgot password?\".");
  res.json({ token: signSession({ id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role }, b.remember) });
}));

/* ---------- Sign in with a one-time code instead of the password ---------- */

/** Email a sign-in code to an existing account. */
authRouter.post("/auth/code/start", ah(async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  const user = await one<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE email = $1", [b.email]);
  if (!user) throw new HttpError(404, "There's no Gather account with this email. Create one instead.");
  if (!user.password_hash) throw new HttpError(400, "This account isn't set up yet. Choose \"Create account\" with this email.");
  if (!rateLimit(`code-resend:${b.email}`, 1, RESEND_SECONDS * 1000)) throw new HttpError(429, `Wait ${RESEND_SECONDS} seconds before asking for another code.`);
  await issueCode(b.email, "login", "sign-in");
  res.json({ sent: true, expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: RESEND_SECONDS });
}));
/** Check the sign-in code → session token. */
authRouter.post("/auth/code/verify", ah(async (req, res) => {
  const b = parse(z.object({ email, code: z.string().trim().min(6).max(12), remember: z.boolean().default(true) }), req.body);
  const user = await one("SELECT id, org_id, email, name, role, password_hash, suspended_at FROM users WHERE email = $1", [b.email]);
  if (!user?.password_hash) throw new HttpError(404, "There's no Gather account with this email.");
  if (user.suspended_at) throw new HttpError(403, SUSPENDED);
  await checkCode(b.email, "login", b.code);
  res.json({ token: signSession({ id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role }, b.remember) });
}));

/* ---------- Forgot password: email → code → new password ---------- */

/**
 * Email a reset code. The reply is the same whether or not the email has an account,
 * so the form can't be used to find out who uses Gather.
 */
authRouter.post("/auth/reset/start", ah(async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  if (!rateLimit(`reset-resend:${b.email}`, 1, RESEND_SECONDS * 1000)) throw new HttpError(429, `Wait ${RESEND_SECONDS} seconds before asking for another code.`);
  const user = await one("SELECT 1 FROM users WHERE email = $1", [b.email]);
  if (user) await issueCode(b.email, "reset", "password reset");
  res.json({ sent: true, expiresInSeconds: CODE_TTL_MINUTES * 60, resendInSeconds: RESEND_SECONDS });
}));
/** Check the reset code → a short-lived token for choosing the new password. */
authRouter.post("/auth/reset/verify", ah(async (req, res) => {
  const b = parse(z.object({ email, code: z.string().trim().min(6).max(12) }), req.body);
  await checkCode(b.email, "reset", b.code);
  res.json({ resetToken: signReset(b.email) });
}));
/** Save the new password. Then the person signs in with it. */
authRouter.post("/auth/reset/complete", ah(async (req, res) => {
  const b = parse(z.object({ resetToken: z.string(), password }), req.body);
  let to: string;
  try { to = verifyReset(b.resetToken); } catch { throw new HttpError(401, "Your reset link expired. Start again with your email."); }
  const cur = await one<{ name: string; password_hash: string | null }>("SELECT name, password_hash FROM users WHERE email = $1", [to]);
  if (cur?.password_hash && passcodeMatches(b.password, cur.password_hash)) throw new HttpError(400, "That's your current password. Choose a new one.", { field: "password" });
  await assertStrongPassword(b.password, { email: to, name: cur?.name });
  const r = await q("UPDATE users SET password_hash = $2 WHERE email = $1 RETURNING id", [to, hashPasscode(b.password)]);
  if (!r.length) throw new HttpError(404, "There's no Gather account with this email.");
  res.json({ ok: true, email: to });
}));

/* ---------- Passwordless code sign-in (kept for scripts and the end-to-end tests) ---------- */

/** Step 1 of sign-in/sign-up: email → code sent. `exists` tells the web app whether to ask for a name. */
authRouter.post("/auth/start", ah(async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  const exists = Boolean(await one("SELECT 1 FROM users WHERE email = $1", [b.email]));
  await issueCode(b.email, "login", "sign-in");
  res.json({ sent: true, exists });
}));

/**
 * Step 2: email + code → session token. If the email is new, this also creates the account:
 * a new organization (individual or company) with this user as its owner.
 */
authRouter.post("/auth/verify", ah(async (req, res) => {
  const b = parse(z.object({
    email, code: z.string().trim().min(6).max(12),
    // Only used when the email is new (sign-up):
    name: z.string().trim().min(1).max(80).optional(),
    accountType: z.enum(["individual", "company"]).optional(),
    orgName: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(30).optional(),
    language: z.string().optional(),
    country: z.string().trim().max(2).optional(),
  }), req.body);
  let user = await one("SELECT id, org_id, email, name, role FROM users WHERE email = $1", [b.email]);
  /**   // New accounts need a name; check before spending the code. */
  if (!user && !b.name) throw new HttpError(400, "name: Enter your name to create your account.");
  const legacyPhone = !user && b.phone ? normalizePhone(b.phone) : null;
  if (legacyPhone) await assertPhoneFree(legacyPhone);
  await checkCode(b.email, "login", b.code);
  if (!user) {
    /**     // Organization + owner are created together, or not at all. */
    user = await tx(async (c) => {
      const kind = b.accountType ?? "individual";
      const org = (await c.query(
        "INSERT INTO organizations (name, kind, country) VALUES ($1,$2,$3) RETURNING id",
        [kind === "company" ? (b.orgName || `${b.name}'s company`) : b.name, kind, (b.country || "NG").toUpperCase()])).rows[0];
      return (await c.query(
        `INSERT INTO users (org_id, name, email, phone, preferred_language, role) VALUES ($1,$2,$3,$4,$5,'owner')
         RETURNING id, org_id, email, name, role`,
        [org.id, b.name, b.email, legacyPhone, isLanguage(b.language) ? b.language : "en"])).rows[0];
    });
  }
  res.json({ token: signSession({ id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role }) });
}));

/** Everything the web app needs about the signed-in user: profile, workspace, effective plan, calendar and integrations. */
authRouter.get("/me", requireAuth, ah(async (req, res) => {
  const u = await one(
    `SELECT u.id, u.name, u.email, u.phone, u.preferred_language, u.role, u.ics_token, u.onboarded_at,
            u.google_refresh_token IS NOT NULL AS google_connected, u.microsoft_refresh_token IS NOT NULL AS microsoft_connected,
            o.id AS org_id, o.name AS org_name, o.kind AS org_kind, o.country, o.data_region, o.plan, o.paid_until
     FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [req.user!.id]);
  const plan = effectivePlan(u);
  res.json({
    user: { id: u.id, name: u.name, email: u.email, phone: u.phone, language: u.preferred_language, role: u.role, onboarded: Boolean(u.onboarded_at) },
    org: { id: u.org_id, name: u.org_name, kind: u.org_kind, country: u.country, dataRegion: u.data_region },
    plan: { id: plan, ...PLANS[plan], meetingLimitMinutes: meetingLimitMinutes(plan), paidUntil: u.paid_until },
    calendar: {
      feedUrl: `${config.appUrl}/api/calendar/feed/${u.ics_token}.ics`,
      google: { available: Boolean(config.google.clientId), connected: u.google_connected },
      microsoft: { available: Boolean(config.microsoft.clientId), connected: u.microsoft_connected },
    },
    integrations: { whatsapp: whatsappEnabled(), sms: smsEnabled(), dialIn: Boolean(config.dialinNumber) },
    languages: Object.entries(LANGUAGES).map(([id, l]) => ({ id, name: l.name })),
  });
}));

/** The welcome guide was finished, skipped or closed: don't show it again (Settings can still replay it). */
authRouter.post("/me/onboarded", requireAuth, ah(async (req, res) => {
  await q("UPDATE users SET onboarded_at = coalesce(onboarded_at, now()) WHERE id = $1", [req.user!.id]);
  res.json({ ok: true });
}));

/** Update your own name, WhatsApp number or language. */
authRouter.patch("/me", requireAuth, ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    language: z.string().refine(isLanguage, "unknown language").optional(),
  }), req.body);
  // A new number must be real (with country code) and not used by another account; "" or null removes it.
  const phone = b.phone ? normalizePhone(b.phone) : b.phone === undefined ? undefined : null;
  if (phone) await assertPhoneFree(phone, req.user!.id);
  /**   // coalesce keeps fields that were not sent; phone uses a flag because null means "remove my number". */
  await q(`UPDATE users SET name = coalesce($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
           preferred_language = coalesce($5, preferred_language) WHERE id = $1`,
    [req.user!.id, b.name ?? null, phone !== undefined, phone ?? null, b.language ?? null]);
  res.json({ ok: true });
}));

/** Admins: rename the workspace, set its country and data home region (data residency). */
authRouter.patch("/org", requireAuth, requireAdmin, ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(120).optional(),
    country: z.string().trim().length(2).optional(),
    dataRegion: z.enum(["af-south-1", "lagos", "nairobi", "accra"]).optional(),
  }), req.body);
  await q("UPDATE organizations SET name = coalesce($2,name), country = coalesce($3,country), data_region = coalesce($4,data_region) WHERE id = $1",
    [req.user!.orgId, b.name ?? null, b.country?.toUpperCase() ?? null, b.dataRegion ?? null]);
  res.json({ ok: true });
}));

/* ---------- Team (company workspaces) ---------- */

/** Everyone in my workspace. `pending`: added by an admin but hasn't finished sign-up (no password yet). */
authRouter.get("/team", requireAuth, ah(async (req, res) => {
  res.json(await q("SELECT id, name, email, phone, role, created_at, password_hash IS NULL AS pending FROM users WHERE org_id = $1 ORDER BY created_at", [req.user!.orgId]));
}));

/**
 * Admins: add a colleague by email (they sign in with a code; no password to share).
 * Adding a member turns an individual account into a company workspace.
 */
authRouter.post("/team", requireAuth, requireAdmin, ah(async (req, res) => {
  const b = parse(z.object({ email, name: z.string().trim().min(1).max(80), role: z.enum(["admin", "member"]).default("member") }), req.body);
  if (await one("SELECT 1 FROM users WHERE email = $1", [b.email])) throw new HttpError(409, "That email already has a Gather account.");
  const u = await one("INSERT INTO users (org_id, name, email, role) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role",
    [req.user!.orgId, b.name, b.email, b.role]);
  const org = await one("UPDATE organizations SET kind = 'company' WHERE id = $1 RETURNING name", [req.user!.orgId]);
  await sendEmail({
    to: b.email, kind: "team_invite", subject: `${req.user!.name} added you to Gather`,
    text: [
      `Hi ${b.name.split(" ")[0]},`, "",
      `${req.user!.name} added you to the ${org.name} workspace on Gather as ${b.role === "admin" ? "an admin" : "a member"}.`, "",
      "Finish setting up your account (it takes a minute):",
      `${config.appUrl}/signup?email=${encodeURIComponent(b.email)}`, "",
      `Use this email address (${b.email}). We'll send you a 6-digit code, then you choose your password.`,
    ].join("\n"),
  });
  res.status(201).json(u);
}));

/** Admins: change someone's role (admin/member). The owner's role never changes. */
authRouter.patch("/team/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  const b = parse(z.object({ role: z.enum(["admin", "member"]) }), req.body);
  const r = await q("UPDATE users SET role = $3 WHERE id = $1 AND org_id = $2 AND role <> 'owner' RETURNING id", [req.params.id, req.user!.orgId, b.role]);
  if (!r.length) throw new HttpError(404, "Team member not found (the owner's role can't change).");
  res.json({ ok: true });
}));

/** Admins: remove a member. Their meetings move to the admin so history is not lost. The owner cannot be removed. */
authRouter.delete("/team/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  if (req.params.id === req.user!.id) throw new HttpError(400, "You can't remove yourself.");
  const target = await one("SELECT role FROM users WHERE id = $1 AND org_id = $2", [req.params.id, req.user!.orgId]);
  if (!target || target.role === "owner") throw new HttpError(404, "Team member not found (the owner can't be removed).");
  // Keep their meetings (and history): hand them to the admin who removed them.
  await q("UPDATE meetings SET host_id = $3 WHERE host_id = $1 AND org_id = $2", [req.params.id, req.user!.orgId, req.user!.id]);
  const r = await q("DELETE FROM users WHERE id = $1 AND org_id = $2 AND role <> 'owner' RETURNING id", [req.params.id, req.user!.orgId]);
  if (!r.length) throw new HttpError(404, "Team member not found.");
  res.json({ ok: true });
}));
