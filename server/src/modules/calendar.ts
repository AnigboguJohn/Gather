/**
 * Calendar sync (Phase 2).
 *  - Every host has a private .ics feed URL that Google, Outlook and Apple calendars can subscribe to.
 *    Works with no setup at all.
 *  - With GOOGLE_CLIENT_ID/SECRET or MS_CLIENT_ID/SECRET set, hosts can connect their calendar and
 *    Gather writes each meeting into it directly (created, moved, cancelled).
 */
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";
import { joinUrl } from "../lib/messages.js";

/** Calendar providers we can write events into. */
export type Provider = "google" | "microsoft";
// Where Google/Microsoft send the user back after consent (must also be registered in their console).
const redirectUri = (p: Provider) => `${config.appUrl}/api/calendar/${p}/callback`;

/**
 * The provider's consent page URL. `state` is a short-lived signed token holding the user id, so the
 * callback knows who connected and cannot be forged.
 */
export function authUrl(p: Provider, userId: string): string {
  const state = jwt.sign({ typ: "cal", sub: userId, p }, config.jwtSecret, { expiresIn: "15m" });
  if (p === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri(p), response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events", access_type: "offline", prompt: "consent", state,
    }).toString();
    return u.toString();
  }
  const u = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  u.search = new URLSearchParams({
    client_id: config.microsoft.clientId, redirect_uri: redirectUri(p), response_type: "code",
    scope: "offline_access Calendars.ReadWrite", state,
  }).toString();
  return u.toString();
}

/** Check the signed `state` from the OAuth callback; returns who is connecting which provider. */
export function readState(state: string): { userId: string; p: Provider } {
  const s = jwt.verify(state, config.jwtSecret) as any;
  if (s.typ !== "cal") throw new Error("bad state");
  return { userId: s.sub, p: s.p };
}

/** Exchange a code or refresh token at the provider's token endpoint (form-encoded, as OAuth requires). */
async function tokenRequest(p: Provider, params: Record<string, string>) {
  const url = p === "google" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const creds = p === "google" ? config.google : config.microsoft;
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${p} token: ${j.error_description ?? j.error ?? r.status}`);
  return j as { access_token: string; refresh_token?: string };
}

/** Finish connecting: swap the code for a long-lived refresh token and store it on the user. */
export async function connect(p: Provider, userId: string, code: string) {
  const t = await tokenRequest(p, { code, grant_type: "authorization_code", redirect_uri: redirectUri(p) });
  if (!t.refresh_token) throw new Error("No refresh token returned; remove Gather's access in your account and connect again.");
  await q(`UPDATE users SET ${p}_refresh_token = $2 WHERE id = $1`, [userId, t.refresh_token]);
}

/** Forget the user's refresh token for this provider. */
export async function disconnect(p: Provider, userId: string) {
  await q(`UPDATE users SET ${p}_refresh_token = NULL WHERE id = $1`, [userId]);
}

/** Body of a calendar event for each provider. Exported for tests. */
export function eventBody(p: Provider, m: { title: string; start: Date; durationMin: number; weekly: boolean; url: string; passcode?: string | null }) {
  const end = new Date(m.start.getTime() + m.durationMin * 60_000);
  const desc = `Join on Gather: ${m.url}${m.passcode ? `\nPasscode: ${m.passcode}` : ""}`;
  if (p === "google") {
    return {
      summary: m.title, description: desc, location: m.url,
      start: { dateTime: m.start.toISOString(), timeZone: "UTC" }, end: { dateTime: end.toISOString(), timeZone: "UTC" },
      ...(m.weekly ? { recurrence: ["RRULE:FREQ=WEEKLY"] } : {}),
    };
  }
  const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][m.start.getUTCDay()];
  return {
    subject: m.title, body: { contentType: "Text", content: desc }, location: { displayName: m.url },
    start: { dateTime: m.start.toISOString().slice(0, 19), timeZone: "UTC" },
    end: { dateTime: end.toISOString().slice(0, 19), timeZone: "UTC" },
    ...(m.weekly ? { recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: [day] }, range: { type: "noEnd", startDate: m.start.toISOString().slice(0, 10) } } } : {}),
  };
}

/** Create, update or delete the host's calendar event(s) for a meeting. Never throws. */
export async function syncMeeting(meetingId: string, action: "upsert" | "delete", passcode?: string | null) {
  const m = await one(
    `SELECT m.*, u.google_refresh_token, u.microsoft_refresh_token FROM meetings m JOIN users u ON u.id = m.host_id WHERE m.id = $1`, [meetingId]);
  if (!m || m.kind !== "scheduled") return;
  const refs: Record<string, string> = m.calendar_refs ?? {};
  /**
   *   // For each connected provider: get a fresh access token, then create/update/delete the event.
   *   // The provider's event id is kept in meetings.calendar_refs so later edits update the same event.
   */
  for (const p of ["google", "microsoft"] as Provider[]) {
    const refresh = m[`${p}_refresh_token`];
    const creds = p === "google" ? config.google : config.microsoft;
    if (!refresh || !creds.clientId) continue;
    try {
      const { access_token } = await tokenRequest(p, { refresh_token: refresh, grant_type: "refresh_token" });
      const base = p === "google" ? "https://www.googleapis.com/calendar/v3/calendars/primary/events" : "https://graph.microsoft.com/v1.0/me/events";
      const headers = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };
      if (action === "delete") {
        if (refs[p]) await fetch(`${base}/${refs[p]}`, { method: "DELETE", headers });
        delete refs[p];
        continue;
      }
      const body = JSON.stringify(eventBody(p, {
        title: m.title, start: new Date(m.start_at), durationMin: m.duration_min, weekly: m.repeat_rule === "weekly",
        url: joinUrl(config.appUrl, m.slug), passcode,
      }));
      const r = refs[p]
        ? await fetch(`${base}/${refs[p]}`, { method: p === "google" ? "PUT" : "PATCH", headers, body })
        : await fetch(base, { method: "POST", headers, body });
      const j: any = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? String(r.status));
      refs[p] = j.id;
    } catch (e: any) {
      log.warn({ err: e?.message, p, meetingId }, "calendar sync failed");
    }
  }
  await q("UPDATE meetings SET calendar_refs = $2 WHERE id = $1", [meetingId, JSON.stringify(refs)]);
}
