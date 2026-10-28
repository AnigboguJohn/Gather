/**
 * Outbound messages. WhatsApp first, email second, SMS as an extra channel.
 *  - WhatsApp Cloud API sends for real when WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set.
 *    Without them, the host gets ready-to-send wa.me links (click-to-share), which open WhatsApp
 *    with the message filled in.
 *  - Email goes to any SMTP server; locally that is Mailpit (http://localhost:8025).
 *  - SMS goes through Africa's Talking when its keys are set.
 * Every attempt is logged in the notifications table so hosts can see what was delivered.
 */
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { q } from "../db.js";
import { log } from "../log.js";

// One SMTP connection setup for the whole app (port 465 = TLS from the start).
const mailer = nodemailer.createTransport({
  host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

/** Delivery channels and outcomes; "skipped" = channel not configured (e.g. no WhatsApp API keys). */
export type Channel = "email" | "whatsapp" | "sms";
export type Status = "sent" | "failed" | "skipped";

// Log every send attempt in the notifications table (shown to hosts on the meeting page). Never throws.
async function record(meetingId: string | null, channel: Channel, to: string, kind: string, status: Status, detail?: string) {
  await q("INSERT INTO notifications (meeting_id, channel, to_addr, kind, status, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [meetingId, channel, to, kind, status, detail?.slice(0, 500) ?? null]).catch(() => {});
}

/** Digits only, Nigerian local numbers (0803...) become 234803... */
export function normalizePhone(raw: string, defaultCountry = "234"): string {
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.slice(1);
  if (d.startsWith("00")) return d.slice(2);
  if (d.startsWith("0")) return defaultCountry + d.slice(1);
  return d;
}

/** Click-to-send WhatsApp link: opens WhatsApp with the message ready (no API keys needed). */
export const waLink = (phone: string | null, text: string) =>
  `https://wa.me/${phone ? normalizePhone(phone) : ""}?text=${encodeURIComponent(text)}`;

/** Are the WhatsApp Cloud API / SMS keys configured? */
export const whatsappEnabled = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
export const smsEnabled = () => Boolean(config.sms.username && config.sms.apiKey);

/** Make text safe to put inside HTML. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Gather's email look: a simple, light card with the logo name, the message and a short footer.
 * Inline styles and tables only, because many email apps ignore anything else.
 */
export function emailLayout(o: { preheader: string; body: string }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#f5f5f4;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:800;color:#064e3b;padding-bottom:20px">Gather</td></tr>
<tr><td style="font-size:15px;line-height:1.6">${o.body}</td></tr>
<tr><td style="padding-top:28px;font-size:12px;line-height:1.5;color:#78716c;border-top:1px solid #e7e5e4">Gather · video meetings for any network, in your language<br><a href="${escapeHtml(config.appUrl)}" style="color:#047857">${escapeHtml(config.appUrl.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Send one email (optionally with an HTML version and a calendar invite). Returns "sent" or "failed"; never throws.
 * Every email gets a unique reference header so Gmail doesn't fold repeat messages (like codes) into one thread.
 */
export async function sendEmail(o: {
  meetingId?: string | null; to: string; subject: string; text: string; html?: string; kind: string;
  ics?: { content: string; method: "REQUEST" | "CANCEL" | "PUBLISH" };
}): Promise<Status> {
  try {
    await mailer.sendMail({
      from: config.smtp.from, replyTo: config.smtp.from, to: o.to, subject: o.subject, text: o.text, html: o.html,
      headers: { "X-Entity-Ref-ID": crypto.randomUUID() },
      icalEvent: o.ics ? { method: o.ics.method, content: o.ics.content, filename: "invite.ics" } : undefined,
    });
    await record(o.meetingId ?? null, "email", o.to, o.kind, "sent");
    return "sent";
  } catch (e: any) {
    log.warn({ err: e?.message, to: o.to }, "email failed");
    await record(o.meetingId ?? null, "email", o.to, o.kind, "failed", e?.message);
    return "failed";
  }
}

/**
 * Send a WhatsApp text through the Cloud API. Returns "skipped" when not configured.
 * Note: Meta only allows free-form texts inside a 24-hour customer window; production use needs approved templates.
 */
export async function sendWhatsApp(o: { meetingId?: string | null; to: string; text: string; kind: string }): Promise<Status> {
  if (!whatsappEnabled()) {
    await record(o.meetingId ?? null, "whatsapp", o.to, o.kind, "skipped", "WhatsApp API not configured; use the share link");
    return "skipped";
  }
  try {
    const r = await fetch(
      `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.whatsapp.token}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: normalizePhone(o.to), type: "text", text: { body: o.text, preview_url: true } }),
        signal: AbortSignal.timeout(15_000),
      });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    await record(o.meetingId ?? null, "whatsapp", o.to, o.kind, "sent");
    return "sent";
  } catch (e: any) {
    log.warn({ err: e?.message }, "whatsapp failed");
    await record(o.meetingId ?? null, "whatsapp", o.to, o.kind, "failed", e?.message);
    return "failed";
  }
}

/** Send an SMS through Africa's Talking ("sandbox" username uses their free sandbox). Returns "skipped" when not configured. */
export async function sendSms(o: { meetingId?: string | null; to: string; text: string; kind: string }): Promise<Status> {
  if (!smsEnabled()) {
    await record(o.meetingId ?? null, "sms", o.to, o.kind, "skipped", "SMS not configured");
    return "skipped";
  }
  const host = config.sms.username === "sandbox" ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  try {
    const body = new URLSearchParams({ username: config.sms.username, to: `+${normalizePhone(o.to)}`, message: o.text });
    if (config.sms.senderId) body.set("from", config.sms.senderId);
    const r = await fetch(`https://${host}/version1/messaging`, {
      method: "POST", body,
      headers: { apiKey: config.sms.apiKey, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    await record(o.meetingId ?? null, "sms", o.to, o.kind, "sent");
    return "sent";
  } catch (e: any) {
    await record(o.meetingId ?? null, "sms", o.to, o.kind, "failed", e?.message);
    return "failed";
  }
}

/**
 * Send to one person on the best channels they have: WhatsApp (if a phone and the API is set up),
 * then email. SMS is used only when asked (it costs money per message).
 */
export async function reach(o: {
  meetingId?: string | null; kind: string; email?: string | null; phone?: string | null; sms?: boolean;
  whatsappText: string; mail?: { subject: string; text: string; ics?: { content: string; method: "REQUEST" | "CANCEL" | "PUBLISH" } };
}) {
  const result: Record<string, Status> = {};
  if (o.phone) result.whatsapp = await sendWhatsApp({ meetingId: o.meetingId, to: o.phone, text: o.whatsappText, kind: o.kind });
  if (o.email && o.mail) result.email = await sendEmail({ meetingId: o.meetingId, to: o.email, kind: o.kind, ...o.mail });
  if (o.phone && o.sms) result.sms = await sendSms({ meetingId: o.meetingId, to: o.phone, text: o.whatsappText, kind: o.kind });
  return result;
}
