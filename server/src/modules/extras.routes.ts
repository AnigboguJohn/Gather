/**
 * Phase 2/3 features: calendar feed + sync, recordings, and "Ask your meetings" search.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { one, q } from "../db.js";
import * as ai from "../lib/ai.js";
import { requireAuth, requireTicket } from "../lib/auth.js";
import { ah, HttpError, parse } from "../lib/http.js";
import { icsCalendar } from "../lib/ics.js";
import { joinUrl } from "../lib/messages.js";
import { effectivePlan, PLANS } from "../lib/plans.js";
import { authUrl, connect, disconnect, readState, type Provider } from "./calendar.js";
import { getRoom } from "./rooms.js";

// Routes: /calendar/*, /rooms/recordings, /recordings/*, /search, /rooms/alive
export const extrasRouter = Router();

/* ---------- Calendar ---------- */

/** Private feed: subscribe to it from Google Calendar ("From URL"), Outlook or Apple Calendar. */
/** Private calendar feed. The random token in the URL is the only "password", so hosts should keep it private. */
extrasRouter.get("/calendar/feed/:token.ics", ah(async (req, res) => {
  const u = await one("SELECT id, email FROM users WHERE ics_token = $1", [req.params.token]);
  if (!u) throw new HttpError(404, "Unknown calendar feed.");
  const ms = await q(
    `SELECT * FROM meetings WHERE host_id = $1 AND kind = 'scheduled' AND status IN ('scheduled','live')
     AND (repeat_rule = 'weekly' OR start_at > now() - interval '30 days') ORDER BY start_at LIMIT 500`, [u.id]);
  res.type("text/calendar").send(icsCalendar(ms.map((m) => ({
    uid: m.id, title: m.title, start: new Date(m.start_at), durationMin: m.duration_min, url: joinUrl(config.appUrl, m.slug),
    weekly: m.repeat_rule === "weekly", organizerEmail: u.email,
  }))));
}));

// Calendar providers we can sync with.
const provider = z.enum(["google", "microsoft"]);
/** Start connecting Google or Outlook: returns the provider's consent page URL. */
extrasRouter.get("/calendar/:provider/connect", requireAuth, ah(async (req, res) => {
  const p = parse(provider, req.params.provider) as Provider;
  if (!(p === "google" ? config.google.clientId : config.microsoft.clientId)) throw new HttpError(400, `${p} calendar is not set up on this server.`);
  res.json({ url: authUrl(p, req.user!.id) });
}));
/** The provider sends the user back here with a code; we store a refresh token and return to Settings. */
extrasRouter.get("/calendar/:provider/callback", ah(async (req, res) => {
  try {
    const { userId, p } = readState(String(req.query.state ?? ""));
    if (req.query.error) throw new Error(String(req.query.error));
    await connect(p, userId, String(req.query.code ?? ""));
    res.redirect(`${config.appUrl}/settings?calendar=connected`);
  } catch (e: any) {
    res.redirect(`${config.appUrl}/settings?calendar=error&msg=${encodeURIComponent(e?.message ?? "failed")}`);
  }
}));
/** Disconnect a calendar (forget the refresh token). */
extrasRouter.delete("/calendar/:provider", requireAuth, ah(async (req, res) => {
  await disconnect(parse(provider, req.params.provider) as Provider, req.user!.id);
  res.json({ ok: true });
}));

/* ---------- Recordings ----------
 * The host's browser records the meeting tab (video + everyone's audio) and uploads it when stopped.
 * Production upgrade path: LiveKit Egress writing straight to S3 (see docs/ARCHITECTURE.md).
 */
// Recordings live on disk under DATA_DIR/recordings with random file names.
const recDir = path.resolve(config.dataDir, "recordings");
fs.mkdirSync(recDir, { recursive: true });
// Up to 2 GB per recording, written straight to disk (not memory).
const recUpload = multer({
  storage: multer.diskStorage({ destination: recDir, filename: (_req, _f, cb) => cb(null, `${crypto.randomUUID()}.webm`) }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

/**
 * Upload a recording made in the host's browser. Hosts/co-hosts only, and only on plans with recordings.
 * Rejected files are deleted immediately.
 */
extrasRouter.post("/rooms/recordings", requireTicket, recUpload.single("file"), ah(async (req, res) => {
  const t = req.ticket!;
  const cleanup = () => req.file && fs.rmSync(req.file.path, { force: true });
  if (t.role === "guest") { cleanup(); throw new HttpError(403, "Only hosts can record."); }
  const s = await one(
    "SELECT s.id, o.plan, o.paid_until FROM sessions s JOIN meetings m ON m.id = s.meeting_id JOIN organizations o ON o.id = m.org_id WHERE s.id = $1",
    [t.sessionId]);
  if (!s || !PLANS[effectivePlan(s)].recordings) { cleanup(); throw new HttpError(403, "Recording is on the Pro and Business plans."); }
  if (!req.file) throw new HttpError(400, "No file.");
  const r = await one("INSERT INTO recordings (session_id, file_name, size_bytes, mime) VALUES ($1,$2,$3,$4) RETURNING id",
    [t.sessionId, path.basename(req.file.path), req.file.size, req.file.mimetype || "video/webm"]);
  res.status(201).json({ id: r.id });
}));

/** Short-lived signed link so a <video> tag can play the file. */
/** A 2-hour signed link to play/download a recording (members only see their own meetings' recordings). */
extrasRouter.get("/recordings/:id/link", requireAuth, ah(async (req, res) => {
  const r = await one(
    `SELECT r.id FROM recordings r JOIN sessions s ON s.id = r.session_id JOIN meetings m ON m.id = s.meeting_id
     WHERE r.id = $1 AND m.org_id = $2 AND ($3 <> 'member' OR m.host_id = $4)`, [req.params.id, req.user!.orgId, req.user!.role, req.user!.id]);
  if (!r) throw new HttpError(404, "Recording not found.");
  const sig = jwt.sign({ typ: "rec", id: r.id }, config.jwtSecret, { expiresIn: "2h" });
  res.json({ url: `/api/recordings/${r.id}/file?sig=${sig}` });
}));
/** Stream a recording if the signed link is valid (supports seeking via range requests). */
extrasRouter.get("/recordings/:id/file", ah(async (req, res) => {
  let ok = false;
  try { const p = jwt.verify(String(req.query.sig ?? ""), config.jwtSecret) as any; ok = p.typ === "rec" && p.id === req.params.id; } catch { /* invalid */ }
  if (!ok) throw new HttpError(401, "Link expired.");
  const r = await one("SELECT file_name, mime FROM recordings WHERE id = $1", [req.params.id]);
  if (!r) throw new HttpError(404, "Recording not found.");
  res.type(r.mime).sendFile(path.join(recDir, r.file_name), { acceptRanges: true });
}));

/* ---------- Ask your meetings ---------- */
/**
 * "Ask your meetings": full-text search over captions and chat in this workspace, then the AI writes a short
 * answer citing the matching passages as [M1], [M2]...
 */
extrasRouter.post("/search", requireAuth, ah(async (req, res) => {
  const b = parse(z.object({ question: z.string().trim().min(3).max(300) }), req.body);
  const u = req.user!;
  const scope = u.role === "member" ? "AND m.host_id = $3" : "";
  const params: unknown[] = [u.orgId, b.question, ...(u.role === "member" ? [u.id] : [])];
  // Full-text search over captions and chat; words joined with OR so partial matches still rank.
  /**   // Keep words of 3+ letters/digits and join them with OR ("|"); safe input for to_tsquery. */
  const words = b.question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  params[1] = words.join(" | ") || b.question;
  /**   // Best 12 matches across transcript lines and chat messages, ranked by relevance. */
  let rows = await q(
    `SELECT t.id::text, t.speaker_name AS speaker, coalesce(t.english, t.text) AS text, m.title AS meeting, m.id AS meeting_id,
            s.id AS session_id, s.started_at, ts_rank(t.tsv, to_tsquery('simple', $2)) AS rank
     FROM transcript_lines t JOIN sessions s ON s.id = t.session_id JOIN meetings m ON m.id = s.meeting_id
     WHERE m.org_id = $1 ${scope} AND t.tsv @@ to_tsquery('simple', $2)
     UNION ALL
     SELECT 'c' || c.id, c.sender_name, c.text, m.title, m.id, s.id, s.started_at,
            ts_rank(to_tsvector('simple', c.text), to_tsquery('simple', $2))
     FROM chat_messages c JOIN sessions s ON s.id = c.session_id JOIN meetings m ON m.id = s.meeting_id
     WHERE m.org_id = $1 ${scope} AND to_tsvector('simple', c.text) @@ to_tsquery('simple', $2)
     ORDER BY rank DESC LIMIT 12`,
    params).catch(() => []);
  if (!rows.length) {
    return res.json({ answer: "I couldn't find that in your meetings yet. Captions must be on during a meeting for it to be searchable.", citations: [], passages: [] });
  }
  rows = rows.map((r, i) => ({ ...r, ref: `M${i + 1}` }));
  const out = await ai.answer(b.question, rows.map((r) => ({
    id: r.ref, meeting: r.meeting, date: new Date(r.started_at).toISOString().slice(0, 10), speaker: r.speaker, text: r.text,
  })));
  res.json({ ...out, passages: rows.map((r) => ({ ref: r.ref, meeting: r.meeting, meetingId: r.meeting_id, sessionId: r.session_id, date: r.started_at, speaker: r.speaker, text: r.text })) });
}));

/** Lets an open room page check that the session is still live (used after reconnects). */
/** Is my meeting session still running? (A room page can check after reconnecting.) */
extrasRouter.get("/rooms/alive", requireTicket, (req, res) => {
  const r = getRoom(req.ticket!.slug);
  res.json({ alive: Boolean(r && r.sessionId === req.ticket!.sessionId) });
});
