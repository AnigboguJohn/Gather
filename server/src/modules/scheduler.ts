/**
 * Reminders: WhatsApp (email if no WhatsApp) 24 hours and 15 minutes before each occurrence,
 * weekly series included. Runs every minute; reminders_sent makes it safe to run twice.
 */
import { config } from "../config.js";
import { q } from "../db.js";
import { log } from "../log.js";
import { joinUrl, reminderText } from "../lib/messages.js";
import { reach } from "../lib/notify.js";
import { dueReminders, nextOccurrence } from "../lib/time.js";

/**
 * One scheduler pass. For every upcoming scheduled meeting: find its next occurrence, see which reminder is
 * due, "claim" it in reminders_sent (the primary key stops duplicates, even with two servers), then send it
 * to every invitee who has not said "Can't make it", plus the host. Returns how many messages were sent.
 */
export async function sendDueReminders(now = new Date()) {
  /**   // Weekly series always qualify; one-off meetings only if they start within the next 25 hours. */
  const meetings = await q(
    `SELECT m.*, u.name AS host_name, u.email AS host_email, u.phone AS host_phone FROM meetings m JOIN users u ON u.id = m.host_id
     WHERE m.kind = 'scheduled' AND m.status IN ('scheduled','live') AND (m.repeat_rule = 'weekly' OR m.start_at < $1::timestamptz + interval '25 hours')`,
    [now.toISOString()]);
  let sent = 0;
  for (const m of meetings) {
    const occ = nextOccurrence(m, now);
    if (!occ) continue;
    for (const kind of dueReminders(occ, now)) {
      /**       // INSERT ... ON CONFLICT DO NOTHING RETURNING: only the first pass that claims it gets a row back. */
      const claimed = await q(
        "INSERT INTO reminders_sent (meeting_id, occurrence_at, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
        [m.id, occ.toISOString(), kind]);
      if (!claimed.length) continue;
      const invitees = await q("SELECT * FROM invitees WHERE meeting_id = $1 AND rsvp <> 'no'", [m.id]);
      const people = [...invitees, { email: m.host_email, phone: m.host_phone, token: null }];
      for (const i of people) {
        const text = reminderText({ title: m.title, when: occ, tz: m.time_zone, url: joinUrl(config.appUrl, m.slug, i.token ?? undefined), kind });
        await reach({ meetingId: m.id, kind: "reminder", email: i.email, phone: i.phone, whatsappText: text, mail: { subject: `${kind === "15m" ? "Starting soon" : "Tomorrow"}: ${m.title}`, text } });
        sent++;
      }
    }
  }
  return sent;
}

/** Run the scheduler 5 seconds after boot, then every minute. Errors are logged, never crash the server. */
export function startScheduler() {
  const tick = () => sendDueReminders().then((n) => n && log.info({ n }, "reminders sent")).catch((e) => log.error({ err: e?.message }, "scheduler"));
  setTimeout(tick, 5_000);
  return setInterval(tick, 60_000);
}
