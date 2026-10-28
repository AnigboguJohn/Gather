/** Share sheet used after Meet now, on the dashboard and on the meeting page. */
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { copy, Spinner, toast } from "./ui";
import { api, ApiError } from "../lib/api";
import { withKey } from "../lib/e2ee";

/** A meeting as the API returns it (list, detail and create responses share this shape). */
export interface MeetingDto {
  id: string; slug: string; title: string; kind: "instant" | "scheduled"; status: string; startAt: string; nextAt: string | null;
  durationMin: number; timeZone: string; repeat: "none" | "weekly"; languages: string[]; hasPasscode: boolean; waitingRoom: boolean;
  openMic: boolean; anyoneCanShare: boolean; verifyGuests: boolean; e2ee: boolean; host: { id: string; name: string }; url: string;
  dialIn: { number: string; pin: string } | null; live: { people: number; waiting: number; endsAt: number } | null;
  share: { text: string; whatsapp: string; sms: string; email: string }; invited?: number; confirmed?: number;
  /** List responses only: the first three invitees' names. */
  people?: string[];
}

/**
 * Share sheet for a meeting link (after New meeting, on the dashboard's cards and on the meeting page):
 *  - "Link to share": who can get in with the link (straight in, or wait for the host), the link and Copy
 *  - "Share with": one tap to WhatsApp (how most people share in Africa), email, SMS, or copy the whole invite
 *  - "Invite people": a WhatsApp number or email gets a personal invite with RSVP and reminders
 * For end-to-end encrypted meetings the secret #k= key is added to the link here, in the browser, and Gather can't
 * send invites (they would lack the key), so the invite box is hidden.
 */
export function ShareSheet({ m, onChange, onInvited }: { m: MeetingDto; onChange?: (m: MeetingDto) => void; onInvited?: () => void }) {
  const url = withKey(m.url, m.slug, m.e2ee);
  const text = m.e2ee ? m.share.text.replace(m.url, url) : m.share.text;
  const enc = encodeURIComponent(text);
  const [waiting, setWaiting] = useState(m.waitingRoom);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setWaiting(m.waitingRoom), [m.waitingRoom]);

  /** Access: guests come straight in, or wait in the waiting room until the host admits them. */
  const setAccess = async (wait: boolean) => {
    setWaiting(wait);
    try { const u = await api<MeetingDto>(`/meetings/${m.id}`, { method: "PATCH", body: { waiting_room: wait } }); onChange?.(u); toast(wait ? "Guests will wait until you let them in" : "Anyone with the link can join"); }
    catch (e) { setWaiting(!wait); toast((e as ApiError).message, "error"); }
  };
  /** Send one personal invite: an "@" means email, otherwise a WhatsApp number. */
  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = to.trim();
    if (!v) return;
    setBusy(true);
    try {
      await api(`/meetings/${m.id}/invitees`, { body: { invitees: [v.includes("@") ? { email: v } : { phone: v }] } });
      toast(`Invite sent to ${v}`); setTo(""); onInvited?.();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(false); }
  };
  // Round "Share with" buttons: app links (wa.me, mailto:, sms:) or an action (copy the full invite text).
  const items = [
    { label: "WhatsApp", icon: "whatsapp", href: `https://wa.me/?text=${enc}`, cls: "bg-[#25D366] text-white" },
    { label: "Email", icon: "mail", href: `mailto:?subject=${encodeURIComponent(m.title)}&body=${enc}`, cls: "bg-sky-100 text-sky-700" },
    { label: "SMS", icon: "chat", href: `sms:?&body=${enc}`, cls: "bg-amber-100 text-amber-700" },
    { label: "Copy invite", icon: "copy", onClick: () => copy(text, "Invite copied"), cls: "bg-stone-100 text-stone-700" },
  ];

  return (
    <div className="space-y-5">
      {/* Link to share */}
      <div className="rounded-2xl bg-stone-50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 pb-3">
          <div>
            <p className="font-semibold text-stone-900">Link to share</p>
            <p className="text-sm text-stone-500">{waiting ? "Guests wait until you let them in" : "Anyone with the link can join"}</p>
          </div>
          <select value={waiting ? "wait" : "open"} onChange={(e) => setAccess(e.target.value === "wait")} aria-label="Who can get in with the link"
            className="rounded-xl bg-white px-3 py-2 text-sm font-medium text-stone-700 shadow-sm outline-none ring-1 ring-stone-200 focus:ring-brand-500">
            <option value="open">Anyone with the link</option>
            <option value="wait">Guests wait for me</option>
          </select>
        </div>
        <div className="mt-3 flex gap-2">
          <span className="min-w-0 flex-1 truncate rounded-xl bg-white px-3.5 py-2.5 font-mono text-sm text-stone-600 ring-1 ring-stone-200">{url.replace(/^https?:\/\//, "")}</span>
          <button onClick={() => copy(url)} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-white px-3.5 py-2.5 text-sm font-semibold text-stone-800 shadow-sm ring-1 ring-stone-200 hover:bg-stone-100"><Icon name="copy" size={16} />Copy</button>
        </div>
      </div>

      {/* Share with */}
      <div>
        <p className="mb-2.5 font-semibold text-stone-900">Share with</p>
        <div className="grid grid-cols-4 gap-2">
          {items.map((i) => {
            const body = <><span className={`flex h-12 w-12 items-center justify-center rounded-full transition group-hover:scale-105 ${i.cls}`}><Icon name={i.icon} size={22} /></span><span className="text-xs font-medium text-stone-600">{i.label}</span></>;
            const cls = "group flex flex-col items-center gap-1.5";
            return i.href ? <a key={i.label} href={i.href} target="_blank" rel="noreferrer" className={cls}>{body}</a>
              : <button key={i.label} onClick={i.onClick} className={cls}>{body}</button>;
          })}
        </div>
      </div>

      {/* Invite people (personal invite with RSVP and reminders) */}
      {!m.e2ee && (
        <form onSubmit={invite}>
          <p className="mb-2 font-semibold text-stone-900">Invite people</p>
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-xl border border-stone-300 bg-white pl-3 focus-within:border-brand-500">
              <Icon name={to.includes("@") ? "mail" : "whatsapp"} size={18} className="shrink-0 text-stone-400" />
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="WhatsApp number or email" aria-label="WhatsApp number or email to invite"
                className="min-w-0 flex-1 bg-transparent px-2.5 py-2.5 text-[15px] outline-none" />
            </div>
            <button disabled={busy || !to.trim()} className="flex shrink-0 items-center gap-2 rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-800 disabled:opacity-50">{busy && <Spinner size={16} />}Send invite</button>
          </div>
          <p className="mt-1.5 text-xs text-stone-500">They get a personal link with RSVP buttons, and reminders 24 hours and 15 minutes before.</p>
        </form>
      )}

      {m.e2ee && <p className="text-xs text-amber-700">End-to-end encrypted: the secret key is in this link. Share it yourself; Gather can't send it for you.</p>}
      {m.dialIn && <p className="text-xs text-stone-500">No data? Dial {m.dialIn.number}, PIN {m.dialIn.pin}</p>}
    </div>
  );
}
