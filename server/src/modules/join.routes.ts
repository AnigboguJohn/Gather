/**
 * Joining a call. Guests need no account: name, WhatsApp number or email, caption language.
 * Hosts (and their team) join with their account. Also: RSVP buttons, captions upload, LiveKit webhooks.
 */
import { Router } from "express";
import multer from "multer";
import { WebhookReceiver } from "livekit-server-sdk";
import { z } from "zod";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";
import * as ai from "../lib/ai.js";
import { requireAuth, requireTicket, signWait } from "../lib/auth.js";
import { passcodeMatches } from "../lib/codes.js";
import { ah, HttpError, parse, rateLimit } from "../lib/http.js";
import { isLanguage, LANGUAGES } from "../lib/languages.js";
import { nextOccurrence } from "../lib/time.js";
import { checkCode, issueCode } from "./auth.routes.js";
import { dialInEnabled } from "./dialin.js";
import { admit, canSpeak, emitCaption, enqueueLobby, getOrStartRoom, getRoom, phoneJoined, phoneLeft, roomLanguages } from "./rooms.js";

// Mostly public routes (no account): join info, guest join, RSVP. Plus host join, captions and LiveKit webhooks.
export const joinRouter = Router();

/** Find a meeting by its link code; cancelled or ended meetings give a clear 410 message. */
async function meetingBySlug(slug: string) {
  const m = await one("SELECT m.*, u.name AS host_name FROM meetings m JOIN users u ON u.id = m.host_id WHERE m.slug = $1", [slug]);
  if (!m) throw new HttpError(404, "This meeting link is not valid. Check the link with the host.");
  if (m.status === "cancelled") throw new HttpError(410, "This meeting was cancelled.");
  if (m.status === "ended") throw new HttpError(410, "This meeting has ended.");
  return m;
}

/** What the join screen needs to know (no private data). */
/**
 * What the join screen needs: title, host name, whether a passcode/waiting room/email check applies,
 * languages, whether captions are available, dial-in info, and (with ?i=token) the invitee's details to pre-fill.
 */
joinRouter.get("/public/meetings/:slug", ah(async (req, res) => {
  const m = await meetingBySlug(req.params.slug);
  const inv = req.query.i ? await one("SELECT name, email, phone, language FROM invitees WHERE token = $1 AND meeting_id = $2", [String(req.query.i), m.id]) : null;
  const room = getRoom(m.slug);
  const health = await ai.aiHealth();
  res.json({
    slug: m.slug, title: m.title, host: m.host_name, kind: m.kind, startAt: nextOccurrence(m) ?? m.start_at, durationMin: m.duration_min,
    timeZone: m.time_zone, live: Boolean(room), people: room?.people.size ?? 0,
    needsPasscode: Boolean(m.passcode_hash), waitingRoom: m.waiting_room, verifyGuests: m.verify_guests, e2ee: m.e2ee,
    languages: m.languages, allLanguages: Object.entries(LANGUAGES).map(([id, l]) => ({ id, name: l.name })),
    captions: health.stt && !m.e2ee,
    dialIn: dialInEnabled() && m.dialin_pin ? { number: config.dialinNumber, pin: m.dialin_pin } : null,
    invitee: inv,
  });
}));

/** Optional contact check: email a code to the guest before they join (host setting). */
/** Email a check-in code to a guest (only used when the host turned on "Check guests' email"). */
joinRouter.post("/public/meetings/:slug/verify", ah(async (req, res) => {
  const m = await meetingBySlug(req.params.slug);
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  await issueCode(b.email, `guest:${m.slug}`, "meeting check-in");
  res.json({ sent: true });
}));

// Guest join form: name, at least one contact (WhatsApp or email), caption language, consent, and optional extras.
const guestBody = z.object({
  name: z.string().trim().min(1, "Enter your name").max(60),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().regex(/^[+\d][\d\s-]{6,20}$/, "Enter a valid WhatsApp number").optional().or(z.literal("").transform(() => undefined)),
  language: z.string().refine(isLanguage, "unknown language").default("en"),
  consent: z.boolean().default(true),
  passcode: z.string().trim().max(20).optional(),
  invite: z.string().trim().max(64).optional(),
  code: z.string().trim().max(12).optional(),
}).refine((b) => b.email || b.phone, { message: "Enter your WhatsApp number or email", path: ["contact"] });

/**
 * A guest joins without an account. Checks, in order: rate limit, passcode, email code (if required),
 * locked room. Then either parks them in the waiting room (returns a wait token) or admits them
 * (returns LiveKit token + room ticket). Guests start with camera allowed and mic locked.
 */
joinRouter.post("/public/meetings/:slug/join", ah(async (req, res) => {
  if (!rateLimit(`join:${req.ip}`, 30, 60_000)) throw new HttpError(429, "Too many attempts. Wait a minute.");
  const m = await meetingBySlug(req.params.slug);
  const b = parse(guestBody, req.body);
  if (m.passcode_hash && !passcodeMatches(b.passcode ?? "", m.passcode_hash)) throw new HttpError(403, "Wrong passcode.", { field: "passcode" });
  let verified = false;
  if (m.verify_guests) {
    if (!b.email) throw new HttpError(400, "This meeting checks guests by email. Enter your email.", { field: "email" });
    if (!b.code) throw new HttpError(400, "Enter the code we emailed you.", { field: "code", needsCode: true });
    await checkCode(b.email, `guest:${m.slug}`, b.code);
    verified = true;
  }
  const room = await getOrStartRoom(m);
  if (room.locked) throw new HttpError(403, "The host has locked this meeting. Ask them to unlock it.");
  /**   // Joining from a personal invite link counts as "attending". */
  if (b.invite) await q("UPDATE invitees SET rsvp = 'yes', language = $3 WHERE token = $1 AND meeting_id = $2", [b.invite, m.id, b.language]);
  const info = { name: b.name, lang: b.language, email: b.email ?? null, phone: b.phone ?? null, consent: b.consent, verified };
  if (room.waitingRoom) {
    const waitId = enqueueLobby(room, info);
    return res.json({ status: "waiting", wait: signWait({ slug: m.slug, waitId }) });
  }
  res.json(await admit(room, { ...info, role: "guest" }));
}));

/** Hosts and their workspace join with their account (host or co-host role, never the waiting room). */
/**
 * Signed-in join: the meeting's host joins as "host"; other members of the same workspace join as co-hosts.
 * People from other workspaces must use the guest form (403 here).
 */
joinRouter.post("/meetings/by-slug/:slug/join", requireAuth, ah(async (req, res) => {
  const m = await meetingBySlug(req.params.slug);
  const u = req.user!;
  if (m.org_id !== u.orgId) throw new HttpError(403, "This meeting belongs to another workspace. Join as a guest instead.");
  const me = await one("SELECT phone, preferred_language FROM users WHERE id = $1", [u.id]);
  const lang = isLanguage(req.body?.language) ? req.body.language : me.preferred_language;
  const room = await getOrStartRoom(m);
  res.json(await admit(room, {
    name: u.name, role: m.host_id === u.id ? "host" : "cohost", lang, userId: u.id, email: u.email, phone: me.phone, consent: true, verified: true,
  }));
}));

/** RSVP buttons in WhatsApp/email: /r/:token?r=yes|no */
/** RSVP buttons in WhatsApp/email invites (/r/:token?r=yes|no in the web app call this). */
joinRouter.post("/public/rsvp/:token", ah(async (req, res) => {
  const b = parse(z.object({ r: z.enum(["yes", "no"]) }), req.body);
  const inv = await one(
    `UPDATE invitees i SET rsvp = $2 FROM meetings m WHERE i.token = $1 AND m.id = i.meeting_id
     RETURNING m.title, m.slug, m.start_at, m.time_zone, m.status`, [req.params.token, b.r]);
  if (!inv) throw new HttpError(404, "This invite link is not valid.");
  res.json({ title: inv.title, slug: inv.slug, startAt: inv.start_at, timeZone: inv.time_zone, status: inv.status, rsvp: b.r });
}));

/* ---------- Live captions ----------
 * The speaker's browser sends short audio chunks (about 4 s) only while their mic is on and they are talking.
 * We transcribe, translate into every language someone in the room follows, and broadcast.
 */
// Caption chunks stay in memory (max 2 MB; a 4-second chunk is ~15 KB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
// Phrases speech-to-text tends to invent from silence or noise; never shown as captions.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|\.|bye\.?|subtitles by.*|amara\.org.*)$/i;

/**
 * Live captions. Only someone allowed to speak may send audio (mic-locked guests get 403), and never in
 * encrypted meetings. Flow: transcribe in the speaker's language → translate into every language someone in
 * the room follows (plus English for the summary) → save to the transcript → broadcast to the room.
 */
joinRouter.post("/rooms/captions", requireTicket, upload.single("audio"), ah(async (req, res) => {
  const t = req.ticket!;
  const room = getRoom(t.slug);
  if (!room || room.sessionId !== t.sessionId) throw new HttpError(410, "Meeting ended.");
  if (room.e2ee) throw new HttpError(400, "Captions are off in end-to-end encrypted meetings.");
  if (!canSpeak(room, t.identity)) throw new HttpError(403, "Your mic is locked.");
  if (!req.file?.buffer?.length) throw new HttpError(400, "No audio.");
  if (!rateLimit(`cap:${t.identity}`, 30, 60_000)) throw new HttpError(429, "Too many caption chunks.");
  const speaker = room.people.get(t.identity)!;
  const lang = speaker.lang;
  let raw = "";
  try {
    raw = (await ai.transcribe(req.file.buffer, req.file.mimetype || "audio/webm", lang)).text;
  } catch (e: any) {
    log.warn({ err: e?.message }, "transcribe failed");
    throw new HttpError(502, "Captions are unavailable right now.");
  }
  const text = (raw ?? "").trim();
  if (!text || HALLUCINATIONS.test(text)) return res.json({ text: "" });
  /**   // Translate once per language present in the room, not once per listener. */
  const targets = [...new Set([...roomLanguages(room), "en"])].filter((l) => l !== lang);
  let translations: Record<string, string> = {};
  if (targets.length) {
    try { translations = (await ai.translate(text, lang, targets)).translations; } catch (e: any) { log.warn({ err: e?.message }, "translate failed"); }
  }
  const english = lang === "en" ? text : translations.en ?? null;
  const row = await one(
    "INSERT INTO transcript_lines (session_id, speaker_identity, speaker_name, lang, text, english) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at",
    [room.sessionId, t.identity, speaker.name, lang, text, english]);
  emitCaption(room, { id: row.id, identity: t.identity, name: speaker.name, lang, text, translations: { ...translations, [lang]: text }, at: row.created_at });
  res.json({ text });
}));

/* ---------- LiveKit webhooks (phone callers joining over SIP) ---------- */
// LiveKit signs its webhooks with our API key/secret; WebhookReceiver checks that signature.
const receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);
/**
 * LiveKit webhooks. Used for phone (SIP) callers, who never open the web app: their identity starts with "sip_".
 * Room names of breakout rooms look like "<slug>~2", so the part before "~" is the meeting.
 */
joinRouter.post("/livekit/webhook", ah(async (req: any, res) => {
  const ev = await receiver.receive(req.rawBody?.toString("utf8") ?? "", req.get("Authorization") ?? "");
  const p = ev.participant;
  const slug = ev.room?.name?.split("~")[0];
  if (p && slug && p.identity.startsWith("sip_")) {
    if (ev.event === "participant_joined") await phoneJoined(slug, p.identity, p.name || "Phone caller");
    if (ev.event === "participant_left") await phoneLeft(slug, p.identity);
  }
  res.json({ ok: true });
}));
