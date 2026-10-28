/** Occurrence maths for one-off and weekly meetings. All times are UTC Date objects. */
// One week in milliseconds (weekly meetings repeat at exactly this interval in UTC).
const WEEK = 7 * 24 * 3600 * 1000;

/** The meeting fields occurrence maths needs. */
export interface Schedulable { start_at: Date | string; repeat_rule: string; duration_min: number }

/** The next occurrence that has not finished yet (now falls before its end), or null. */
export function nextOccurrence(m: Schedulable, now = new Date()): Date | null {
  const start = new Date(m.start_at).getTime();
  const dur = m.duration_min * 60_000;
  /**   // One-off: the start time, unless the meeting has already finished. */
  if (m.repeat_rule !== "weekly") return now.getTime() < start + dur ? new Date(start) : null;
  if (now.getTime() < start + dur) return new Date(start);
  /**   // Weekly: jump straight to the first week whose occurrence has not ended yet. */
  const k = Math.ceil((now.getTime() - start - dur) / WEEK);
  let occ = start + k * WEEK;
  if (occ + dur <= now.getTime()) occ += WEEK;
  return new Date(occ);
}

/** Which reminder (if any) is due for an occurrence right now. Windows: 24h and 15m before. */
export function dueReminders(occ: Date, now = new Date()): ("24h" | "15m")[] {
  const until = occ.getTime() - now.getTime();
  const out: ("24h" | "15m")[] = [];
  /**   // 24h reminder window: from 24 h before until 1 h before (if scheduled late, skip it). */
  if (until <= 24 * 3600_000 && until > 60 * 60_000) out.push("24h"); // skip 24h if we are already within 1h
  /**   // 15m reminder window: from 15 min before until 5 min after the start. */
  if (until <= 15 * 60_000 && until > -5 * 60_000) out.push("15m");
  return out;
}

/** "Tue 4 Nov, 9:00 AM (WAT)" in the reader's time zone. */
export function formatWhen(d: Date, timeZone = "Africa/Lagos"): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
    timeZoneName: "short",
  }).format(d);
  return s.replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM");
}
