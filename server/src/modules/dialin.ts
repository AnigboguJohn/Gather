/**
 * Phone dial-in (Phase 2) through LiveKit SIP.
 * Each meeting gets a 6-digit PIN. When a SIP trunk is configured (LIVEKIT_SIP_TRUNK_ID, plus a phone
 * number from a SIP provider such as Africa's Talking or Twilio pointed at LiveKit SIP), Gather creates
 * one dispatch rule per meeting: callers dial DIALIN_NUMBER, type the PIN and land in the meeting room.
 * Setup steps are in docs/DIAL_IN.md. Without a trunk, PINs are generated but no number is shown.
 */
import crypto from "node:crypto";
import { SipClient } from "livekit-server-sdk";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { log } from "../log.js";

// LiveKit SIP API client (created on demand).
const sip = () => new SipClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);
/** Dial-in is on only when both a SIP trunk and a public phone number are configured. */
export const dialInEnabled = () => Boolean(config.livekit.sipTrunkId && config.dialinNumber);

/** A PIN no other active meeting uses. */
export async function newDialinPin(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const pin = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    if (!(await one("SELECT 1 FROM meetings WHERE dialin_pin = $1", [pin]))) return pin;
  }
  throw new Error("could not allocate a dial-in PIN");
}

/**
 * Create the LiveKit dispatch rule for one meeting: callers who type this meeting's PIN are sent to its room.
 * The rule id is saved in meetings.calendar_refs.sipRule so it is created once and can be removed later.
 */
export async function ensureDialinRule(meetingId: string) {
  if (!dialInEnabled()) return;
  const m = await one("SELECT slug, dialin_pin, calendar_refs FROM meetings WHERE id = $1", [meetingId]);
  if (!m?.dialin_pin || m.calendar_refs?.sipRule) return;
  try {
    const rule = await sip().createSipDispatchRule(
      { type: "direct", roomName: m.slug, pin: m.dialin_pin },
      { name: `gather-${m.slug}`, trunkIds: [config.livekit.sipTrunkId] });
    await q("UPDATE meetings SET calendar_refs = calendar_refs || jsonb_build_object('sipRule', $2::text) WHERE id = $1",
      [meetingId, rule.sipDispatchRuleId]);
  } catch (e: any) {
    log.warn({ err: e?.message }, "SIP dispatch rule failed");
  }
}

/** Delete the meeting's dispatch rule (on cancel) so its PIN stops working. */
export async function removeDialinRule(meetingId: string) {
  const m = await one("SELECT calendar_refs FROM meetings WHERE id = $1", [meetingId]);
  const id = m?.calendar_refs?.sipRule;
  if (!id || !dialInEnabled()) return;
  await sip().deleteSipDispatchRule(id).catch(() => {});
}
