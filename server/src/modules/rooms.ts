/**
 * Live rooms: the "signal" service.
 *
 * Holds the in-call state of each running meeting in memory (who is here, raised hands, who may speak or
 * share, polls, breakouts, the 2-hour clock) and talks to browsers over Socket.IO. Media itself flows through
 * LiveKit; this module only decides permissions and tells LiveKit (server side) what each person may publish.
 *
 * Rules (see the design doc, "In-call rules"):
 *  - Guests may turn their camera on freely; their microphone is locked until a raised hand is approved
 *    (or the host turns on Open mic / Allow all).
 *  - Hosts and co-hosts share any time; guests ask, and the host approves. One person shares at a time.
 *  - Free meetings end after 2 hours, with warnings 15 and 5 minutes before.
 */
import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { TrackSource } from "livekit-server-sdk";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";
import { signTicket, verifyTicket, verifyWait, type RoomTicket } from "../lib/auth.js";
import { HttpError, rateLimit } from "../lib/http.js";
import { isLanguage } from "../lib/languages.js";
import { closeRoom, kick, mediaToken, muteTrack, setPerms, type Perms } from "../lib/livekit.js";
import { effectivePlan, meetingLimitMinutes, PLANS, type Plan } from "../lib/plans.js";
import { requestReviewsForSession } from "./reviews.js";
import { runSummary } from "./summary.js";

/** The only reactions allowed (anything else is refused, so nobody can spam arbitrary text as "emoji"). */
export const REACTIONS = ["👍", "👏", "❤️", "😂", "🎉", "🙏", "😮"] as const;

/** Roles inside a call. Co-hosts have host powers except ending the meeting. */
type Role = "host" | "cohost" | "guest";
/**
 * Someone in the call. `sockets` = their open browser connections; `lkRoom` = the LiveKit room they are in
 * (main room, or a breakout). micAllowed/shareAllowed record host approvals for guests.
 * `boost` is the host's volume boost for this person (1 = normal, up to MAX_BOOST), applied by every listener.
 */
interface Person {
  identity: string; name: string; role: Role; lang: string; userId?: string; email?: string | null; phone?: string | null;
  via: "web" | "phone"; sockets: Set<string>; hand: boolean; handAt?: number; micAllowed: boolean; shareAllowed: boolean;
  lkRoom: string; joinedAt: number; leaveTimer?: NodeJS.Timeout; boost: number;
}
/** Highest volume boost a host can give one person (3 = 300%). */
const MAX_BOOST = 3;
/** A guest waiting in the waiting room for the host to admit them. */
interface LobbyEntry {
  waitId: string; name: string; email?: string | null; phone?: string | null; lang: string; consent: boolean;
  verified: boolean; at: number;
}
/** A live poll; votes map person → chosen option (one vote each, changeable until closed). */
interface Poll { id: string; question: string; options: string[]; votes: Map<string, number>; closed: boolean }
/** Open breakout rooms; each has a LiveKit room id like "<slug>~1". */
interface Breakouts { rooms: { id: string; label: string; members: string[] }[]; endsAt: number | null; timer?: NodeJS.Timeout }

/**
 * Everything the server knows about one running meeting. Lives in memory while the meeting runs;
 * lasting records (participants, chat, polls, captions) are also written to Postgres.
 */
export interface Room {
  slug: string; meetingId: string; orgId: string; hostUserId: string; title: string; kind: string; repeat: string;
  sessionId: string; endsAt: number; plan: Plan; maxParticipants: number;
  people: Map<string, Person>; sharer: string | null; shareRequests: string[];
  locked: boolean; openMic: boolean; anyoneCanShare: boolean; waitingRoom: boolean; e2ee: boolean;
  lobby: Map<string, LobbyEntry>; banned: Set<string>; polls: Map<string, Poll>; breakouts: Breakouts | null;
  recording: { by: string; name: string; at: number } | null;
  timers: NodeJS.Timeout[]; emptyTimer?: NodeJS.Timeout; ended: boolean; broadcastTimer?: NodeJS.Timeout;
}

// Running meetings by link code. `starting` stops two people creating the same room at the same moment.
const rooms = new Map<string, Room>();
const starting = new Map<string, Promise<Room>>();
// The Socket.IO server (set by attachSignal).
let io: Server | null = null;

/* ---------------------------------------------------------------------------------------------- */
/* Room lifecycle                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/** Get the live room for a meeting, starting a session (and the plan clock) if none is running. */
export async function getOrStartRoom(meeting: any): Promise<Room> {
  const existing = rooms.get(meeting.slug);
  if (existing && !existing.ended) return existing;
  if (starting.has(meeting.slug)) return starting.get(meeting.slug)!;
  const p = (async () => {
    const org = await one("SELECT plan, paid_until FROM organizations WHERE id = $1", [meeting.org_id]);
    const plan = effectivePlan(org);
    /**     // Reuse a session that never ended (e.g. after a server restart) or start a new one with the plan's end time. */
    let s = await one("SELECT * FROM sessions WHERE meeting_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", [meeting.id]);
    if (!s) {
      s = await one("INSERT INTO sessions (meeting_id, ends_at) VALUES ($1, now() + $2::interval) RETURNING *",
        [meeting.id, `${meetingLimitMinutes(plan)} minutes`]);
    }
    await q("UPDATE meetings SET status = 'live' WHERE id = $1", [meeting.id]);
    const room: Room = {
      slug: meeting.slug, meetingId: meeting.id, orgId: meeting.org_id, hostUserId: meeting.host_id, title: meeting.title,
      kind: meeting.kind, repeat: meeting.repeat_rule, sessionId: s.id, endsAt: new Date(s.ends_at).getTime(), plan,
      maxParticipants: PLANS[plan].maxParticipants, people: new Map(), sharer: null, shareRequests: [],
      locked: false, openMic: meeting.open_mic, anyoneCanShare: meeting.anyone_can_share, waitingRoom: meeting.waiting_room,
      e2ee: meeting.e2ee, lobby: new Map(), banned: new Set(), polls: new Map(), breakouts: null, recording: null,
      timers: [], ended: false,
    };
    scheduleClock(room);
    rooms.set(room.slug, room);
    log.info({ slug: room.slug, plan, endsAt: new Date(room.endsAt).toISOString() }, "room started");
    return room;
  })();
  starting.set(meeting.slug, p);
  try { return await p; } finally { starting.delete(meeting.slug); }
}

/** Warnings 15 and 5 minutes before the plan limit, then end the meeting for everyone. */
function scheduleClock(room: Room) {
  const now = Date.now();
  for (const m of config.warnBeforeMinutes) {
    const at = room.endsAt - m * 60_000;
    if (at > now) room.timers.push(setTimeout(() => {
      emitAll(room, "time.warning", { minutesLeft: m, endsAt: room.endsAt, plan: room.plan });
    }, at - now));
  }
  room.timers.push(setTimeout(() => endMeeting(room, "time_limit"), Math.max(0, room.endsAt - now)));
}

/** The running room for a link code, if any. */
export function getRoom(slug: string) { return rooms.get(slug); }

/** Small live summary for dashboards: people in the call, people waiting, end time. Null if not running. */
export function liveRoomInfo(slug: string) {
  const r = rooms.get(slug);
  if (!r || r.ended) return null;
  return { people: r.people.size, waiting: r.lobby.size, endsAt: r.endsAt, sessionId: r.sessionId };
}

/**
 * End the meeting for everyone (host pressed End, the plan limit was reached, or the room stayed empty).
 * Tells every browser, closes all LiveKit rooms (main + breakouts), records end times, and starts the summary.
 */
export async function endMeeting(room: Room, reason: "host_ended" | "time_limit" | "empty") {
  if (room.ended) return;
  room.ended = true;
  room.timers.forEach(clearTimeout);
  clearTimeout(room.emptyTimer);
  clearTimeout(room.breakouts?.timer);
  emitAll(room, "meeting.ended", { reason });
  for (const e of room.lobby.values()) io?.to(waitRoom(room.slug, e.waitId)).emit("lobby.denied", { reason: "ended" });
  rooms.delete(room.slug);
  const lk = new Set([room.slug, ...(room.breakouts?.rooms.map((b) => b.id) ?? [])]);
  await Promise.all([...lk].map(closeRoom));
  await q("UPDATE sessions SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL", [room.sessionId, reason]);
  await q("UPDATE participants SET left_at = now() WHERE session_id = $1 AND left_at IS NULL", [room.sessionId]);
  // One-off meetings are over; weekly series go back to "scheduled" for next week.
  /**   // One-off and instant meetings become "ended" (their link stops working); weekly series wait for next week. */
  await q(`UPDATE meetings SET status = CASE WHEN repeat_rule = 'weekly' AND kind = 'scheduled' AND status <> 'cancelled' THEN 'scheduled'
           WHEN status = 'cancelled' THEN 'cancelled' ELSE 'ended' END WHERE id = $1`, [room.meetingId]);
  log.info({ slug: room.slug, reason }, "meeting ended");
  if (!room.e2ee) runSummary(room.sessionId).catch((e) => log.error({ err: e?.message }, "summary failed"));
  // Everyone in their first meeting is now "asked" for a review; skippers get the link later (reviews.ts).
  requestReviewsForSession(room.sessionId).catch((e) => log.error({ err: e?.message }, "review requests failed"));
  setTimeout(() => io?.in(mainRoom(room.slug)).disconnectSockets(true), 1500);
}

/* ---------------------------------------------------------------------------------------------- */
/* Joining                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Who is being admitted (from the join routes, the waiting room, or a phone call). */
export interface JoinInfo {
  name: string; role: Role; lang: string; userId?: string; email?: string | null; phone?: string | null;
  consent: boolean; verified: boolean; identity?: string; via?: "web" | "phone";
}

/**
 * The core in-call rule: hosts/co-hosts may always speak and share. Guests may speak only with Open mic on or
 * after the host allowed their raised hand, and share only with "Anyone can present" on or after approval.
 */
const permsOf = (room: Room, p: Pick<Person, "role" | "micAllowed" | "shareAllowed">): Perms => ({
  mic: p.role !== "guest" || room.openMic || p.micAllowed,
  share: p.role !== "guest" || room.anyoneCanShare || p.shareAllowed,
});

// Identifies a guest by email/phone, so someone removed cannot simply rejoin with the same contact.
const contactKey = (j: { email?: string | null; phone?: string | null }) =>
  [j.email?.toLowerCase(), j.phone?.replace(/\D/g, "")].filter(Boolean).join("|");

/** Admit someone into the call: participant row, LiveKit token, room ticket. */
/**
 * Admit someone into the call: checks bans and the plan's participant cap, records attendance, and returns
 * what the browser needs: a LiveKit token (with their allowed sources), a room ticket and the end time.
 */
export async function admit(room: Room, j: JoinInfo) {
  if (room.ended) throw new HttpError(410, "This meeting has ended.");
  if (j.role === "guest" && room.banned.has(contactKey(j))) throw new HttpError(403, "The host removed you from this meeting.");
  // A host rejoining from a new tab keeps the same identity (so they don't appear twice).
  const identity = j.identity ?? (j.userId ? `u-${j.userId.slice(0, 8)}-${crypto.randomBytes(2).toString("hex")}` : `g-${crypto.randomBytes(5).toString("hex")}`);
  if (!room.people.has(identity) && room.people.size >= room.maxParticipants) {
    throw new HttpError(403, `This meeting is full (${room.maxParticipants} people on the ${PLANS[room.plan].name} plan).`);
  }
  const existing = room.people.get(identity);
  const person: Person = existing ?? {
    identity, name: j.name, role: j.role, lang: j.lang, userId: j.userId, email: j.email, phone: j.phone, via: j.via ?? "web",
    sockets: new Set(), hand: false, micAllowed: false, shareAllowed: false, lkRoom: room.slug, joinedAt: Date.now(), boost: 1,
  };
  room.people.set(identity, person);
  clearTimeout(room.emptyTimer);
  await q(
    `INSERT INTO participants (session_id, identity, user_id, name, email, phone, language, role, consent_summary, verified, via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (session_id, identity) DO UPDATE SET left_at = NULL`,
    [room.sessionId, identity, j.userId ?? null, j.name, j.email ?? null, j.phone ?? null, j.lang, j.role, j.consent, j.verified, j.via ?? "web"]);
  /**   // The ticket proves who they are on the socket and for caption/recording uploads. */
  const ticket: RoomTicket = {
    meetingId: room.meetingId, slug: room.slug, sessionId: room.sessionId, identity, name: j.name, role: j.role, lang: j.lang, userId: j.userId,
  };
  // Leave a person in the room for a moment even if their socket never connects (e.g. a failed tab).
  scheduleLeaveCheck(room, person, 60_000);
  broadcast(room);
  return {
    status: "joined" as const,
    identity, role: j.role, meetingId: room.meetingId, title: room.title,
    livekitUrl: config.livekit.url,
    livekitRoom: person.lkRoom,
    livekitToken: await mediaToken({ room: person.lkRoom, identity, name: j.name, perms: permsOf(room, person), metadata: JSON.stringify({ role: j.role, lang: j.lang }) }),
    ticket: signTicket(ticket),
    endsAt: room.endsAt, plan: room.plan, e2ee: room.e2ee,
  };
}

/** Waiting room: park a guest until a host admits them. */
/** Waiting room: park a guest and alert hosts. Returns the wait id the guest listens on. */
export function enqueueLobby(room: Room, e: Omit<LobbyEntry, "waitId" | "at">): string {
  const waitId = crypto.randomBytes(6).toString("hex");
  room.lobby.set(waitId, { ...e, waitId, at: Date.now() });
  emitHosts(room, "lobby.request", { waitId, name: e.name });
  broadcast(room);
  return waitId;
}

/* ---------------------------------------------------------------------------------------------- */
/* Broadcasting                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

// Socket.IO room names: everyone in a meeting, hosts only, one person (all their tabs), one waiting guest.
const mainRoom = (slug: string) => `m:${slug}`;
const hostRoom = (slug: string) => `h:${slug}`;
const personRoom = (slug: string, identity: string) => `p:${slug}:${identity}`;
const waitRoom = (slug: string, waitId: string) => `w:${slug}:${waitId}`;

// Send an event to everyone / hosts only / one person.
const emitAll = (room: Room, ev: string, data: unknown) => io?.to(mainRoom(room.slug)).emit(ev, data);
const emitHosts = (room: Room, ev: string, data: unknown) => io?.to(hostRoom(room.slug)).emit(ev, data);
const emitTo = (room: Room, identity: string, ev: string, data: unknown) => io?.to(personRoom(room.slug, identity)).emit(ev, data);

/**
 * The room state sent to browsers: people with their permissions, hands queue (oldest first), share requests,
 * presenter, polls with counts, breakouts. The waiting-room list (names, contacts) goes to hosts only.
 */
export function snapshot(room: Room, forHosts: boolean) {
  const people = [...room.people.values()].map((p) => {
    const perms = permsOf(room, p);
    return {
      identity: p.identity, name: p.name, role: p.role, lang: p.lang, hand: p.hand, handAt: p.handAt ?? null,
      canSpeak: perms.mic, canShare: perms.share, via: p.via, room: p.lkRoom, online: p.sockets.size > 0 || p.via === "phone",
      boost: p.boost,
    };
  });
  return {
    slug: room.slug, title: room.title, sessionId: room.sessionId, endsAt: room.endsAt, plan: room.plan,
    locked: room.locked, openMic: room.openMic, anyoneCanShare: room.anyoneCanShare, waitingRoom: room.waitingRoom, e2ee: room.e2ee,
    sharer: room.sharer, shareRequests: room.shareRequests, recording: room.recording,
    hands: [...room.people.values()].filter((p) => p.hand).sort((a, b) => (a.handAt ?? 0) - (b.handAt ?? 0)).map((p) => p.identity),
    people,
    polls: [...room.polls.values()].map((p) => ({
      id: p.id, question: p.question, options: p.options, closed: p.closed,
      counts: p.options.map((_, i) => [...p.votes.values()].filter((v) => v === i).length),
    })),
    breakouts: room.breakouts ? { endsAt: room.breakouts.endsAt, rooms: room.breakouts.rooms.map(({ id, label, members }) => ({ id, label, members })) } : null,
    lobby: forHosts ? [...room.lobby.values()].map(({ waitId, name, email, phone, verified, at }) => ({ waitId, name, contact: email || phone, verified, at })) : [],
  };
}

/** Coalesce many changes into one state message (less data on slow networks). */
// Send the new state to everyone, at most once per 40 ms (many quick changes become one message).
function broadcast(room: Room) {
  if (room.broadcastTimer || !io) return;
  room.broadcastTimer = setTimeout(() => {
    room.broadcastTimer = undefined;
    if (room.ended) return;
    /**     // Guests get the state without the lobby; hosts get the full one. */
    io!.to(mainRoom(room.slug)).except(hostRoom(room.slug)).emit("state", snapshot(room, false));
    io!.to(hostRoom(room.slug)).emit("state", snapshot(room, true));
  }, 40);
}

/** Push a person's current permissions to LiveKit (their current media room). */
const applyPerms = (room: Room, p: Person) => setPerms(p.lkRoom, p.identity, permsOf(room, p));

/* ---------------------------------------------------------------------------------------------- */
/* Leaving                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

// Count someone as gone only if none of their tabs reconnects within `ms` (phone callers are tracked by LiveKit).
function scheduleLeaveCheck(room: Room, p: Person, ms: number) {
  clearTimeout(p.leaveTimer);
  p.leaveTimer = setTimeout(() => {
    if (p.sockets.size > 0 || p.via === "phone" || room.ended) return;
    markLeft(room, p).catch(() => {});
  }, ms);
}

/**
 * Someone left: drop them from the room, clear their share/recording, record left_at.
 * If nobody is left, end the meeting after the grace period (unless someone comes back).
 */
async function markLeft(room: Room, p: Person) {
  room.people.delete(p.identity);
  room.shareRequests = room.shareRequests.filter((i) => i !== p.identity);
  if (room.sharer === p.identity) room.sharer = null;
  if (room.recording?.by === p.identity) room.recording = null;
  await q("UPDATE participants SET left_at = now() WHERE session_id = $1 AND identity = $2", [room.sessionId, p.identity]);
  broadcast(room);
  if (room.people.size === 0) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = setTimeout(() => { if (room.people.size === 0) endMeeting(room, "empty"); }, config.emptyRoomGraceSeconds * 1000);
  }
}

/** Phone (SIP) callers arrive through LiveKit webhooks rather than a browser. */
export async function phoneJoined(slug: string, identity: string, name: string) {
  const m = await one("SELECT * FROM meetings WHERE slug = $1", [slug]);
  if (!m) return;
  const room = await getOrStartRoom(m);
  await admit(room, { name: name || "Phone caller", role: "guest", lang: "en", consent: false, verified: false, identity, via: "phone" });
}
/** A phone caller hung up (LiveKit webhook). */
export async function phoneLeft(slug: string, identity: string) {
  const room = rooms.get(slug);
  const p = room?.people.get(identity);
  if (room && p) await markLeft(room, p);
}

/* ---------------------------------------------------------------------------------------------- */
/* Socket.IO                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Start the Socket.IO server on the HTTP server. Each connection is either a waiting-room guest (auth.wait)
 * or someone in the call (auth.ticket); anything else is refused.
 */
export function attachSignal(server: HttpServer) {
  io = new Server(server, { path: "/socket.io", cors: { origin: true }, pingInterval: 10_000, pingTimeout: 20_000 });
  io.on("connection", (socket) => {
    const auth = socket.handshake.auth ?? {};
    try {
      if (auth.wait) return onWaitSocket(socket, verifyWait(String(auth.wait)));
      return onRoomSocket(socket, verifyTicket(String(auth.ticket ?? "")));
    } catch {
      socket.emit("fatal", { error: "Not allowed in this meeting." });
      socket.disconnect(true);
    }
  });
  return io;
}

/** A waiting guest's connection: it only receives "lobby.admitted" (with join details) or "lobby.denied". */
function onWaitSocket(socket: Socket, w: { slug: string; waitId: string }) {
  const room = rooms.get(w.slug);
  if (!room || !room.lobby.has(w.waitId)) {
    socket.emit("lobby.denied", { reason: "gone" });
    return socket.disconnect(true);
  }
  socket.join(waitRoom(w.slug, w.waitId));
  socket.on("disconnect", () => {
    // Give them a minute to reconnect (network switch) before dropping them from the queue.
    setTimeout(async () => {
      const sockets = await io!.in(waitRoom(w.slug, w.waitId)).fetchSockets();
      if (!sockets.length && room.lobby.delete(w.waitId)) broadcast(room);
    }, 60_000);
  });
}

/**
 * A connection from someone in the call. Registers every in-call action (hands, mic, sharing, reactions, chat,
 * polls, moderation, breakouts, recording banner). Host-only actions are refused for guests.
 */
function onRoomSocket(socket: Socket, t: RoomTicket) {
  const room = rooms.get(t.slug);
  const me = room?.people.get(t.identity);
  /**   // Tickets from an earlier session of the same meeting are not valid any more. */
  if (!room || room.ended || room.sessionId !== t.sessionId || !me) {
    socket.emit("meeting.ended", { reason: "gone" });
    return socket.disconnect(true);
  }
  me.sockets.add(socket.id);
  clearTimeout(me.leaveTimer);
  socket.join([mainRoom(room.slug), personRoom(room.slug, me.identity)]);
  /**   // Hosts and co-hosts also receive host-only events (requests, lobby). */
  if (me.role !== "guest") socket.join(hostRoom(room.slug));
  socket.emit("state", snapshot(room, me.role !== "guest"));
  socket.emit("hello", { identity: me.identity, role: me.role, reactions: REACTIONS });
  broadcast(room);

  const isHost = () => me.role === "host" || me.role === "cohost";
  /** Register a handler; host-only ones are refused for guests; errors go back to the sender only. */
  const on = (ev: string, fn: (d: any) => unknown | Promise<unknown>, hostOnly = false) =>
    socket.on(ev, async (d: any, ack?: (r: unknown) => void) => {
      try {
        if (room.ended) return;
        if (hostOnly && !isHost()) throw new Error("Only the host can do that.");
        // Basic flood protection: 40 actions per 10 seconds per connection.
        if (!rateLimit(`sock:${socket.id}`, 40, 10_000)) throw new Error("Slow down a little.");
        const r = await fn(d ?? {});
        broadcast(room);
        ack?.({ ok: true, ...(typeof r === "object" && r ? r : {}) });
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message ?? "failed" });
        socket.emit("notice", { kind: "error", text: e?.message ?? "Something went wrong" });
      }
    });
  /**   // Find the person an action targets, or fail with "That person has left." */
  const target = (identity: unknown) => {
    const p = room.people.get(String(identity));
    if (!p) throw new Error("That person has left.");
    return p;
  };

  /* --- Speaking: raise hand to talk --- */
  /**   // Guest raises a hand; hosts get a pop-up. Raising twice keeps the original place in the queue. */
  on("hand.raise", () => { if (!me.hand) { me.hand = true; me.handAt = Date.now(); emitHosts(room, "hand.raised", { identity: me.identity, name: me.name }); } });
  on("hand.lower", () => { me.hand = false; });
  /**   // Host lets a guest speak: unlock their mic in LiveKit. Their browser then turns the mic on. */
  on("hand.allow", async (d) => {
    const p = target(d.identity);
    p.hand = false; p.micAllowed = true;
    await applyPerms(room, p);
    emitTo(room, p.identity, "notice", { kind: "mic", text: "The host let you speak. Your mic is unlocked." });
  }, true);
  /**   // Host lowers a hand without letting them speak. */
  on("hand.deny", (d) => { const p = target(d.identity); p.hand = false; emitTo(room, p.identity, "notice", { kind: "info", text: "The host lowered your hand." }); }, true);
  /**   // Host locks a guest's mic again (LiveKit removes the track), or mutes a co-host. */
  on("mic.revoke", async (d) => {
    const p = target(d.identity);
    if (p.role !== "guest") { await muteTrack(p.lkRoom, p.identity, TrackSource.MICROPHONE); return; }
    p.micAllowed = false;
    await applyPerms(room, p);
    emitTo(room, p.identity, "notice", { kind: "mic", text: "The host locked your mic." });
  }, true);
  /**   // Host boosts how loud one person sounds to everyone (quiet voice, weak mic): 1 = normal, up to 300%. */
  on("volume.boost", (d) => {
    const p = target(d.identity);
    const level = Number(d.level);
    if (!Number.isFinite(level)) throw new Error("Pick a volume level.");
    p.boost = Math.round(Math.min(MAX_BOOST, Math.max(1, level)) * 10) / 10;
  }, true);
  /**   // Unlock every guest's mic at once. */
  on("mic.allowAll", async () => {
    for (const p of room.people.values()) if (p.role === "guest") { p.micAllowed = true; p.hand = false; await applyPerms(room, p); }
    emitAll(room, "notice", { kind: "mic", text: "The host unlocked everyone's mic." });
  }, true);
  /**   // Mute everyone except the host doing it (guests get their mic locked again). */
  on("mic.muteAll", async () => {
    for (const p of room.people.values()) {
      if (p.identity === me.identity) continue;
      if (p.role === "guest") { p.micAllowed = false; await applyPerms(room, p); } else await muteTrack(p.lkRoom, p.identity, TrackSource.MICROPHONE);
    }
    emitAll(room, "notice", { kind: "mic", text: "The host muted everyone." });
  }, true);
  /**   // Open mic: guests can talk without raising a hand (applies to everyone immediately). */
  on("settings.openMic", async (d) => {
    room.openMic = Boolean(d.on);
    for (const p of room.people.values()) if (p.role === "guest") await applyPerms(room, p);
  }, true);
  /**   // Anyone can present: guests can share without asking. */
  on("settings.anyoneCanShare", async (d) => {
    room.anyoneCanShare = Boolean(d.on);
    for (const p of room.people.values()) if (p.role === "guest" && p.identity !== room.sharer) await applyPerms(room, p);
  }, true);

  /* --- Screen sharing and presenting --- */
  /**   // A guest asks to present. If already allowed, the browser starts sharing straight away. */
  on("share.request", () => {
    if (permsOf(room, me).share) return { allowed: true };
    if (!room.shareRequests.includes(me.identity)) room.shareRequests.push(me.identity);
    emitHosts(room, "share.requested", { identity: me.identity, name: me.name });
  });
  /**   // Host approves: the guest may publish a screen share; their browser shows "Present now". */
  on("share.allow", async (d) => {
    const p = target(d.identity);
    room.shareRequests = room.shareRequests.filter((i) => i !== p.identity);
    p.shareAllowed = true;
    await applyPerms(room, p);
    emitTo(room, p.identity, "share.allowed", {});
  }, true);
  /**   // Host declines a share request. */
  on("share.deny", (d) => {
    room.shareRequests = room.shareRequests.filter((i) => i !== String(d.identity));
    emitTo(room, String(d.identity), "notice", { kind: "info", text: "The host declined your share request." });
  }, true);
  // The client reports when its share track goes live/stops; one sharer at a time.
  on("share.started", async () => {
    if (!permsOf(room, me).share) throw new Error("You need the host's approval to share.");
    /**
     *     // A new presenter replaces the current one: the old presenter's browser is told to stop, and a guest's
     *     // approval is withdrawn (they must ask again).
     */
    const prev = room.sharer && room.sharer !== me.identity ? room.people.get(room.sharer) : null;
    room.sharer = me.identity;
    if (prev) {
      emitTo(room, prev.identity, "share.stop", { reason: `${me.name} is presenting now.` });
      if (prev.role === "guest" && !room.anyoneCanShare) { prev.shareAllowed = false; await applyPerms(room, prev); }
    }
    emitAll(room, "share.presenting", { identity: me.identity, name: me.name });
  });
  /**   // Share stopped. A guest's approval is used up: next time they must ask again. */
  on("share.ended", async () => {
    if (room.sharer === me.identity) room.sharer = null;
    if (me.role === "guest" && !room.anyoneCanShare && me.shareAllowed) { me.shareAllowed = false; await applyPerms(room, me); }
  });
  /**   // Host stops someone else's share. */
  on("share.stop", async (d) => {
    const p = target(d.identity ?? room.sharer);
    emitTo(room, p.identity, "share.stop", { reason: "The host stopped your share." });
    if (p.role === "guest") { p.shareAllowed = false; await applyPerms(room, p); }
    if (room.sharer === p.identity) room.sharer = null;
  }, true);

  /* --- Reactions, chat, captions language --- */
  /**   // Reactions: one of the 7 allowed emojis, at most 6 per 3 seconds per person. Not stored. */
  on("reaction", (d) => {
    if (!REACTIONS.includes(d.emoji)) throw new Error("Unknown reaction");
    if (!rateLimit(`react:${me.identity}`, 6, 3000)) return;
    emitAll(room, "reaction", { identity: me.identity, name: me.name, emoji: d.emoji, at: Date.now() });
  });
  /**   // Chat: saved (it feeds the summary) and sent to everyone. */
  on("chat.send", async (d) => {
    const text = String(d.text ?? "").trim().slice(0, 1000);
    if (!text) return;
    const row = await one("INSERT INTO chat_messages (session_id, sender_identity, sender_name, text) VALUES ($1,$2,$3,$4) RETURNING id, created_at",
      [room.sessionId, me.identity, me.name, text]);
    emitAll(room, "chat", { id: row.id, identity: me.identity, name: me.name, text, at: row.created_at });
  });
  /**   // Change my caption language; captions are then also translated into it. */
  on("lang.set", async (d) => {
    if (!isLanguage(d.lang)) throw new Error("Unknown language");
    me.lang = d.lang;
    await q("UPDATE participants SET language = $3 WHERE session_id = $1 AND identity = $2", [room.sessionId, me.identity, d.lang]);
  });

  /* --- Polls --- */
  /**   // Host starts a poll: a question and 2-6 options. */
  on("poll.create", async (d) => {
    const question = String(d.question ?? "").trim().slice(0, 200);
    const options = (Array.isArray(d.options) ? d.options : []).map((o: unknown) => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    if (!question || options.length < 2) throw new Error("A poll needs a question and at least 2 options.");
    const row = await one("INSERT INTO polls (session_id, question, options) VALUES ($1,$2,$3) RETURNING id", [room.sessionId, question, JSON.stringify(options)]);
    room.polls.set(row.id, { id: row.id, question, options, votes: new Map(), closed: false });
    emitAll(room, "poll.opened", { id: row.id, question });
  }, true);
  /**   // Vote (or change vote) while the poll is open. */
  on("poll.vote", async (d) => {
    const p = room.polls.get(String(d.pollId));
    const idx = Number(d.option);
    if (!p || p.closed || !Number.isInteger(idx) || idx < 0 || idx >= p.options.length) throw new Error("This poll is closed.");
    p.votes.set(me.identity, idx);
    await q(`INSERT INTO poll_votes (poll_id, identity, option_idx) VALUES ($1,$2,$3)
             ON CONFLICT (poll_id, identity) DO UPDATE SET option_idx = EXCLUDED.option_idx`, [p.id, me.identity, idx]);
  });
  /**   // Host closes a poll; results stay visible. */
  on("poll.close", async (d) => {
    const p = room.polls.get(String(d.pollId));
    if (!p) throw new Error("Poll not found");
    p.closed = true;
    await q("UPDATE polls SET closed = true WHERE id = $1", [p.id]);
  }, true);

  /* --- Moderation --- */
  /**   // Remove someone: they are disconnected and their email/phone is banned from this meeting. */
  on("mod.remove", async (d) => {
    const p = target(d.identity);
    if (p.role === "host") throw new Error("The host can't be removed.");
    const key = contactKey(p);
    if (key) room.banned.add(key);
    emitTo(room, p.identity, "removed", {});
    await kick(p.lkRoom, p.identity);
    await markLeft(room, p);
    io!.in(personRoom(room.slug, p.identity)).disconnectSockets(true);
  }, true);
  /**   // Lock: nobody new can join (people already in stay). */
  on("mod.lock", (d) => { room.locked = Boolean(d.locked); }, true);
  /**   // Make someone a co-host (or a guest again); their sockets join/leave the hosts' channel. */
  on("mod.promote", async (d) => {
    const p = target(d.identity);
    if (p.role === "host") return;
    p.role = d.role === "guest" ? "guest" : "cohost";
    p.hand = false;
    await applyPerms(room, p);
    const sockets = await io!.in(personRoom(room.slug, p.identity)).fetchSockets();
    for (const s of sockets) p.role === "cohost" ? s.join(hostRoom(room.slug)) : s.leave(hostRoom(room.slug));
    emitTo(room, p.identity, "role", { role: p.role });
    await q("UPDATE participants SET role = $3 WHERE session_id = $1 AND identity = $2", [room.sessionId, p.identity, p.role]);
  }, true);
  /**   // Admit one waiting guest, or everyone with { all: true }. */
  on("lobby.admit", async (d) => {
    const ids = d.all ? [...room.lobby.keys()] : [String(d.waitId)];
    for (const id of ids) {
      const e = room.lobby.get(id);
      if (!e) continue;
      room.lobby.delete(id);
      try {
        const joined = await admit(room, { name: e.name, role: "guest", lang: e.lang, email: e.email, phone: e.phone, consent: e.consent, verified: e.verified });
        io!.to(waitRoom(room.slug, id)).emit("lobby.admitted", joined);
      } catch (err: any) {
        io!.to(waitRoom(room.slug, id)).emit("lobby.denied", { reason: err?.message });
      }
    }
  }, true);
  /**   // Turn a waiting guest away. */
  on("lobby.deny", (d) => {
    const id = String(d.waitId);
    if (room.lobby.delete(id)) io!.to(waitRoom(room.slug, id)).emit("lobby.denied", { reason: "host" });
  }, true);
  /**   // End the meeting for everyone. */
  on("meeting.end", () => endMeeting(room, "host_ended"), true);

  /* --- Recording banner (the recording itself is made in the host's browser and uploaded) --- */
  /**   // Start the "REC" banner everyone sees. Paid plans only, and never for encrypted meetings. */
  on("record.started", () => {
    if (!PLANS[room.plan].recordings) throw new Error("Recording is on the Pro and Business plans.");
    if (room.e2ee) throw new Error("End-to-end encrypted meetings can't be recorded.");
    room.recording = { by: me.identity, name: me.name, at: Date.now() };
  }, true);
  /**   // Recording finished (the upload goes through POST /api/rooms/recordings). */
  on("record.stopped", () => { if (room.recording?.by === me.identity) room.recording = null; }, true);

  /* --- Breakout rooms --- */
  /**   // Open breakout rooms: each listed guest gets a token for their breakout LiveKit room. Optional auto-close timer. */
  on("breakout.start", async (d) => {
    if (room.breakouts) throw new Error("Breakout rooms are already open.");
    const list = (Array.isArray(d.rooms) ? d.rooms : []).slice(0, 20);
    if (!list.length) throw new Error("Add at least one breakout room.");
    const minutes = Number(d.minutes) > 0 ? Math.min(Number(d.minutes), 120) : null;
    room.breakouts = {
      endsAt: minutes ? Date.now() + minutes * 60_000 : null,
      rooms: list.map((r: any, i: number) => ({
        id: `${room.slug}~${i + 1}`, label: String(r.label || `Room ${i + 1}`).slice(0, 40),
        members: (Array.isArray(r.members) ? r.members : []).map(String).filter((x: string) => room.people.has(x)),
      })),
    };
    if (minutes) room.breakouts.timer = setTimeout(() => closeBreakouts(room).catch(() => {}), minutes * 60_000);
    for (const b of room.breakouts.rooms) for (const id of b.members) await moveTo(room, room.people.get(id)!, b.id, b.label);
  }, true);
  /**   // A host visits a breakout room (or goes back to the main room with id: null). */
  on("breakout.visit", async (d) => {
    const b = room.breakouts?.rooms.find((x) => x.id === d.id);
    await moveTo(room, me, b ? b.id : room.slug, b ? b.label : "Main room");
  }, true);
  /**   // Close all breakout rooms: everyone returns to the main room. */
  on("breakout.close", () => closeBreakouts(room), true);

  socket.on("disconnect", () => {
    me.sockets.delete(socket.id);
    if (me.sockets.size === 0 && !room.ended) {
      broadcast(room);
      // Network switches drop sockets briefly; only count someone as gone after 30 seconds.
      scheduleLeaveCheck(room, me, 30_000);
    }
  });
}

/** Move someone to another LiveKit room (breakouts): new token, sent to their browser, which reconnects. */
async function moveTo(room: Room, p: Person, lkRoom: string, label: string) {
  p.lkRoom = lkRoom;
  const token = await mediaToken({ room: lkRoom, identity: p.identity, name: p.name, perms: permsOf(room, p), metadata: JSON.stringify({ role: p.role, lang: p.lang }) });
  emitTo(room, p.identity, "breakout.move", { livekitRoom: lkRoom, livekitToken: token, label });
}

/** Bring everyone back to the main room and close the breakout rooms. */
async function closeBreakouts(room: Room) {
  const b = room.breakouts;
  if (!b) return;
  clearTimeout(b.timer);
  room.breakouts = null;
  for (const p of room.people.values()) if (p.lkRoom !== room.slug) await moveTo(room, p, room.slug, "Main room");
  for (const r of b.rooms) await closeRoom(r.id);
  broadcast(room);
}

/* ---------------------------------------------------------------------------------------------- */
/* Captions                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Languages someone in the room is following (captions are translated into each). */
export const roomLanguages = (room: Room) => [...new Set([...room.people.values()].map((p) => p.lang))];

/** Send a finished caption (with translations) to everyone in the meeting. */
export function emitCaption(room: Room, c: unknown) { emitAll(room, "caption", c); }

/** May this person speak right now? (Used to refuse caption audio from mic-locked guests.) */
export function canSpeak(room: Room, identity: string) {
  const p = room.people.get(identity);
  return Boolean(p && permsOf(room, p).mic);
}

/** For tests: drop all in-memory rooms. */
export function _resetRooms() {
  for (const r of rooms.values()) { r.timers.forEach(clearTimeout); clearTimeout(r.emptyTimer); r.ended = true; }
  rooms.clear();
}
