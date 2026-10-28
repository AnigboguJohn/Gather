/**
 * Unit tests for the server's pure logic (no database, no network): codes, passcodes, meeting links,
 * weekly occurrences and reminder windows, time zones, calendar files, plans and prices, phone numbers,
 * message wording, payment webhook signatures, calendar event bodies, CSV safety and review names.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
// Ignore any local .env so tests behave the same everywhere (modules are imported after this line).
process.env.GATHER_SKIP_DOTENV = "1";
const { codeMatches, generateCode, hashCode, hashPasscode, meetingSlug, passcodeMatches } = await import("../src/lib/codes.ts");
const { icsCalendar } = await import("../src/lib/ics.ts");
const { dueReminders, nextOccurrence, formatWhen } = await import("../src/lib/time.ts");
const { effectivePlan, meetingLimitMinutes, priceMinor } = await import("../src/lib/plans.ts");
const { normalizePhone, waLink } = await import("../src/lib/notify.ts");
const { inviteText, summaryText } = await import("../src/lib/messages.ts");
const { paystackSignatureValid, flutterwaveSignatureValid } = await import("../src/modules/billing.routes.ts");
const { eventBody } = await import("../src/modules/calendar.ts");
const { csvCell } = await import("../src/modules/meetings.routes.ts");
const { publicName, scoreLabel, who } = await import("../src/modules/reviews.ts");

// Sign-in codes: always 6 digits, stored as HMAC, spaces ignored, wrong code/secret rejected.
test("codes: 6 digits, hashed, constant-time match", () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
  const h = hashCode("012345", "s");
  assert.ok(codeMatches("012 345", h, "s"));
  assert.ok(!codeMatches("012346", h, "s"));
  assert.ok(!codeMatches("012345", h, "other"));
  assert.ok(!codeMatches("012345", "zz", "s"));
});

// Meeting link codes have the abc-defg-hij shape and avoid letters people confuse (i, l, o).
test("meeting slugs look like abc-defg-hij and avoid look-alike letters", () => {
  for (let i = 0; i < 100; i++) { const s = meetingSlug(); assert.match(s, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/); assert.ok(!/[ilo]/.test(s)); }
});

// Passcodes use a random salt (same passcode → different hash) and verify correctly.
test("passcodes are salted scrypt hashes", () => {
  const a = hashPasscode("4821"), b = hashPasscode("4821");
  assert.notEqual(a, b);
  assert.ok(passcodeMatches("4821", a));
  assert.ok(!passcodeMatches("4822", a));
  assert.ok(!passcodeMatches("4821", "garbage"));
});

// Next occurrence: in-progress meeting counts; weekly series roll to next week; finished one-offs return null.
test("weekly occurrences roll forward; one-offs end", () => {
  const start = new Date("2026-10-05T09:00:00Z"); // a Monday
  const m = { start_at: start, repeat_rule: "weekly", duration_min: 60 };
  assert.equal(nextOccurrence(m, new Date("2026-10-05T09:30:00Z"))!.toISOString(), start.toISOString()); // in progress
  assert.equal(nextOccurrence(m, new Date("2026-10-05T10:00:00Z"))!.toISOString(), "2026-10-12T09:00:00.000Z");
  assert.equal(nextOccurrence(m, new Date("2026-10-20T12:00:00Z"))!.toISOString(), "2026-10-26T09:00:00.000Z");
  assert.equal(nextOccurrence({ ...m, repeat_rule: "none" }, new Date("2026-10-06T00:00:00Z")), null);
});

// Reminder windows: 24 h reminder between 24 h and 1 h before; 15 min reminder close to the start.
test("reminders fire 24h and 15m before", () => {
  const occ = new Date("2026-11-01T09:00:00Z");
  assert.deepEqual(dueReminders(occ, new Date("2026-10-31T09:30:00Z")), ["24h"]);
  assert.deepEqual(dueReminders(occ, new Date("2026-10-31T08:00:00Z")), []);
  assert.deepEqual(dueReminders(occ, new Date("2026-11-01T08:50:00Z")), ["15m"]);
  assert.deepEqual(dueReminders(occ, new Date("2026-11-01T08:30:00Z")), []); // within 1h: skip 24h, too early for 15m
});

// Times are formatted in each reader's own time zone (Lagos vs Nairobi).
test("times are shown in the reader's zone", () => {
  const d = new Date("2026-11-03T08:00:00Z");
  assert.match(formatWhen(d, "Africa/Lagos"), /9:00\s?AM/);
  assert.match(formatWhen(d, "Africa/Nairobi"), /11:00\s?AM/);
});

// Calendar files: event present, weekly rule, escaped text, lines folded to 75 characters, correct UTC times.
test("ics has VEVENT, RRULE for weekly, and folds long lines", () => {
  const ics = icsCalendar([{ uid: "u1", title: "Sales, weekly; review", start: new Date("2026-11-03T08:00:00Z"), durationMin: 60, url: "http://x/j/abc", weekly: true, description: "x".repeat(200) }], "REQUEST");
  assert.ok(ics.includes("BEGIN:VEVENT") && ics.includes("RRULE:FREQ=WEEKLY") && ics.includes("METHOD:REQUEST"));
  assert.ok(ics.includes("SUMMARY:Sales\\, weekly\; review"));
  assert.ok(ics.split("\r\n").every((l) => l.length <= 75));
  assert.ok(ics.includes("DTSTART:20261103T080000Z") && ics.includes("DTEND:20261103T090000Z"));
});

// Plans: Free is 2 hours, paid is 24 h; a lapsed paid plan counts as Free; prices in kobo.
test("plans: Free is 2 hours; paid plans lapse back to Free", () => {
  assert.equal(meetingLimitMinutes("free"), 120);
  assert.equal(meetingLimitMinutes("pro"), 1440);
  const now = new Date("2026-10-22T00:00:00Z");
  assert.equal(effectivePlan({ plan: "pro", paid_until: "2026-11-01T00:00:00Z" }, now), "pro");
  assert.equal(effectivePlan({ plan: "pro", paid_until: "2026-10-01T00:00:00Z" }, now), "free");
  assert.equal(effectivePlan({ plan: "business", paid_until: null }, now), "free");
  assert.equal(priceMinor("pro", 3), 1_500_000);
});

// Phone numbers become international digits for WhatsApp links (Nigeria by default).
test("phone numbers normalise for WhatsApp links", () => {
  assert.equal(normalizePhone("0803 111 2222"), "2348031112222");
  assert.equal(normalizePhone("+254 712 345678"), "254712345678");
  assert.equal(normalizePhone("00233 24 123 4567"), "233241234567");
  assert.ok(waLink("08031112222", "hi there").startsWith("https://wa.me/2348031112222?text=hi%20there"));
});

// Invite and summary messages contain the key details people need.
test("invite and summary text", () => {
  const t = inviteText({ host: "Ada", title: "Standup", when: new Date("2026-11-03T08:00:00Z"), tz: "Africa/Lagos", url: "http://x/j/a", passcode: "1234", weekly: true });
  assert.match(t, /Ada invited you to "Standup"/); assert.match(t, /every week/); assert.match(t, /Passcode: 1234/);
  const s = summaryText({ title: "Standup", summary: "Done.", decisions: ["Go"], actions: [{ owner: "Tolu", task: "Send", due: "Fri" }] });
  assert.match(s, /• Tolu: Send \(by Fri\)/);
});

// Payment webhooks: only correctly signed Paystack/Flutterwave calls are accepted.
test("payment webhook signatures", () => {
  const body = JSON.stringify({ event: "charge.success" });
  const sig = crypto.createHmac("sha512", "sk_test").update(body).digest("hex");
  assert.ok(paystackSignatureValid(body, sig, "sk_test"));
  assert.ok(!paystackSignatureValid(body, sig, "sk_other"));
  assert.ok(!paystackSignatureValid(body, undefined, "sk_test"));
  assert.ok(flutterwaveSignatureValid("hash123", "hash123"));
  assert.ok(!flutterwaveSignatureValid("hash124", "hash123"));
  assert.ok(!flutterwaveSignatureValid("x", ""));
});

// Google/Outlook event bodies: weekly recurrence and correct end time.
test("calendar event bodies", () => {
  const m = { title: "Review", start: new Date("2026-11-03T08:00:00Z"), durationMin: 30, weekly: true, url: "http://x/j/a" };
  const g: any = eventBody("google", m);
  assert.deepEqual(g.recurrence, ["RRULE:FREQ=WEEKLY"]);
  assert.equal(g.end.dateTime, "2026-11-03T08:30:00.000Z");
  const ms: any = eventBody("microsoft", m);
  assert.deepEqual(ms.recurrence.pattern.daysOfWeek, ["tuesday"]);
});

// Attendance CSV: values are quoted and formulas are neutralised (CSV injection).
test("CSV cells are escaped and safe from formula injection", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=HYPERLINK()"), `"'=HYPERLINK()"`);
  assert.equal(csvCell(null), "");
});

// Reviews: public names never show full surnames or contacts; reviewers are matched by normalised contacts.
test("reviews: public names, score words and contact keys", () => {
  assert.equal(publicName("Ngozi  Adeyemi", false), "Ngozi A.");
  assert.equal(publicName("Tunde", false), "Tunde");
  assert.equal(publicName("Ngozi Adeyemi", true), "Anonymous");
  assert.deepEqual([4.8, 4, 3, 2, 1].map(scoreLabel), ["Excellent", "Great", "Average", "Poor", "Bad"]);
  const w = who({ name: " Amara ", email: " Amara@X.com ", phone: "0803 123 4567" });
  assert.deepEqual([w.email, w.phone, w.userId, w.role, w.name], ["amara@x.com", "2348031234567", null, "guest", "Amara"]);
});
