/** Meeting detail page for hosts. */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { ShareSheet, type MeetingDto } from "../components/ShareSheet";
import { Badge, Button, Card, Empty, Input, Modal, Spinner, toast } from "../components/ui";
import { api, ApiError, getToken } from "../lib/api";
import { fmtDuration, fmtWhen, langName, relative } from "../lib/format";

/** The meeting page data: the meeting plus invitees, past sessions and the log of messages sent. */
interface Detail extends MeetingDto {
  invitees: { id: string; name: string | null; email: string | null; phone: string | null; rsvp: "pending" | "yes" | "no"; url: string; whatsappLink: string | null }[];
  sessions: { id: string; started_at: string; ended_at: string | null; end_reason: string | null; summary_status: string; attendees: number; recordings: number }[];
  notifications: { channel: string; to_addr: string; kind: string; status: string; detail: string | null; created_at: string }[];
  whatsappApi: boolean;
}

/** Meeting page ("/meetings/:id"): share link, invitees and RSVPs, past sessions, and delivery log. */
export default function MeetingDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [m, setM] = useState<Detail | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const load = () => api<Detail>(`/meetings/${id}`).then(setM).catch((e) => { toast((e as ApiError).message, "error"); nav("/home"); });
  useEffect(() => { load(); }, [id]);
  // Keep the page fresh while a call is live or a summary is being written.
  const busy = Boolean(m && (m.live || m.sessions.some((s) => !s.ended_at || s.summary_status === "running" || (s.summary_status === "none" && Date.now() - +new Date(s.ended_at!) < 120_000))));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [busy, id]);
  if (!m) return <div className="py-20 text-center text-brand-700"><Spinner /></div>;

  // Ended or cancelled meetings are read-only.
  const over = m.status === "ended" || m.status === "cancelled";
  const when = m.nextAt ?? m.startAt;
  /** Download the calendar file (needs the auth header, so fetch + blob instead of a plain link). */
  const downloadIcs = async () => {
    const r = await fetch(`/api/meetings/${m.id}/ics`, { headers: { authorization: `Bearer ${getToken()}` } });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob()); a.download = `${m.slug}.ics`; a.click();
  };

  return (
    <div className="space-y-5">
      <Link to="/home" className="inline-flex items-center gap-1 text-sm font-medium text-stone-500 hover:text-stone-800"><Icon name="back" size={16} />Meetings</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">{m.title}</h1>
            {m.live && <Badge tone="green">● Live · {m.live.people} in the call{m.live.waiting ? ` · ${m.live.waiting} waiting` : ""}</Badge>}
            {m.status === "cancelled" && <Badge tone="red">Cancelled</Badge>}
            {m.status === "ended" && <Badge>Ended</Badge>}
            {m.e2ee && <Badge tone="blue"><Icon name="shield" size={12} />Encrypted</Badge>}
          </div>
          <p className="mt-1 text-stone-500">
            {m.kind === "instant" ? "Meet now room" : `${fmtWhen(when)} (${relative(when)}) · ${m.durationMin} min${m.repeat === "weekly" ? " · every week" : ""}`}
          </p>
          <p className="mt-1 text-sm text-stone-500">Captions: {m.languages.map(langName).join(", ")}{m.hasPasscode ? " · passcode" : ""}{m.waitingRoom ? " · waiting room" : ""}{m.openMic ? " · open mic" : ""}</p>
        </div>
        {!over && (
          <div className="flex flex-wrap gap-2">
            <Link to={`/j/${m.slug}`} className="inline-flex items-center gap-2 rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800"><Icon name="cam" size={18} />Join</Link>
            {m.kind === "scheduled" && <Button variant="secondary" icon="edit" onClick={() => nav(`/meetings/${m.id}/edit`)}>Edit</Button>}
            {m.kind === "scheduled" && <Button variant="secondary" icon="calendar" onClick={downloadIcs}>.ics</Button>}
            <Button variant="ghost" icon="trash" onClick={() => setConfirmCancel(true)}>Cancel</Button>
          </div>
        )}
      </div>

      {/* Share */}
      {!over && <Card><h2 className="mb-4 text-lg font-bold">Share and invite</h2><ShareSheet m={m} onChange={load} onInvited={load} /></Card>}

      {/* Invitees with RSVP status; one-tap WhatsApp send when the WhatsApp API isn't set up */}
      {m.kind === "scheduled" && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold">Invited ({m.invitees.length}) · {m.invitees.filter((i) => i.rsvp === "yes").length} attending</h2>
            {!over && <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>Invite</Button>}
          </div>
          {!m.invitees.length ? <p className="text-sm text-stone-500">Nobody invited directly yet. Share the link above, or invite people so they get reminders.</p> : (
            <ul className="divide-y divide-stone-100">
              {m.invitees.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{i.name || i.email || i.phone}</p>
                    <p className="truncate text-xs text-stone-500">{[i.phone, i.email].filter(Boolean).join(" · ")}</p>
                  </div>
                  <Badge tone={i.rsvp === "yes" ? "green" : i.rsvp === "no" ? "red" : "stone"}>{i.rsvp === "yes" ? "Attending" : i.rsvp === "no" ? "Can't make it" : "No reply"}</Badge>
                  {!over && i.whatsappLink && !m.whatsappApi && <a href={i.whatsappLink} target="_blank" rel="noreferrer" className="rounded-lg bg-[#25D366] px-2.5 py-1.5 text-xs font-semibold text-white" title="Open WhatsApp with this invite ready to send">Send on WhatsApp</a>}
                  {!over && <button className="text-xs font-medium text-stone-500 hover:text-brand-700" onClick={async () => { await api(`/meetings/${m.id}/invitees/${i.id}/resend`, { method: "POST" }); toast("Invite sent again"); load(); }}>Resend</button>}
                  {!over && <button className="text-stone-400 hover:text-red-600" aria-label="Remove" onClick={async () => { await api(`/meetings/${m.id}/invitees/${i.id}`, { method: "DELETE" }); load(); }}><Icon name="x" size={16} /></button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        {/* Each time the room was used: attendance count, length, summary status */}
        <h2 className="mb-3 font-bold">Past sessions</h2>
        {!m.sessions.length ? <Empty icon="history" title="Not used yet">After the meeting you'll find attendance, the summary, transcript and recordings here.</Empty> : (
          <ul className="divide-y divide-stone-100">
            {m.sessions.map((s) => (
              <li key={s.id}>
                <Link to={`/meetings/${m.id}/sessions/${s.id}`} className="flex flex-wrap items-center gap-3 py-3 hover:text-brand-700">
                  <span className="flex-1 font-medium">{fmtWhen(s.started_at)}</span>
                  <span className="text-sm text-stone-500">{s.attendees} people · {s.ended_at ? fmtDuration((+new Date(s.ended_at) - +new Date(s.started_at)) / 1000) : "live now"}</span>
                  {s.end_reason === "time_limit" && <Badge tone="amber">Hit plan limit</Badge>}
                  <Badge tone={s.summary_status === "done" ? "green" : s.summary_status === "failed" ? "red" : "stone"}>{s.summary_status === "done" ? "Summary sent" : s.summary_status === "running" ? "Summarising" : s.summary_status === "failed" ? "Summary failed" : "—"}</Badge>
                  <Icon name="arrow" size={16} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Delivery log: every invite, reminder and summary with its status */}
      {m.notifications.length > 0 && (
        <Card>
          <h2 className="mb-3 font-bold">Messages sent</h2>
          <ul className="space-y-1.5 text-sm">
            {m.notifications.slice(0, 30).map((n, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Icon name={n.channel === "whatsapp" ? "whatsapp" : n.channel === "sms" ? "chat" : "mail"} size={15} className="text-stone-400" />
                <span className="text-stone-600">{n.kind} → {n.to_addr}</span>
                <Badge tone={n.status === "sent" ? "green" : n.status === "failed" ? "red" : "stone"}>{n.status}</Badge>
                {n.status !== "sent" && n.detail && <span className="text-xs text-stone-400">{n.detail}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AddInvitees open={adding} onClose={() => setAdding(false)} meetingId={m.id} onDone={load} />
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this meeting?">
        <p className="text-sm text-stone-600">Everyone invited gets a short notice and the link stops working.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmCancel(false)}>Keep it</Button>
          <Button variant="danger" onClick={async () => { await api(`/meetings/${m.id}/cancel`, { method: "POST" }); toast("Cancelled. Invitees were told."); setConfirmCancel(false); load(); }}>Cancel meeting</Button>
        </div>
      </Modal>
    </div>
  );
}

/** Dialog to invite one more person (WhatsApp number and/or email); the server sends the invite at once. */
function AddInvitees({ open, onClose, meetingId, onDone }: { open: boolean; onClose: () => void; meetingId: string; onDone: () => void }) {
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Invite someone">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          await api(`/meetings/${meetingId}/invitees`, { body: { invitees: [{ name, phone, email }] } });
          toast("Invite sent"); setName(""); setPhone(""); setEmail(""); onClose(); onDone();
        } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }}>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="WhatsApp number" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button className="w-full" loading={busy}>Send invite</Button>
      </form>
    </Modal>
  );
}
