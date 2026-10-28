/**
 * Reviews of Gather (/api/rooms/review*, /api/public/review*).
 *  - Hosts and guests are asked once, on the end screen of their first meeting. A person is recognised by their
 *    account, email or phone number, so the same guest is never asked twice.
 *  - "Not now" (or closing the tab) sends them the review link once, by WhatsApp and/or email; the link works
 *    without an account.
 *  - Published reviews (good and bad alike) feed the landing page's testimonials and /reviews. Open pages get new
 *    ones live over a small Server-Sent Events stream. Platform admins can hide abuse (admin.routes.ts).
 */
import crypto from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";
import { requireTicket, type RoomTicket } from "../lib/auth.js";
import { ah, HttpError, parse, rateLimit } from "../lib/http.js";
import { emailLayout, escapeHtml, normalizePhone, sendEmail, sendWhatsApp, type Status } from "../lib/notify.js";

export const reviewsRouter = Router();

/** Who is reviewing: account (if any), email and phone (international digits), plus name and role in the call. */
export interface Who { userId: string | null; email: string | null; phone: string | null; name: string; role: string }

export const who = (p: { userId?: string | null; email?: string | null; phone?: string | null; name: string; role?: string }): Who => ({
  userId: p.userId ?? null,
  email: p.email?.trim().toLowerCase() || null,
  phone: p.phone ? normalizePhone(p.phone) || null : null,
  name: p.name.trim().slice(0, 60) || "Gather user",
  role: p.role ?? "guest",
});

// Same person = same account, email or phone. (NULL never equals anything in SQL, so missing contacts don't match.)
const SAME = "(user_id = $1 OR email = $2 OR phone = $3)";
const keys = (w: Who) => [w.userId, w.email, w.phone];

/** How a review is shown in public: first name and last initial ("Ngozi A."), or "Anonymous". */
export function publicName(name: string, anonymous: boolean) {
  if (anonymous) return "Anonymous";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Gather user";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

/** Trustpilot-style words for a score: 5 Excellent · 4 Great · 3 Average · 2 Poor · 1 Bad. */
export function scoreLabel(score: number) {
  return score >= 4.3 ? "Excellent" : score >= 3.5 ? "Great" : score >= 2.5 ? "Average" : score >= 1.5 ? "Poor" : "Bad";
}

/** What the form offers to tick. Good ratings ask what they liked, low ratings what went wrong. */
export const TAGS = {
  good: ["Video quality", "Clear audio", "Live captions", "Translation", "Meeting summary", "Low data use", "Easy to join", "WhatsApp invites"],
  bad: ["Video froze", "Audio problems", "Captions were wrong", "Hard to join", "Used too much data", "Dropped from the call", "Confusing to use"],
};
const ALL_TAGS = new Set([...TAGS.good, ...TAGS.bad]);

const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  tags: z.array(z.string()).max(8).default([]).transform((t) => [...new Set(t.filter((x) => ALL_TAGS.has(x)))]),
  comment: z.string().trim().max(300).optional().transform((c) => c || null),
  anonymous: z.boolean().default(false),
});

/** Has this person already reviewed? */
const hasReviewed = async (w: Who) => Boolean(await one(`SELECT 1 FROM reviews WHERE ${SAME}`, keys(w)));
/** Their review request, if they were ever asked. */
const requestOf = (w: Who) => one(`SELECT * FROM review_requests WHERE ${SAME} ORDER BY created_at LIMIT 1`, keys(w));

/** Record that this person is being asked (their first meeting). Does nothing if they were asked before. */
async function createRequest(w: Who, sessionId: string | null) {
  if (!w.userId && !w.email && !w.phone) return null;
  return one(
    `INSERT INTO review_requests (token, session_id, user_id, role, name, email, phone) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING RETURNING *`,
    [crypto.randomBytes(16).toString("hex"), sessionId, w.userId, w.role, w.name, w.email, w.phone]);
}

/** The person behind a room ticket, from their participant row (guests' contacts are only stored there). */
async function whoInCall(t: RoomTicket) {
  const p = await one("SELECT user_id, name, email, phone, role, via FROM participants WHERE session_id = $1 AND identity = $2", [t.sessionId, t.identity]);
  if (!p) throw new HttpError(404, "We couldn't find you in this meeting.");
  return { w: who({ userId: p.user_id, email: p.email, phone: p.phone, name: p.name, role: p.role }), phoneCaller: p.via === "phone" };
}

/**
 * Should the end screen ask this person for a review? Only if they never reviewed and this is the meeting in
 * which they were first asked (that is, their first meeting since reviews started).
 */
export async function reviewStatus(t: RoomTicket) {
  const { w, phoneCaller } = await whoInCall(t);
  if (phoneCaller) return { ask: false, reviewed: false };
  if (await hasReviewed(w)) return { ask: false, reviewed: true };
  const r = (await requestOf(w)) ?? (await createRequest(w, t.sessionId));
  return { ask: Boolean(r && r.session_id === t.sessionId && !r.skipped_at), reviewed: false, name: w.name, tags: TAGS };
}

/** When a meeting ends, everyone in it who was never asked counts as asked now (their link follows if they don't review). */
export async function requestReviewsForSession(sessionId: string) {
  const people = await q("SELECT user_id, name, email, phone, role FROM participants WHERE session_id = $1 AND via = 'web'", [sessionId]);
  for (const p of people) {
    const w = who({ userId: p.user_id, email: p.email, phone: p.phone, name: p.name, role: p.role });
    if (!(await hasReviewed(w)) && !(await requestOf(w))) await createRequest(w, sessionId);
  }
}

/** Save a review (one per person), then tell open landing pages. */
async function saveReview(w: Who, b: z.infer<typeof reviewBody>, sessionId: string | null, via: "call" | "link") {
  const row = await one(
    `INSERT INTO reviews (session_id, user_id, role, name, email, phone, rating, tags, comment, anonymous, via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
    [sessionId, w.userId, w.role, w.name, w.email, w.phone, b.rating, b.tags, b.comment, b.anonymous, via]);
  if (!row) throw new HttpError(409, "You've already reviewed Gather. Thank you!");
  log.info({ rating: b.rating, role: w.role, via }, "new review");
  broadcastReviews("review", toPublic(row));
  return toPublic(row);
}

/** Message with the review link, for people who skipped. Sent once, on WhatsApp (when set up) and email. */
export async function sendReviewLink(requestId: string): Promise<Status | null> {
  const r = await one("UPDATE review_requests SET sent_at = now() WHERE id = $1 AND sent_at IS NULL RETURNING *", [requestId]);
  if (!r) return null; // already sent
  const first = r.name.split(/\s+/)[0];
  const url = `${config.appUrl}/review/${r.token}`;
  const text = `Hi ${first}, thanks for meeting on Gather! How did it go? Tap to rate us (it takes 30 seconds): ${url}`;
  const results: Status[] = [];
  if (r.phone) results.push(await sendWhatsApp({ to: r.phone, text, kind: "review" }));
  if (r.email) {
    results.push(await sendEmail({
      to: r.email, kind: "review", subject: "How was your Gather meeting?",
      text: `Hi ${first},\n\nThanks for meeting on Gather. How did it go? Good or bad, your review helps us make calls better on any network.\n\nRate Gather (30 seconds): ${url}\n\nThe Gather team`,
      html: emailLayout({
        preheader: "Rate your Gather meeting in 30 seconds",
        body: `<p style="margin:0 0 12px">Hi ${escapeHtml(first)},</p><p style="margin:0 0 20px">Thanks for meeting on Gather. How did it go? Good or bad, your review helps us make calls better on any network.</p>
<p style="margin:0 0 8px;font-size:28px;letter-spacing:4px;color:#f59e0b">★★★★★</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">Rate Gather</a></p>
<p style="margin:0;color:#78716c;font-size:13px">It takes about 30 seconds. No account needed.</p>`,
      }),
    }));
  }
  const status: Status = results.includes("sent") ? "sent" : results.includes("failed") ? "failed" : "skipped";
  await q("UPDATE review_requests SET sent_status = $2 WHERE id = $1", [r.id, status]);
  return status;
}

/** Scheduler pass: people asked over 30 minutes ago who haven't reviewed or been sent the link get it now. */
export async function sendDueReviewLinks() {
  const due = await q(
    `SELECT rr.id FROM review_requests rr WHERE rr.sent_at IS NULL AND rr.created_at < now() - interval '30 minutes'
     AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = rr.user_id OR r.email = rr.email OR r.phone = rr.phone)
     ORDER BY rr.created_at LIMIT 20`);
  for (const r of due) await sendReviewLink(r.id);
  return due.length;
}

/** A review as the public sees it: no email or phone, first name and initial only. */
export const toPublic = (r: any) => ({
  id: r.id, rating: r.rating, tags: r.tags ?? [], comment: r.comment, name: publicName(r.name, r.anonymous),
  role: r.role === "guest" ? "Guest" : "Host", via: r.via, createdAt: r.created_at,
});

/** Average, count and how many of each star, for published reviews. */
export async function reviewSummary() {
  const rows = await q<{ rating: number; n: string }>("SELECT rating, count(*) AS n FROM reviews WHERE NOT hidden GROUP BY rating");
  const dist = [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: Number(rows.find((r) => r.rating === s)?.n ?? 0) }));
  const count = dist.reduce((a, d) => a + d.count, 0);
  const score = count ? Math.round((dist.reduce((a, d) => a + d.stars * d.count, 0) / count) * 10) / 10 : 0;
  return { score, count, label: count ? scoreLabel(score) : null, dist };
}

/* ---------- Live updates (Server-Sent Events) ---------- */
const listeners = new Set<Response>();
/** Tell every open landing / reviews page that something changed ("review" = a new one, "changed" = hidden/shown). */
export function broadcastReviews(event: "review" | "changed", data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}

/* ---------- In the call (room ticket) ---------- */
reviewsRouter.get("/rooms/review", requireTicket, ah(async (req, res) => res.json(await reviewStatus(req.ticket!))));

reviewsRouter.post("/rooms/review", requireTicket, ah(async (req, res) => {
  const { w } = await whoInCall(req.ticket!);
  const b = parse(reviewBody, req.body);
  res.json(await saveReview(w, b, req.ticket!.sessionId, "call"));
}));

/** "Not now": they get the link on WhatsApp/email instead. */
reviewsRouter.post("/rooms/review/skip", requireTicket, ah(async (req, res) => {
  const { w } = await whoInCall(req.ticket!);
  if (await hasReviewed(w)) return res.json({ sent: null });
  const r = (await requestOf(w)) ?? (await createRequest(w, req.ticket!.sessionId));
  if (!r) return res.json({ sent: null });
  await q("UPDATE review_requests SET skipped_at = now() WHERE id = $1 AND skipped_at IS NULL", [r.id]);
  res.json({ sent: await sendReviewLink(r.id), email: Boolean(r.email), phone: Boolean(r.phone) });
}));

/* ---------- From the WhatsApp / email link (no account) ---------- */
reviewsRouter.get("/public/review-links/:token", ah(async (req, res) => {
  const r = await one("SELECT * FROM review_requests WHERE token = $1", [req.params.token]);
  if (!r) throw new HttpError(404, "This review link is not valid.");
  const w = who({ userId: r.user_id, email: r.email, phone: r.phone, name: r.name, role: r.role });
  res.json({ name: w.name.split(/\s+/)[0], reviewed: await hasReviewed(w), tags: TAGS });
}));

reviewsRouter.post("/public/review-links/:token", ah(async (req, res) => {
  if (!rateLimit(`review:${req.ip}`, 10, 60_000)) throw new HttpError(429, "Too many tries. Wait a minute.");
  const r = await one("SELECT * FROM review_requests WHERE token = $1", [req.params.token]);
  if (!r) throw new HttpError(404, "This review link is not valid.");
  const b = parse(reviewBody, req.body);
  res.json(await saveReview(who({ userId: r.user_id, email: r.email, phone: r.phone, name: r.name, role: r.role }), b, r.session_id, "link"));
}));

/* ---------- Public: summary, list, live stream ---------- */
/** Summary plus the newest published reviews (?stars=1..5 filters, ?before=<ISO date> pages back). */
reviewsRouter.get("/public/reviews", ah(async (req, res) => {
  const stars = Number(req.query.stars) || null;
  const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const rows = await q(
    `SELECT * FROM reviews WHERE NOT hidden AND ($1::int IS NULL OR rating = $1) AND ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at DESC LIMIT $3`, [stars, before, limit]);
  res.json({ summary: await reviewSummary(), reviews: rows.map(toPublic) });
}));

/** Live updates for open pages. Capped, with a heartbeat so proxies keep the connection open. */
reviewsRouter.get("/public/reviews/stream", (req, res) => {
  if (listeners.size >= 1000) return res.status(503).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 10000\n\n");
  listeners.add(res);
  const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(beat); listeners.delete(res); });
});
