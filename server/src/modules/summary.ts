/**
 * After the meeting (the "intelligence" job): summary, decisions and action items from the captions and chat,
 * translated into each attendee's language, sent on WhatsApp first and email second to everyone who
 * left a contact and agreed. The host also gets the attendance list.
 */
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";
import * as ai from "../lib/ai.js";
import { summaryText } from "../lib/messages.js";
import { reach, sendEmail } from "../lib/notify.js";

/**
 * Write and send the summary for one finished session. Status goes none → running → done (or failed, with the
 * error saved so the host can retry). Encrypted meetings are skipped: the server never heard them.
 */
export async function runSummary(sessionId: string) {
  const s = await one(
    `SELECT s.*, m.title, m.id AS meeting_id, m.slug, m.e2ee, u.email AS host_email, u.name AS host_name
     FROM sessions s JOIN meetings m ON m.id = s.meeting_id JOIN users u ON u.id = m.host_id WHERE s.id = $1`, [sessionId]);
  if (!s || s.e2ee) return;
  await q("UPDATE sessions SET summary_status = 'running' WHERE id = $1", [sessionId]);
  try {
    /**     // Transcript (English version when available), chat, and one row per person (deduplicated by contact). */
    const [lines, chat, people] = await Promise.all([
      q("SELECT speaker_name, coalesce(english, text) AS text FROM transcript_lines WHERE session_id = $1 ORDER BY id", [sessionId]),
      q("SELECT sender_name, text FROM chat_messages WHERE session_id = $1 ORDER BY id", [sessionId]),
      q("SELECT DISTINCT ON (coalesce(email, phone, identity)) name, email, phone, language, consent_summary, role, joined_at, left_at, via FROM participants WHERE session_id = $1 ORDER BY coalesce(email, phone, identity), joined_at", [sessionId]),
    ]);
    /**     // English always, plus every attendee's language. */
    const languages = [...new Set(["en", ...people.map((p) => p.language)])];
    const out = await ai.summarize({
      title: s.title,
      transcript: lines.map((l) => ({ speaker: l.speaker_name, text: l.text })),
      chat: chat.map((c) => ({ speaker: c.sender_name, text: c.text })),
      languages,
    });
    await q("UPDATE sessions SET summary = $2, summary_status = 'done' WHERE id = $1", [sessionId, JSON.stringify(out)]);

    /**     // Send to each attendee who agreed and left a contact, in their language (falls back to English). */
    for (const p of people) {
      if (!p.consent_summary || (!p.email && !p.phone)) continue;
      const v = out.by_language[p.language] ?? out.by_language.en ?? out;
      const text = summaryText({ title: s.title, summary: v.summary, decisions: v.decisions ?? [], actions: v.action_items ?? [] });
      await reach({ meetingId: s.meeting_id, kind: "summary", email: p.email, phone: p.phone, whatsappText: text, mail: { subject: `Summary: ${s.title}`, text } });
    }
    // Attendance for the host.
    /**     // Attendance email for the host (HH:MM in UTC). */
    const fmt = (d: Date) => new Date(d).toISOString().slice(11, 16);
    const attendance = people.map((p) => `• ${p.name}${p.email || p.phone ? ` (${p.email ?? p.phone})` : ""}, ${p.via === "phone" ? "phone, " : ""}${fmt(p.joined_at)}–${p.left_at ? fmt(p.left_at) : "end"} UTC`);
    await sendEmail({
      meetingId: s.meeting_id, to: s.host_email, kind: "attendance", subject: `Attendance: ${s.title} (${people.length} people)`,
      text: [`${people.length} people attended "${s.title}".`, "", ...attendance, "", `Summary, transcript and CSV: ${config.appUrl}/meetings/${s.meeting_id}/sessions/${sessionId}`].join("\n"),
    });
    log.info({ sessionId, engine: out.engine }, "summary sent");
  } catch (e: any) {
    await q("UPDATE sessions SET summary_status = 'failed', summary = $2 WHERE id = $1", [sessionId, JSON.stringify({ error: String(e?.message ?? e) })]);
    throw e;
  }
}
