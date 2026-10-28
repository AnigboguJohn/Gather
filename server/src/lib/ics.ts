/** iCalendar (.ics) text so invites land in Google, Outlook or Apple calendars. */
/** One meeting as a calendar event. `sequence` must grow on every update so calendars replace the old copy. */
export interface IcsEvent {
  uid: string; title: string; start: Date; durationMin: number; url: string; description?: string;
  weekly?: boolean; cancelled?: boolean; sequence?: number; organizerEmail?: string;
}

// UTC timestamp in iCalendar form: 20261103T080000Z
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// Escape characters that have meaning in iCalendar text values.
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** RFC 5545 lines must be folded at 75 octets. */
const fold = (line: string) => line.match(/.{1,73}/g)!.join("\r\n ");

/** The VEVENT lines for one meeting (weekly meetings get RRULE:FREQ=WEEKLY). */
export function icsEvent(e: IcsEvent): string[] {
  const end = new Date(e.start.getTime() + e.durationMin * 60_000);
  return [
    "BEGIN:VEVENT",
    `UID:${e.uid}@gather`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(end)}`,
    ...(e.weekly ? ["RRULE:FREQ=WEEKLY"] : []),
    `SEQUENCE:${e.sequence ?? 0}`,
    `STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    `SUMMARY:${esc(e.title)}`,
    `DESCRIPTION:${esc((e.description ?? "") + `\nJoin: ${e.url}`)}`,
    `URL:${e.url}`,
    `LOCATION:${esc(e.url)}`,
    ...(e.organizerEmail ? [`ORGANIZER:mailto:${e.organizerEmail}`] : []),
    "END:VEVENT",
  ].map(fold);
}

/**
 * A whole .ics file. METHOD: REQUEST for invites/updates (email clients show Accept/Decline),
 * CANCEL for cancellations, PUBLISH for the subscribe feed.
 */
export function icsCalendar(events: IcsEvent[], method: "REQUEST" | "CANCEL" | "PUBLISH" = "PUBLISH"): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Gather//Meetings//EN", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    ...events.flatMap(icsEvent), "END:VCALENDAR", "",
  ].join("\r\n");
}
