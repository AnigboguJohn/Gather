/**
 * Meetings for signed-in hosts: Meet now, Schedule (one-off or weekly), invites, RSVP,
 * edits/cancellations, history (attendance, summary, transcript, recordings).
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { requireAuth, type AuthUser } from "../lib/auth.js";
import { hashPasscode, meetingSlug } from "../lib/codes.js";
import { ah, HttpError, parse } from "../lib/http.js";
import { icsCalendar } from "../lib/ics.js";
import { isLanguage } from "../lib/languages.js";
import { cancelText, inviteText, joinUrl, updateText } from "../lib/messages.js";
import { reach, waLink, whatsappEnabled } from "../lib/notify.js";
import { nextOccurrence } from "../lib/time.js";
import { syncMeeting } from "./calendar.js";
import { dialInEnabled, ensureDialinRule, newDialinPin, removeDialinRule } from "./dialin.js";
import { liveRoomInfo } from "./rooms.js";
import { runSummary } from "./summary.js";

// Every /meetings route needs a signed-in user.
export const meetingsRouter = Router();
meetingsRouter.use("/meetings", requireAuth);

// One invitee: a WhatsApp number or an email (or both). Empty strings count as "not given".
const invitee = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().regex(/^[+\d][\d\s-]{6,20}$/, "invalid phone number").optional().or(z.literal("").transform(() => undefined)),
}).refine((i) => i.email || i.phone, "each invitee needs a WhatsApp number or an email");

// Meeting options shared by Meet now, Schedule and Edit.
const settings = {
  languages: z.array(z.string().refine(isLanguage, "unknown language")).min(1).max(7).optional(),
  passcode: z.string().trim().regex(/^\w{4,12}$/, "4-12 letters or digits").optional().nullable(),
  waiting_room: z.boolean().optional(),
  open_mic: z.boolean().optional(),
  anyone_can_share: z.boolean().optional(),
  verify_guests: z.boolean().optional(),
  e2ee: z.boolean().optional(),
};

/** Meetings visible to a user: their own, or every meeting in the workspace for admins. */
async function loadMeeting(user: AuthUser, id: string) {
  const m = await one(
    `SELECT m.*, u.name AS host_name, u.email AS host_email FROM meetings m JOIN users u ON u.id = m.host_id
     WHERE m.id = $1 AND m.org_id = $2`, [id, user.orgId]);
  if (!m || (user.role === "member" && m.host_id !== user.id)) throw new HttpError(404, "Meeting not found.");
  return m;
}

/**
 * The meeting as the web app sees it: details, next occurrence, live status, dial-in info and
 * ready-made share links (WhatsApp, SMS, email). Never includes the passcode hash.
 */
function dto(m: any) {
  const url = joinUrl(config.appUrl, m.slug);
  const next = m.status === "scheduled" || m.status === "live" ? nextOccurrence(m) : null;
  const share = inviteText({
    host: m.host_name, title: m.title, when: m.kind === "instant" ? null : next, tz: m.time_zone, url,
    weekly: m.repeat_rule === "weekly", dialIn: dialInEnabled() && m.dialin_pin ? `${config.dialinNumber}, PIN ${m.dialin_pin}` : null,
  });
  return {
    id: m.id, slug: m.slug, title: m.title, kind: m.kind, status: m.status, startAt: m.start_at, nextAt: next,
    durationMin: m.duration_min, timeZone: m.time_zone, repeat: m.repeat_rule, languages: m.languages,
    hasPasscode: Boolean(m.passcode_hash), waitingRoom: m.waiting_room, openMic: m.open_mic,
    anyoneCanShare: m.anyone_can_share, verifyGuests: m.verify_guests, e2ee: m.e2ee,
    host: { id: m.host_id, name: m.host_name }, url,
    dialIn: dialInEnabled() && m.dialin_pin ? { number: config.dialinNumber, pin: m.dialin_pin } : null,
    live: liveRoomInfo(m.slug),
    // "Share sheet": one-tap links for WhatsApp, SMS and email (the client adds the E2EE key when needed).
    share: {
      text: share,
      whatsapp: waLink(null, share),
      sms: `sms:?&body=${encodeURIComponent(share)}`,
      email: `mailto:?subject=${encodeURIComponent(m.title)}&body=${encodeURIComponent(share)}`,
    },
  };
}

/** Send invites on every channel each invitee has; returns per-invitee wa.me links for click-to-share. */
/**
 * Send invites to these invitees on every channel they have (WhatsApp, email with .ics, optional SMS).
 * Each person gets a personal link (?i=token) and RSVP links. Returns per-person results plus a wa.me link
 * so the host can send WhatsApp invites by hand when the API is not configured.
 * Encrypted meetings are skipped: the server does not know the secret key, so the host shares the link.
 */
async function sendInvites(m: any, rows: any[], o: { passcode?: string | null; sms?: boolean }) {
  const out = [];
  for (const inv of rows) {
    const url = joinUrl(config.appUrl, m.slug, inv.token);
    const rsvp = `${config.appUrl}/r/${inv.token}`;
    const when = m.kind === "instant" ? null : nextOccurrence(m);
    const body = inviteText({
      host: m.host_name, title: m.title, when, tz: m.time_zone, url, passcode: o.passcode, weekly: m.repeat_rule === "weekly",
      dialIn: dialInEnabled() && m.dialin_pin ? `${config.dialinNumber}, PIN ${m.dialin_pin}` : null,
    });
    const withRsvp = m.kind === "instant" ? body : `${body}\n\nI'll attend: ${rsvp}?r=yes\nCan't make it: ${rsvp}?r=no`;
    const result = m.e2ee
      ? { note: "End-to-end encrypted: share the secure link yourself" }
      : await reach({
        meetingId: m.id, kind: "invite", email: inv.email, phone: inv.phone, sms: o.sms, whatsappText: withRsvp,
        mail: {
          subject: `Invitation: ${m.title}`, text: withRsvp,
          ics: m.kind === "scheduled" ? {
            method: "REQUEST",
            content: icsCalendar([{ uid: m.id, title: m.title, start: new Date(m.start_at), durationMin: m.duration_min, url, weekly: m.repeat_rule === "weekly", organizerEmail: m.host_email }], "REQUEST"),
          } : undefined,
        },
      });
    out.push({ id: inv.id, name: inv.name, email: inv.email, phone: inv.phone, result, whatsappLink: inv.phone ? waLink(inv.phone, withRsvp) : null });
  }
  return out;
}

/** Save invitees (each gets a random personal token from the database default). */
async function insertInvitees(meetingId: string, list: z.infer<typeof invitee>[]) {
  const rows = [];
  for (const i of list) {
    rows.push(await one("INSERT INTO invitees (meeting_id, name, email, phone) VALUES ($1,$2,$3,$4) RETURNING *",
      [meetingId, i.name || null, i.email || null, i.phone || null]));
  }
  return rows;
}

/* ---------- Meet now ---------- */
/** Meet now: an instant room, ready to share and join straight away. Gets a dial-in PIN too. */
meetingsRouter.post("/meetings/instant", ah(async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().max(120).optional(), ...settings }), req.body ?? {});
  const u = req.user!;
  const m = await one(
    `INSERT INTO meetings (org_id, host_id, slug, title, kind, start_at, duration_min, languages, passcode_hash, waiting_room, open_mic, anyone_can_share, verify_guests, e2ee, dialin_pin)
     VALUES ($1,$2,$3,$4,'instant', now(), 60, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [u.orgId, u.id, meetingSlug(), b.title || `${u.name.split(" ")[0]}'s call`, b.languages ?? ["en"],
      b.passcode ? hashPasscode(b.passcode) : null, b.waiting_room ?? false, b.open_mic ?? false,
      b.anyone_can_share ?? false, b.verify_guests ?? false, b.e2ee ?? false, await newDialinPin()]);
  await ensureDialinRule(m.id);
  res.status(201).json(dto({ ...m, host_name: u.name }));
}));

/* ---------- Schedule ---------- */
/** Schedule: a one-off or weekly meeting, with invites sent immediately and calendar sync if connected. */
meetingsRouter.post("/meetings", ah(async (req, res) => {
  const b = parse(z.object({
    title: z.string().trim().min(1).max(120),
    start_at: z.string().datetime({ offset: true }),
    duration_min: z.number().int().min(5).max(1440).default(60),
    time_zone: z.string().max(60).default("Africa/Lagos"),
    repeat_rule: z.enum(["none", "weekly"]).default("none"),
    invitees: z.array(invitee).max(500).default([]),
    send_sms: z.boolean().default(false),
    ...settings,
  }), req.body);
  /**   // Allow 5 minutes of slack for slow forms, but not meetings in the past. */
  if (new Date(b.start_at).getTime() < Date.now() - 5 * 60_000) throw new HttpError(400, "start_at: That time has already passed.");
  const u = req.user!;
  const m = await one(
    `INSERT INTO meetings (org_id, host_id, slug, title, kind, start_at, duration_min, time_zone, repeat_rule, languages, passcode_hash, waiting_room, open_mic, anyone_can_share, verify_guests, e2ee, dialin_pin)
     VALUES ($1,$2,$3,$4,'scheduled',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [u.orgId, u.id, meetingSlug(), b.title, b.start_at, b.duration_min, b.time_zone, b.repeat_rule, b.languages ?? ["en"],
      b.passcode ? hashPasscode(b.passcode) : null, b.waiting_room ?? false, b.open_mic ?? false, b.anyone_can_share ?? false,
      b.verify_guests ?? false, b.e2ee ?? false, await newDialinPin()]);
  const full = { ...m, host_name: u.name, host_email: u.email };
  const invites = await sendInvites(full, await insertInvitees(m.id, b.invitees), { passcode: b.passcode, sms: b.send_sms });
  await Promise.all([syncMeeting(m.id, "upsert", b.passcode), ensureDialinRule(m.id)]);
  res.status(201).json({ ...dto(full), invites });
}));

/**
 * List meetings. scope=upcoming (scheduled or live, soonest first) or scope=past (ended/cancelled or used).
 * Members see only their own; owners/admins see the whole workspace.
 */
meetingsRouter.get("/meetings", ah(async (req, res) => {
  const scope = req.query.scope === "past" ? "past" : "upcoming";
  const u = req.user!;
  const own = u.role === "member" ? "AND m.host_id = $2" : "";
  const rows = await q(
    `SELECT m.*, u.name AS host_name,
       (SELECT count(*) FROM invitees i WHERE i.meeting_id = m.id)::int AS invited,
       (SELECT count(*) FROM invitees i WHERE i.meeting_id = m.id AND rsvp = 'yes')::int AS confirmed,
       ARRAY(SELECT coalesce(i.name, i.email, i.phone, 'Guest') FROM invitees i WHERE i.meeting_id = m.id ORDER BY i.created_at LIMIT 3) AS people,
       (SELECT max(started_at) FROM sessions s WHERE s.meeting_id = m.id) AS last_session
     FROM meetings m JOIN users u ON u.id = m.host_id
     WHERE m.org_id = $1 ${own} AND ${scope === "upcoming" ? "m.status IN ('scheduled','live')" : "(m.status IN ('ended','cancelled') OR EXISTS (SELECT 1 FROM sessions s WHERE s.meeting_id = m.id AND s.ended_at IS NOT NULL))"}
     ORDER BY m.start_at ${scope === "upcoming" ? "ASC" : "DESC"} LIMIT 200`,
    u.role === "member" ? [u.orgId, u.id] : [u.orgId]);
  // `people`: the first three invitees' names, for the faces on the dashboard's meeting cards.
  const list = rows.map((m) => ({ ...dto(m), invited: m.invited, confirmed: m.confirmed, people: m.people, lastSession: m.last_session }));
  if (scope === "upcoming") list.sort((a, b) => +new Date(a.nextAt ?? a.startAt) - +new Date(b.nextAt ?? b.startAt));
  res.json(list);
}));

/**
 * History: every finished call (session) in the workspace, newest first, with who came, how long it ran,
 * the summary's status and recordings, plus cancelled meetings. Members see only their own meetings.
 */
meetingsRouter.get("/history", requireAuth, ah(async (req, res) => {
  const u = req.user!;
  const own = u.role === "member" ? "AND m.host_id = $2" : "";
  const args = u.role === "member" ? [u.orgId, u.id] : [u.orgId];
  const sessions = await q(
    `SELECT s.id, s.meeting_id, m.title, m.kind, m.repeat_rule, s.started_at, s.ended_at, s.end_reason, s.summary_status,
            (SELECT count(*) FROM participants p WHERE p.session_id = s.id)::int AS attendees,
            ARRAY(SELECT p.name FROM participants p WHERE p.session_id = s.id ORDER BY p.joined_at LIMIT 3) AS people,
            (SELECT count(*) FROM recordings r WHERE r.session_id = s.id)::int AS recordings
     FROM sessions s JOIN meetings m ON m.id = s.meeting_id
     WHERE m.org_id = $1 ${own} AND s.ended_at IS NOT NULL
     ORDER BY s.started_at DESC LIMIT 300`, args);
  const cancelled = await q(
    `SELECT m.id AS meeting_id, m.title, m.start_at, m.repeat_rule FROM meetings m
     WHERE m.org_id = $1 ${own} AND m.status = 'cancelled' ORDER BY m.start_at DESC LIMIT 100`, args);
  res.json({ sessions, cancelled });
}));

/** One meeting with invitees (RSVP), past sessions and the log of messages sent. */
meetingsRouter.get("/meetings/:id", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  const invitees = await q("SELECT id, name, email, phone, rsvp, token FROM invitees WHERE meeting_id = $1 ORDER BY created_at", [m.id]);
  const sessions = await q(
    `SELECT s.id, s.started_at, s.ends_at, s.ended_at, s.end_reason, s.summary_status,
            (SELECT count(*) FROM participants p WHERE p.session_id = s.id)::int AS attendees,
            (SELECT count(*) FROM recordings r WHERE r.session_id = s.id)::int AS recordings
     FROM sessions s WHERE s.meeting_id = $1 ORDER BY s.started_at DESC`, [m.id]);
  const notifications = await q(
    "SELECT channel, to_addr, kind, status, detail, created_at FROM notifications WHERE meeting_id = $1 ORDER BY id DESC LIMIT 100", [m.id]);
  const d = dto(m);
  res.json({
    ...d, sessions, notifications, whatsappApi: whatsappEnabled(),
    invitees: invitees.map((i) => {
      const url = joinUrl(config.appUrl, m.slug, i.token);
      return { ...i, url, whatsappLink: i.phone ? waLink(i.phone, `${m.title}\nJoin: ${url}`) : null };
    }),
  });
}));

/** Edit a meeting. If the time changes, invitees get one update (WhatsApp + email with a new .ics). */
meetingsRouter.patch("/meetings/:id", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  if (m.status === "cancelled" || m.status === "ended") throw new HttpError(400, "This meeting is over.");
  const b = parse(z.object({
    title: z.string().trim().min(1).max(120).optional(),
    start_at: z.string().datetime({ offset: true }).optional(),
    duration_min: z.number().int().min(5).max(1440).optional(),
    time_zone: z.string().max(60).optional(),
    repeat_rule: z.enum(["none", "weekly"]).optional(),
    ...settings,
  }), req.body);
  const timeChanged = b.start_at && new Date(b.start_at).getTime() !== new Date(m.start_at).getTime();
  const u = await one(
    `UPDATE meetings SET title = coalesce($2,title), start_at = coalesce($3,start_at), duration_min = coalesce($4,duration_min),
       time_zone = coalesce($5,time_zone), repeat_rule = coalesce($6,repeat_rule), languages = coalesce($7,languages),
       passcode_hash = CASE WHEN $8::boolean THEN $9 ELSE passcode_hash END,
       waiting_room = coalesce($10,waiting_room), open_mic = coalesce($11,open_mic), anyone_can_share = coalesce($12,anyone_can_share),
       verify_guests = coalesce($13,verify_guests), e2ee = coalesce($14,e2ee)
     WHERE id = $1 RETURNING *`,
    [m.id, b.title ?? null, b.start_at ?? null, b.duration_min ?? null, b.time_zone ?? null, b.repeat_rule ?? null, b.languages ?? null,
      b.passcode !== undefined, b.passcode ? hashPasscode(b.passcode) : null, b.waiting_room ?? null, b.open_mic ?? null,
      b.anyone_can_share ?? null, b.verify_guests ?? null, b.e2ee ?? null]);
  const full = { ...u, host_name: m.host_name, host_email: m.host_email };
  /**   // A new time means new reminders: clear the sent-reminder log so the scheduler sends them again. */
  if (timeChanged && u.kind === "scheduled") {
    // One update per person on both channels; old reminders are cleared so new ones go out.
    await q("DELETE FROM reminders_sent WHERE meeting_id = $1", [m.id]);
    const invitees = await q("SELECT * FROM invitees WHERE meeting_id = $1 AND rsvp <> 'no'", [m.id]);
    for (const i of invitees) {
      const url = joinUrl(config.appUrl, u.slug, i.token);
      const text = updateText({ title: u.title, when: nextOccurrence(u) ?? new Date(u.start_at), tz: u.time_zone, url });
      await reach({
        meetingId: m.id, kind: "update", email: i.email, phone: i.phone, whatsappText: text,
        mail: {
          subject: `Updated: ${u.title}`, text,
          ics: { method: "REQUEST", content: icsCalendar([{ uid: u.id, title: u.title, start: new Date(u.start_at), durationMin: u.duration_min, url, weekly: u.repeat_rule === "weekly", sequence: Math.floor(Date.now() / 1000) }], "REQUEST") },
        },
      });
    }
  }
  await syncMeeting(m.id, "upsert");
  res.json(dto(full));
}));

/** Cancel: everyone invited gets a short notice (and a calendar CANCEL), and the link stops working. */
meetingsRouter.post("/meetings/:id/cancel", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  if (m.status === "cancelled") return res.json({ ok: true });
  await q("UPDATE meetings SET status = 'cancelled' WHERE id = $1", [m.id]);
  const invitees = await q("SELECT * FROM invitees WHERE meeting_id = $1", [m.id]);
  for (const i of invitees) {
    await reach({
      meetingId: m.id, kind: "cancel", email: i.email, phone: i.phone, whatsappText: cancelText(m.title),
      mail: {
        subject: `Cancelled: ${m.title}`, text: cancelText(m.title),
        ics: m.kind === "scheduled" ? { method: "CANCEL", content: icsCalendar([{ uid: m.id, title: m.title, start: new Date(m.start_at), durationMin: m.duration_min, url: joinUrl(config.appUrl, m.slug), cancelled: true, sequence: Math.floor(Date.now() / 1000) }], "CANCEL") } : undefined,
      },
    });
  }
  await Promise.all([syncMeeting(m.id, "delete"), removeDialinRule(m.id)]);
  res.json({ ok: true });
}));

/** Invite more people to an existing meeting (invites are sent at once). */
meetingsRouter.post("/meetings/:id/invitees", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  const b = parse(z.object({ invitees: z.array(invitee).min(1).max(500), send_sms: z.boolean().default(false) }), req.body);
  res.status(201).json(await sendInvites(m, await insertInvitees(m.id, b.invitees), { sms: b.send_sms }));
}));

/** Send one person's invite again. */
meetingsRouter.post("/meetings/:id/invitees/:iid/resend", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  const inv = await one("SELECT * FROM invitees WHERE id = $1 AND meeting_id = $2", [req.params.iid, m.id]);
  if (!inv) throw new HttpError(404, "Invitee not found.");
  res.json((await sendInvites(m, [inv], {}))[0]);
}));

/** Remove someone from the invite list (no message is sent). */
meetingsRouter.delete("/meetings/:id/invitees/:iid", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  await q("DELETE FROM invitees WHERE id = $1 AND meeting_id = $2", [req.params.iid, m.id]);
  res.json({ ok: true });
}));

/** Download the meeting as an .ics calendar file. */
meetingsRouter.get("/meetings/:id/ics", ah(async (req, res) => {
  const m = await loadMeeting(req.user!, req.params.id);
  res.type("text/calendar").attachment(`${m.slug}.ics`).send(icsCalendar([{
    uid: m.id, title: m.title, start: new Date(m.start_at), durationMin: m.duration_min, url: joinUrl(config.appUrl, m.slug), weekly: m.repeat_rule === "weekly",
  }]));
}));

/* ---------- History: one session = one time the room was used ---------- */
/** Load one session of a meeting the user may see (404 otherwise). */
async function loadSession(user: AuthUser, meetingId: string, sessionId: string) {
  const m = await loadMeeting(user, meetingId);
  const s = await one("SELECT * FROM sessions WHERE id = $1 AND meeting_id = $2", [sessionId, m.id]);
  if (!s) throw new HttpError(404, "Session not found.");
  return { m, s };
}

/** Everything about one past (or live) session: attendance, transcript, chat, poll results, recordings, summary. */
meetingsRouter.get("/meetings/:id/sessions/:sid", ah(async (req, res) => {
  const { m, s } = await loadSession(req.user!, req.params.id, req.params.sid);
  const [participants, transcript, chat, polls, recordings] = await Promise.all([
    q(`SELECT name, email, phone, language, role, via, verified, consent_summary, joined_at, left_at,
              extract(epoch FROM (coalesce(left_at, now()) - joined_at))::int AS seconds
       FROM participants WHERE session_id = $1 ORDER BY joined_at`, [s.id]),
    q("SELECT speaker_name, lang, text, english, created_at FROM transcript_lines WHERE session_id = $1 ORDER BY id", [s.id]),
    q("SELECT sender_name, text, created_at FROM chat_messages WHERE session_id = $1 ORDER BY id", [s.id]),
    q(`SELECT p.id, p.question, p.options, p.closed,
         coalesce((SELECT json_agg(json_build_object('option', option_idx, 'votes', n)) FROM
           (SELECT option_idx, count(*)::int AS n FROM poll_votes v WHERE v.poll_id = p.id GROUP BY option_idx) x), '[]') AS results
       FROM polls p WHERE session_id = $1 ORDER BY created_at`, [s.id]),
    q("SELECT id, size_bytes, mime, created_at FROM recordings WHERE session_id = $1 ORDER BY created_at", [s.id]),
  ]);
  res.json({ meeting: { id: m.id, title: m.title, slug: m.slug }, session: s, participants, transcript, chat, polls, recordings });
}));

/**
 * Quote a CSV cell when needed. Cells starting with = + - @ are prefixed with ' so spreadsheet apps
 * do not run them as formulas (CSV injection protection).
 */
const csvCell = (v: unknown) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
};

/** Attendance list as CSV: who joined, how (web/phone), when they joined and left, minutes attended. */
meetingsRouter.get("/meetings/:id/sessions/:sid/attendance.csv", ah(async (req, res) => {
  const { m, s } = await loadSession(req.user!, req.params.id, req.params.sid);
  const rows = await q(
    `SELECT name, email, phone, language, role, via, joined_at, left_at,
            round(extract(epoch FROM (coalesce(left_at, now()) - joined_at)) / 60)::int AS minutes
     FROM participants WHERE session_id = $1 ORDER BY joined_at`, [s.id]);
  const head = ["name", "email", "phone", "language", "role", "joined_via", "joined_at", "left_at", "minutes"];
  const body = rows.map((r) => [r.name, r.email, r.phone, r.language, r.role, r.via, r.joined_at, r.left_at, r.minutes].map(csvCell).join(","));
  res.type("text/csv").attachment(`attendance-${m.slug}-${new Date(s.started_at).toISOString().slice(0, 10)}.csv`)
    .send([head.join(","), ...body].join("\n") + "\n");
}));

/** Run the summary again (e.g. after the AI service was down). Runs in the background. */
meetingsRouter.post("/meetings/:id/sessions/:sid/summary/retry", ah(async (req, res) => {
  const { s } = await loadSession(req.user!, req.params.id, req.params.sid);
  if (!s.ended_at) throw new HttpError(400, "The meeting is still running.");
  runSummary(s.id).catch(() => {});
  res.json({ ok: true });
}));

// Exported for unit tests.
export { csvCell };
