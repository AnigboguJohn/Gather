/**
 * End-to-end API + real-time test against a running stack (server, Postgres, LiveKit, Mailpit, AI service).
 * Run: BASE=http://localhost:8080 MAILPIT=http://localhost:8025 npx tsx test/e2e/flow.ts
 * Every step prints PASS/FAIL; exits non-zero on the first failure.
 */
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";

const BASE = process.env.BASE ?? "http://localhost:8080";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const run = Date.now().toString(36);
let passed = 0;

/** Run one named step: print PASS, or print FAIL with the stack and stop the whole run. */
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e: any) { console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`); process.exit(1); }
}
/** Call the API; by default expects a 2xx (or the exact `expect` status). Returns parsed JSON (or text with raw). */
async function api(path: string, o: { method?: string; body?: unknown; token?: string; expect?: number; raw?: boolean } = {}) {
  const r = await fetch(`${BASE}/api${path}`, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { ...(o.body ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  const data = o.raw ? text : text ? JSON.parse(text) : {};
  if (o.expect !== undefined) assert.equal(r.status, o.expect, `${path} → ${r.status} ${text.slice(0, 200)}`);
  else assert.ok(r.ok, `${path} → ${r.status} ${text.slice(0, 300)}`);
  return data as any;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Emails sent to an address, from the Mailpit test inbox API (newest first). */
async function mails(to: string): Promise<{ ID: string; Subject: string }[]> {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return ((await r.json()) as any).messages ?? [];
}
/** Full text and attachments of one email. */
async function mailText(id: string): Promise<{ Text: string; Attachments: any[] }> {
  return (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as any;
}
/** Poll `fn` every 300 ms until it returns something truthy, or fail after `ms`. */
async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v as T; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}
/** Wait for a sign-in code email and return the 6-digit code from its subject. */
async function codeFor(email: string, subjectHas = "Gather code") {
  const m = await waitFor(async () => (await mails(email)).find((x) => x.Subject.includes(subjectHas)), `code email to ${email}`);
  return m.Subject.match(/\d{6}/)![0];
}
/**
 * Open a Socket.IO connection like a browser would (with a room ticket or a waiting-room token) and record
 * every event. Helpers: emit (with ack), last event of a type, wait until state matches, wait for an event.
 */
function connect(auth: Record<string, string>) {
  const s = io(BASE, { path: "/socket.io", auth, transports: ["websocket"] });
  const events: { ev: string; data: any }[] = [];
  s.onAny((ev, data) => events.push({ ev, data }));
  const emit = (ev: string, data: unknown = {}) => new Promise<any>((res) => s.emit(ev, data, res));
  const last = (ev: string) => [...events].reverse().find((e) => e.ev === ev)?.data;
  const until = (pred: (st: any) => boolean, what: string) => waitFor(async () => { const st = last("state"); return st && pred(st) ? st : null; }, what);
  const got = (ev: string, pred: (d: any) => boolean = () => true) => waitFor(async () => events.find((e) => e.ev === ev && pred(e.data))?.data, `event ${ev}`);
  return { s, events, emit, last, until, got };
}

// Shared state across steps: host account, two meetings, and the host/guest connections.
const hostEmail = `ada.${run}@acme.test`;
let token = "";
let instant: any, scheduled: any;
let hostJoin: any, guestJoin: any;
let host!: ReturnType<typeof connect>, guest!: ReturnType<typeof connect>;

// Proves: health: db + ai up.
await step("health: db + ai up", async () => {
  const h = await api("/health");
  assert.ok(h.db && h.ai.ok);
});

// Proves: sign up a company host with an emailed code.
await step("sign up a company host with an emailed code", async () => {
  const r = await api("/auth/start", { body: { email: hostEmail } });
  assert.equal(r.exists, false);
  const code = await codeFor(hostEmail);
  await api("/auth/verify", { body: { email: hostEmail, code: "000000" }, expect: 400 }); // name required for new accounts
  const bad = await api("/auth/verify", { body: { email: hostEmail, code: code === "111111" ? "222222" : "111111", name: "Ada" }, expect: 400 });
  assert.match(bad.error, /Wrong code/);
  const ok = await api("/auth/verify", { body: { email: hostEmail, code, name: "Ada Okafor", accountType: "company", orgName: "Acme Ltd", phone: "0803 111 2222" } });
  token = ok.token;
  const me = await api("/me", { token });
  assert.equal(me.org.kind, "company");
  assert.equal(me.plan.id, "free");
  assert.equal(me.plan.meetingLimitMinutes, 300);
  assert.equal(me.user.role, "owner");
});

// Proves: codes are single-use.
await step("codes are single-use", async () => {
  await api("/auth/start", { body: { email: hostEmail } });
  await sleep(300);
  const msgs = await mails(hostEmail);
  const code = msgs[0].Subject.match(/\d{6}/)![0];
  await api("/auth/verify", { body: { email: hostEmail, code } });
  await api("/auth/verify", { body: { email: hostEmail, code }, expect: 400 });
});

// Proves: Meet now creates a room with share links.
await step("Meet now creates a room with share links", async () => {
  instant = await api("/meetings/instant", { body: {}, token });
  assert.match(instant.slug, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.equal(instant.kind, "instant");
  assert.ok(instant.share.whatsapp.startsWith("https://wa.me/?text="));
  assert.ok(decodeURIComponent(instant.share.whatsapp).includes(`/j/${instant.slug}`));
});

// Proves: Schedule (weekly) with invitees: email with .ics sent, WhatsApp falls back to share link.
await step("Schedule (weekly) with invitees: email with .ics sent, WhatsApp falls back to share link", async () => {
  const start = new Date(Date.now() + 26 * 3600_000).toISOString();
  scheduled = await api("/meetings", {
    token, body: {
      title: "Weekly sales review", start_at: start, duration_min: 45, repeat_rule: "weekly", languages: ["en", "yo"],
      passcode: "4821", invitees: [{ name: "Tolu", email: `tolu.${run}@mail.test`, phone: "0803 222 3333" }, { name: "Amina", phone: "+254712345678" }],
    },
  });
  assert.equal(scheduled.invites.length, 2);
  assert.equal(scheduled.invites[0].result.email, "sent");
  assert.equal(scheduled.invites[0].result.whatsapp, "skipped");
  assert.ok(scheduled.invites[1].whatsappLink.startsWith("https://wa.me/254712345678?text="));
  const m = await waitFor(async () => (await mails(`tolu.${run}@mail.test`)).find((x) => x.Subject.includes("Invitation")), "invite email");
  const full = await mailText(m.ID);
  assert.match(full.Text, /Passcode: 4821/);
  assert.match(full.Text, /I'll attend:/);
});

// Proves: RSVP from the invite link; host sees it.
await step("RSVP from the invite link; host sees it", async () => {
  const d = await api(`/meetings/${scheduled.id}`, { token });
  const tolu = d.invitees.find((i: any) => i.name === "Tolu");
  const r = await api(`/public/rsvp/${tolu.token}`, { body: { r: "yes" } });
  assert.equal(r.rsvp, "yes");
  const list = await api("/meetings?scope=upcoming", { token });
  assert.equal(list.find((x: any) => x.id === scheduled.id).confirmed, 1);
});

// Proves: calendar feed lists scheduled meetings.
await step("calendar feed lists scheduled meetings", async () => {
  const me = await api("/me", { token });
  const ics = await fetch(me.calendar.feedUrl.replace("http://localhost:8080", BASE)).then((r) => r.text());
  assert.ok(ics.includes("SUMMARY:Weekly sales review") && ics.includes("RRULE:FREQ=WEEKLY"));
});

// Proves: public join info hides private data, shows passcode needed.
await step("public join info hides private data, shows passcode needed", async () => {
  const p = await api(`/public/meetings/${scheduled.slug}`);
  assert.equal(p.needsPasscode, true);
  assert.equal(p.title, "Weekly sales review");
  assert.equal(p.captions, true);
  assert.equal(p.passcode_hash, undefined);
});

// Proves: wrong passcode is refused; guest needs a contact.
await step("wrong passcode is refused; guest needs a contact", async () => {
  await api(`/public/meetings/${scheduled.slug}/join`, { body: { name: "X", email: "x@y.test", passcode: "0000" }, expect: 403 });
  await api(`/public/meetings/${instant.slug}/join`, { body: { name: "X" }, expect: 400 });
});

// Proves: host joins (host role, mic + share allowed) and gets a 5-hour clock.
await step("host joins (host role, mic + share allowed) and gets a 5-hour clock", async () => {
  hostJoin = await api(`/meetings/by-slug/${instant.slug}/join`, { body: {}, token });
  assert.equal(hostJoin.role, "host");
  assert.ok(hostJoin.livekitToken && hostJoin.ticket);
  const hours = (hostJoin.endsAt - Date.now()) / 3600_000;
  assert.ok(hours > 4.9 && hours <= 5.01, `endsAt ${hours}h`);
  host = connect({ ticket: hostJoin.ticket });
  const st = await host.until((s) => s.people.length === 1, "host in state");
  assert.equal(st.people[0].canSpeak, true);
  assert.equal(st.people[0].canShare, true);
});

// Proves: guest joins with no account: camera only, mic locked.
await step("guest joins with no account: camera only, mic locked", async () => {
  guestJoin = await api(`/public/meetings/${instant.slug}/join`, { body: { name: "Tolu Ade", phone: "0803 222 3333", email: `tolu.${run}@mail.test`, language: "yo", consent: true } });
  assert.equal(guestJoin.role, "guest");
  const claims = JSON.parse(Buffer.from(guestJoin.livekitToken.split(".")[1], "base64url").toString());
  assert.deepEqual(claims.video.canPublishSources, ["camera"]);
  guest = connect({ ticket: guestJoin.ticket });
  const st = await host.until((s) => s.people.length === 2, "two people");
  const g = st.people.find((p: any) => p.role === "guest");
  assert.equal(g.canSpeak, false);
  assert.equal(g.lang, "yo");
});

// Proves: guest can't do host things.
await step("guest can't do host things", async () => {
  const r = await guest.emit("mic.allowAll");
  assert.equal(r.ok, false);
  assert.match(r.error, /Only the host/);
});

// Proves: raise hand → host allows → guest may speak (and gets a notice).
await step("raise hand → host allows → guest may speak (and gets a notice)", async () => {
  await guest.emit("hand.raise");
  const st = await host.until((s) => s.hands.length === 1, "hand in queue");
  assert.equal(st.hands[0], guestJoin.identity);
  await host.got("hand.raised");
  const r = await host.emit("hand.allow", { identity: guestJoin.identity });
  assert.ok(r.ok);
  await guest.got("notice", (n) => /let you speak/.test(n.text));
  await host.until((s) => s.hands.length === 0 && s.people.find((p: any) => p.identity === guestJoin.identity).canSpeak, "guest can speak");
});

// Proves: live captions: guest audio → text → translated for the room.
await step("live captions: guest audio → text → translated for the room", async () => {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(4000).fill(7)], { type: "audio/webm" }), "chunk.webm");
  const r = await fetch(`${BASE}/api/rooms/captions`, { method: "POST", body: form, headers: { authorization: `Bearer ${guestJoin.ticket}` } });
  assert.equal(r.status, 200, await r.clone().text());
  const c = await host.got("caption");
  assert.equal(c.lang, "yo");
  assert.ok(c.translations.en.startsWith("[en]"), JSON.stringify(c));
  assert.ok(c.translations.yo);
});

// Proves: mic revoked → captions refused.
await step("mic revoked → captions refused", async () => {
  await host.emit("mic.revoke", { identity: guestJoin.identity });
  await guest.got("notice", (n) => /locked your mic/.test(n.text));
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(100)]), "chunk.webm");
  const r = await fetch(`${BASE}/api/rooms/captions`, { method: "POST", body: form, headers: { authorization: `Bearer ${guestJoin.ticket}` } });
  assert.equal(r.status, 403);
});

// Proves: host captions (English) also go in the transcript.
await step("host captions (English) also go in the transcript", async () => {
  for (let i = 0; i < 2; i++) {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(3000).fill(1)], { type: "audio/webm" }), "c.webm");
    const r = await fetch(`${BASE}/api/rooms/captions`, { method: "POST", body: form, headers: { authorization: `Bearer ${hostJoin.ticket}` } });
    assert.equal(r.status, 200);
  }
});

// Proves: screen share: guest asks → host approves → one presenter at a time.
await step("screen share: guest asks → host approves → one presenter at a time", async () => {
  const req = await guest.emit("share.request");
  assert.ok(req.ok && !req.allowed);
  await host.until((s) => s.shareRequests.includes(guestJoin.identity), "share request");
  await host.emit("share.allow", { identity: guestJoin.identity });
  await guest.got("share.allowed");
  const claimsOk = await host.until((s) => s.people.find((p: any) => p.identity === guestJoin.identity).canShare, "guest canShare");
  assert.ok(claimsOk);
  await guest.emit("share.started");
  await host.until((s) => s.sharer === guestJoin.identity, "guest presenting");
  await host.got("share.presenting", (d) => d.identity === guestJoin.identity);
  await host.emit("share.started"); // host takes over
  await guest.got("share.stop");
  const st = await host.until((s) => s.sharer === hostJoin.identity, "host presenting");
  assert.equal(st.people.find((p: any) => p.identity === guestJoin.identity).canShare, false);
  await host.emit("share.ended");
  await host.until((s) => s.sharer === null, "no presenter");
});

// Proves: reactions (7 allowed), chat, polls.
await step("reactions (7 allowed), chat, polls", async () => {
  assert.ok((await guest.emit("reaction", { emoji: "🎉" })).ok);
  assert.equal((await guest.emit("reaction", { emoji: "💩" })).ok, false);
  await host.got("reaction", (r) => r.emoji === "🎉");
  await guest.emit("chat.send", { text: "We agreed the budget is 2 million naira" });
  await host.got("chat", (m) => m.text.includes("2 million"));
  const p = await host.emit("poll.create", { question: "Launch city?", options: ["Lagos", "Nairobi"] });
  assert.ok(p.ok);
  const st = await guest.until((s) => s.polls.length === 1, "poll visible");
  await guest.emit("poll.vote", { pollId: st.polls[0].id, option: 0 });
  await host.until((s) => s.polls[0].counts[0] === 1, "vote counted");
  await host.emit("poll.close", { pollId: st.polls[0].id });
  assert.equal((await guest.emit("poll.vote", { pollId: st.polls[0].id, option: 1 })).ok, false);
});

// Proves: co-host promotion grants host controls.
await step("co-host promotion grants host controls", async () => {
  await host.emit("mod.promote", { identity: guestJoin.identity, role: "cohost" });
  await guest.got("role", (r) => r.role === "cohost");
  const r = await guest.emit("mod.lock", { locked: false });
  assert.ok(r.ok);
  await host.emit("mod.promote", { identity: guestJoin.identity, role: "guest" });
  await guest.got("role", (r) => r.role === "guest");
});

// Proves: breakout rooms move people and bring them back.
await step("breakout rooms move people and bring them back", async () => {
  await host.emit("breakout.start", { rooms: [{ label: "Team A", members: [guestJoin.identity] }], minutes: 0 });
  const mv = await guest.got("breakout.move");
  assert.equal(mv.livekitRoom, `${instant.slug}~1`);
  assert.ok(mv.livekitToken);
  await host.until((s) => s.breakouts?.rooms[0].members[0] === guestJoin.identity, "breakouts in state");
  await host.emit("breakout.close");
  await guest.got("breakout.move", (d) => d.livekitRoom === instant.slug);
  await host.until((s) => s.breakouts === null, "breakouts closed");
});

// Proves: waiting room: guest waits until admitted.
await step("waiting room: guest waits until admitted", async () => {
  await api(`/meetings/${instant.id}`, { method: "PATCH", body: { waiting_room: true }, token }).catch(() => null);
  // waiting room is read when the room starts; use the live toggle via a new scheduled meeting instead
  const m = await api("/meetings", { token, body: { title: "Board call", start_at: new Date(Date.now() + 3600_000).toISOString(), waiting_room: true } });
  const h = await api(`/meetings/by-slug/${m.slug}/join`, { body: {}, token });
  const hs = connect({ ticket: h.ticket });
  await hs.until((s) => s.people.length === 1, "host connected");
  const r = await api(`/public/meetings/${m.slug}/join`, { body: { name: "Kemi", email: `kemi.${run}@mail.test` } });
  assert.equal(r.status, "waiting");
  const w = connect({ wait: r.wait });
  const st = await hs.until((s) => s.lobby.length === 1, "lobby entry");
  await hs.got("lobby.request");
  await hs.emit("lobby.admit", { waitId: st.lobby[0].waitId });
  const admitted = await w.got("lobby.admitted");
  assert.equal(admitted.role, "guest");
  assert.ok(admitted.livekitToken);
  // denied guests get a clear answer
  const r2 = await api(`/public/meetings/${m.slug}/join`, { body: { name: "Spam", email: "spam@x.test" } });
  const w2 = connect({ wait: r2.wait });
  const st2 = await hs.until((s) => s.lobby.length === 1 && s.lobby[0].name === "Spam", "second lobby entry");
  await hs.emit("lobby.deny", { waitId: st2.lobby[0].waitId });
  await w2.got("lobby.denied");
  await hs.emit("meeting.end");
  [hs, w, w2].forEach((x) => x.s.disconnect());
});

// Proves: lock blocks new guests; remove bans the same contact.
await step("lock blocks new guests; remove bans the same contact", async () => {
  await host.emit("mod.lock", { locked: true });
  await api(`/public/meetings/${instant.slug}/join`, { body: { name: "Late", email: "late@x.test" }, expect: 403 });
  await host.emit("mod.lock", { locked: false });
  const extra = await api(`/public/meetings/${instant.slug}/join`, { body: { name: "Troll", email: `troll.${run}@x.test` } });
  const t = connect({ ticket: extra.ticket });
  await host.until((s) => s.people.some((p: any) => p.identity === extra.identity), "troll joined");
  await host.emit("mod.remove", { identity: extra.identity });
  await t.got("removed");
  await host.until((s) => !s.people.some((p: any) => p.identity === extra.identity), "troll gone");
  const again = await api(`/public/meetings/${instant.slug}/join`, { body: { name: "Troll2", email: `troll.${run}@x.test` }, expect: 403 });
  assert.match(again.error, /removed/);
});

// Proves: recording is a paid feature.
await step("recording is a paid feature", async () => {
  const r = await host.emit("record.started");
  assert.equal(r.ok, false);
  assert.match(r.error, /Pro/);
});

// Proves: billing: demo checkout upgrades to Pro (idempotent, amount checked).
await step("billing: demo checkout upgrades to Pro (idempotent, amount checked)", async () => {
  const b = await api("/billing", { token });
  assert.ok(b.providers.includes("demo"));
  const c = await api("/billing/checkout", { token, body: { plan: "pro", provider: "demo", months: 1 } });
  assert.equal(c.amountMinor, 500000);
  await api("/billing/demo/complete", { token, body: { reference: c.reference, outcome: "success" } });
  const again = await api("/billing/demo/complete", { token, body: { reference: c.reference, outcome: "success" } });
  assert.equal(again.already, true);
  const me = await api("/me", { token });
  assert.equal(me.plan.id, "pro");
  assert.equal(me.plan.meetingLimitMinutes, 1440);
  // forged webhooks are rejected
  const r = await fetch(`${BASE}/api/billing/webhooks/paystack`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": "bad" }, body: "{}" });
  assert.equal(r.status, 401);
});

// Proves: recording upload (Pro) is stored and playable by the host.
await step("recording upload (Pro) is stored and playable by the host", async () => {
  // A room started before upgrading keeps its plan, so start a fresh Pro meeting.
  const m = await api("/meetings/instant", { body: { title: "Pro call" }, token });
  const h = await api(`/meetings/by-slug/${m.slug}/join`, { body: {}, token });
  const hs = connect({ ticket: h.ticket });
  await hs.until((s) => s.plan === "pro", "pro room");
  assert.ok((await hs.emit("record.started")).ok);
  await hs.until((s) => s.recording !== null, "recording banner");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(50_000).fill(3)], { type: "video/webm" }), "rec.webm");
  const up = await fetch(`${BASE}/api/rooms/recordings`, { method: "POST", body: form, headers: { authorization: `Bearer ${h.ticket}` } });
  assert.equal(up.status, 201, await up.clone().text());
  const { id } = (await up.json()) as any;
  const link = await api(`/recordings/${id}/link`, { token });
  const file = await fetch(`${BASE}${link.url}`);
  assert.equal(file.status, 200);
  assert.equal((await file.arrayBuffer()).byteLength, 50_000);
  assert.equal((await fetch(`${BASE}/api/recordings/${id}/file?sig=forged`)).status, 401);
  // guests can't upload
  const g = await api(`/public/meetings/${m.slug}/join`, { body: { name: "G", email: "g@x.test" } });
  const f2 = new FormData(); f2.append("file", new Blob([new Uint8Array(10)]), "x.webm");
  assert.equal((await fetch(`${BASE}/api/rooms/recordings`, { method: "POST", body: f2, headers: { authorization: `Bearer ${g.ticket}` } })).status, 403);
  await hs.emit("meeting.end");
  hs.s.disconnect();
});

// Proves: host ends the meeting → everyone told → summary in each language → sent.
await step("host ends the meeting → everyone told → summary in each language → sent", async () => {
  await host.emit("meeting.end");
  const e = await guest.got("meeting.ended");
  assert.equal(e.reason, "host_ended");
  const d = await waitFor(async () => {
    const m = await api(`/meetings/${instant.id}`, { token });
    return m.sessions[0]?.summary_status === "done" ? m : null;
  }, "summary done", 30000);
  assert.equal(d.status, "ended");
  const s = await api(`/meetings/${instant.id}/sessions/${d.sessions[0].id}`, { token });
  assert.match(s.session.summary.summary, /Lagos/);
  assert.ok(s.session.summary.by_language.yo.summary.startsWith("[yo]"));
  assert.equal(s.transcript.length, 3);
  assert.ok(s.participants.length >= 2);
  assert.equal(s.polls[0].results[0].votes, 1);
  // Tolu gets the Yoruba summary by email; the host gets attendance.
  const sm = await waitFor(async () => (await mails(`tolu.${run}@mail.test`)).find((x) => x.Subject.startsWith("Summary")), "summary email");
  assert.match((await mailText(sm.ID)).Text, /\[yo\]/);
  await waitFor(async () => (await mails(hostEmail)).find((x) => x.Subject.startsWith("Attendance")), "attendance email");
  const csv = await api(`/meetings/${instant.id}/sessions/${d.sessions[0].id}/attendance.csv`, { token, raw: true });
  assert.ok(csv.startsWith("name,email,phone,language,role,joined_via,joined_at,left_at,minutes"));
  assert.match(csv, /Tolu Ade/);
  // ended instant link no longer works
  await api(`/public/meetings/${instant.slug}`, { expect: 410 });
});

// Proves: Ask your meetings: answer with sources.
await step("Ask your meetings: answer with sources", async () => {
  const r = await api("/search", { token, body: { question: "Where do we launch first?" } });
  assert.match(r.answer, /Lagos/);
  assert.ok(r.passages.length > 0);
  assert.equal(r.citations[0], "M1");
});

// Proves: edit time → update sent; cancel → notice sent and link disabled.
await step("edit time → update sent; cancel → notice sent and link disabled", async () => {
  const newStart = new Date(Date.now() + 48 * 3600_000).toISOString();
  await api(`/meetings/${scheduled.id}`, { method: "PATCH", token, body: { start_at: newStart } });
  await waitFor(async () => (await mails(`tolu.${run}@mail.test`)).find((x) => x.Subject.startsWith("Updated")), "update email");
  await api(`/meetings/${scheduled.id}/cancel`, { method: "POST", token });
  await waitFor(async () => (await mails(`tolu.${run}@mail.test`)).find((x) => x.Subject.startsWith("Cancelled")), "cancel email");
  await api(`/public/meetings/${scheduled.slug}`, { expect: 410 });
});

// Proves: team: admin adds a member who signs in and only sees their own meetings.
await step("team: admin adds a member who signs in and only sees their own meetings", async () => {
  const email = `bayo.${run}@acme.test`;
  await api("/team", { token, body: { name: "Bayo", email, role: "member" } });
  await api("/auth/start", { body: { email } });
  const code = await codeFor(email);
  const t2 = (await api("/auth/verify", { body: { email, code } })).token;
  const me = await api("/me", { token: t2 });
  assert.equal(me.org.name, "Acme Ltd");
  assert.equal(me.user.role, "member");
  assert.equal((await api("/meetings?scope=past", { token: t2 })).length, 0);
  await api("/team", { token: t2, body: { name: "X", email: `x.${run}@acme.test` }, expect: 403 });
  await api(`/meetings/${instant.id}`, { token: t2, expect: 404 });
});

// Proves: another workspace can't host-join or read this meeting.
await step("another workspace can't host-join or read this meeting", async () => {
  const email = `eve.${run}@other.test`;
  await api("/auth/start", { body: { email } });
  const code = await codeFor(email);
  const t3 = (await api("/auth/verify", { body: { email, code, name: "Eve" } })).token;
  const m = await api("/meetings/instant", { body: {}, token });
  await api(`/meetings/by-slug/${m.slug}/join`, { body: {}, token: t3, expect: 403 });
  await api(`/meetings/${m.id}`, { token: t3, expect: 404 });
});

for (const c of [host, guest]) c?.s.disconnect();
console.log(`\nAll ${passed} steps passed.`);
process.exit(0);
