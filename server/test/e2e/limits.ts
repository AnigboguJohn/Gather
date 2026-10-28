/**
 * Free-plan time limit and reminders.
 * Needs a server started with a short limit, e.g.
 *   FREE_MEETING_MINUTES=0.3 WARN_BEFORE_MINUTES=0.2,0.1 PORT=8081 npx tsx src/index.ts
 * Run: BASE=http://localhost:8081 npx tsx test/e2e/limits.ts
 */
import assert from "node:assert/strict";
import { io } from "socket.io-client";

const BASE = process.env.BASE ?? "http://localhost:8081";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const run = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Call the API and fail loudly on any non-2xx. */
async function api(path: string, o: { body?: unknown; token?: string } = {}) {
  const r = await fetch(`${BASE}/api${path}`, { method: o.body ? "POST" : "GET", headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const d: any = await r.json();
  assert.ok(r.ok, JSON.stringify(d));
  return d;
}
/** Emails sent to an address (Mailpit test inbox). */
async function mails(to: string) { return (((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as any).messages ?? []) as any[]; }

// A fresh host account for this run.
const email = `lim.${run}@acme.test`;
await api("/auth/start", { body: { email } });
await sleep(500);
const code = (await mails(email))[0].Subject.match(/\d{6}/)[0];
const { token } = await api("/auth/verify", { body: { email, code, name: "Limit Tester" } });

// The server under test runs with an 18-second "Free" limit and warnings at 12 s and 6 s before the end.
// --- Time limit ---
const m = await api("/meetings/instant", { body: {}, token });
const t0 = Date.now();
const h = await api(`/meetings/by-slug/${m.slug}/join`, { body: {}, token });
const secs = (h.endsAt - t0) / 1000;
assert.ok(secs > 15 && secs < 20, `limit ${secs}s`);
const s = io(BASE, { path: "/socket.io", auth: { ticket: h.ticket }, transports: ["websocket"] });
const events: { ev: string; d: any; t: number }[] = [];
s.onAny((ev, d) => events.push({ ev, d, t: (Date.now() - t0) / 1000 }));
// Wait past the limit and collect what the browser would have received.
await sleep(21_000);
const warns = events.filter((e) => e.ev === "time.warning");
const end = events.find((e) => e.ev === "meeting.ended");
console.log("warnings:", warns.map((w) => `${w.d.minutesLeft} min left at ${w.t.toFixed(1)}s`), "ended:", end?.d, `at ${end?.t.toFixed(1)}s`);
assert.equal(warns.length, 2);
assert.equal(end?.d.reason, "time_limit");
const d = await api(`/meetings/${m.id}`, { token });
assert.equal(d.sessions[0].end_reason, "time_limit");
console.log("PASS  free-plan time limit: two warnings, then the meeting ends for everyone");
s.disconnect();

// One meeting in 10 minutes (15m reminder due) and one in 23 hours (24h reminder due).
// --- Reminders (24h and 15m) ---
const soon = await api("/meetings", { token, body: { title: "Soon call", start_at: new Date(Date.now() + 10 * 60_000).toISOString(), invitees: [{ name: "Rem", email: `rem.${run}@mail.test` }] } });
const tomorrow = await api("/meetings", { token, body: { title: "Tomorrow call", start_at: new Date(Date.now() + 23 * 3600_000).toISOString(), invitees: [{ name: "Rem", email: `rem.${run}@mail.test` }] } });
process.env.GATHER_SKIP_DOTENV = "1";
const { sendDueReminders } = await import("../../src/modules/scheduler.ts");
await sendDueReminders();
// Run the scheduler pass directly (no need to wait for the 1-minute timer).
await sendDueReminders(); // running twice must not send twice
await sleep(800);
const got = (await mails(`rem.${run}@mail.test`)).map((x) => x.Subject);
const starting = got.filter((x) => x.startsWith("Starting soon: Soon call"));
const tmr = got.filter((x) => x.startsWith("Tomorrow: Tomorrow call"));
assert.equal(starting.length, 1, JSON.stringify(got));
assert.equal(tmr.length, 1, JSON.stringify(got));
console.log("PASS  reminders: 15-minute and 24-hour reminders sent once each");
void soon; void tomorrow;
process.exit(0);
