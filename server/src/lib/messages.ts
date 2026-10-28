/** Message wording for invites, reminders, changes and summaries (short: they are read on phones). */
import { formatWhen } from "./time.js";

/** Join link. With an invite token (?i=) the join screen pre-fills that invitee's details. */
export const joinUrl = (appUrl: string, slug: string, token?: string) =>
  `${appUrl}/j/${slug}${token ? `?i=${token}` : ""}`;

/** Invitation text for WhatsApp/SMS/email. `when` = null for Meet now ("now"). */
export function inviteText(o: { host: string; title: string; when: Date | null; tz: string; url: string; passcode?: string | null; weekly?: boolean; dialIn?: string | null }) {
  const when = o.when ? `${formatWhen(o.when, o.tz)}${o.weekly ? " (every week)" : ""}` : "now";
  return [
    `${o.host} invited you to "${o.title}" on Gather.`,
    `When: ${when}`,
    `Join (no account needed): ${o.url}`,
    ...(o.passcode ? [`Passcode: ${o.passcode}`] : []),
    ...(o.dialIn ? [`No data? Call ${o.dialIn}`] : []),
  ].join("\n");
}

/** The "I'll attend / Can't make it" line added to scheduled invites. */
export function rsvpText(url: string, rsvpBase: string) {
  return `Reply: I'll attend ${rsvpBase}?r=yes  ·  Can't make it ${rsvpBase}?r=no\n${url}`;
}

/** Reminder text: "tomorrow" for the 24-hour reminder, "in 15 minutes" with a Join now link for the second. */
export function reminderText(o: { title: string; when: Date; tz: string; url: string; kind: "24h" | "15m" }) {
  return o.kind === "24h"
    ? `Reminder: "${o.title}" is tomorrow, ${formatWhen(o.when, o.tz)}.\nJoin: ${o.url}`
    : `"${o.title}" starts in 15 minutes.\nJoin now: ${o.url}`;
}

/** Sent once when the host changes the time; the link stays the same. */
export function updateText(o: { title: string; when: Date; tz: string; url: string }) {
  return `Time changed: "${o.title}" is now ${formatWhen(o.when, o.tz)}.\nSame link: ${o.url}`;
}

/** Sent when a meeting is cancelled. */
export const cancelText = (title: string) => `"${title}" has been cancelled. The link no longer works.`;

/** The after-meeting message: summary, decisions and action items, in the reader's language. */
export function summaryText(o: { title: string; summary: string; decisions: string[]; actions: { owner: string; task: string; due?: string | null }[] }) {
  return [
    `Summary of "${o.title}"`,
    "",
    o.summary,
    ...(o.decisions.length ? ["", "Decisions:", ...o.decisions.map((d) => `• ${d}`)] : []),
    ...(o.actions.length ? ["", "Action items:", ...o.actions.map((a) => `• ${a.owner}: ${a.task}${a.due ? ` (by ${a.due})` : ""}`)] : []),
    "",
    "Sent by Gather",
  ].join("\n");
}
