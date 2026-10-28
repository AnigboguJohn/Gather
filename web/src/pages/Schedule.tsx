/**
 * Schedule / edit meeting page.
 * Laptops: two columns. Left: the "Create new meeting" form, then recent meetings.
 * Right: quick-pick days, a month calendar (days with meetings have a dot) and the picked day's meetings.
 * Phones: one column: form, calendar, recent meetings.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Initials, PageTitle } from "../components/Layout";
import type { MeetingDto } from "../components/ShareSheet";
import { Button, Card, Field, Input, Select, Spinner, Toggle, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { newKey, saveKey } from "../lib/e2ee";
import { fmtTime, LANGS, localTz } from "../lib/format";

// One invitee row in the form.
interface Inv { name: string; phone: string; email: string }
const blank = (): Inv => ({ name: "", phone: "", email: "" });

const pad = (n: number) => String(n).padStart(2, "0");
/** A Date's local day as "YYYY-MM-DD" (for <input type="date"> and calendar keys). */
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A Date's local time as "HH:mm". */
const timeKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "YYYY-MM-DD" → local midnight. */
const fromDayKey = (k: string) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
/** Default start time: tomorrow at the next half hour. */
function nextHalfHour() {
  const d = new Date(Date.now() + 24 * 3600_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}
/** Every half hour of the day, for the time picker ("08:00", "08:30", ...). */
const SLOTS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);
/** "14:30" → "2:30 PM" (or "14:30", following the device's clock style). */
const slotLabel = (t: string) => fmtTime(new Date(`2000-01-01T${t}:00`));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Parse a pasted list: one person per line, "Name, 0803..., email" in any order. */
function parseBulk(text: string): Inv[] {
  return text.split(/\n+/).map((line) => {
    const parts = line.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
    const inv = blank();
    for (const p of parts) {
      if (/@/.test(p)) inv.email = p;
      else if (/^[+\d][\d\s-]{6,}$/.test(p)) inv.phone = p;
      else inv.name = inv.name ? `${inv.name} ${p}` : p;
    }
    return inv;
  }).filter((i) => i.phone || i.email);
}

/** One meeting on one day of the calendar (weekly meetings appear on every week). */
interface Occ { m: MeetingDto; at: Date; past: boolean }

/**
 * Schedule a meeting ("/schedule") or edit one ("/meetings/:id/edit").
 * The form has title, day and time, length, repeat, invitees, caption languages and (under More options) meeting settings.
 */
export default function Schedule() {
  const { id } = useParams();
  const editing = Boolean(id);
  const nav = useNavigate();
  const { me } = useAuth();
  // Form state (prefilled from the server when editing).
  const [loading, setLoading] = useState(editing);
  const [title, setTitle] = useState("");
  const start = nextHalfHour();
  const [day, setDay] = useState(dayKey(start));
  const [time, setTime] = useState(timeKey(start));
  const [duration, setDuration] = useState(60);
  const [repeat, setRepeat] = useState<"none" | "weekly">("none");
  const [langs, setLangs] = useState<string[]>([me?.user.language ?? "en"]);
  const [passcode, setPasscode] = useState("");
  const [waitingRoom, setWaitingRoom] = useState(false);
  const [openMic, setOpenMic] = useState(false);
  const [anyoneCanShare, setAnyoneCanShare] = useState(false);
  const [verifyGuests, setVerifyGuests] = useState(false);
  const [e2ee, setE2ee] = useState(false);
  const [invitees, setInvitees] = useState<Inv[]>([blank()]);
  const [bulk, setBulk] = useState("");
  const [sendSms, setSendSms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Calendar: the month on screen and the day whose meetings are listed (starts on the form's day).
  const [month, setMonth] = useState(() => { const d = fromDayKey(day); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [picked, setPicked] = useState(day);
  const [upcoming, setUpcoming] = useState<MeetingDto[] | null>(null);
  const [past, setPast] = useState<MeetingDto[] | null>(null);

  // Editing: load the meeting and fill the form.
  useEffect(() => {
    if (!id) return;
    api<MeetingDto>(`/meetings/${id}`).then((m) => {
      const at = new Date(m.startAt);
      setTitle(m.title); setDay(dayKey(at)); setTime(timeKey(at)); setDuration(m.durationMin); setRepeat(m.repeat);
      setLangs(m.languages); setWaitingRoom(m.waitingRoom); setOpenMic(m.openMic); setAnyoneCanShare(m.anyoneCanShare);
      setVerifyGuests(m.verifyGuests); setE2ee(m.e2ee);
      setPicked(dayKey(at)); setMonth(new Date(at.getFullYear(), at.getMonth(), 1));
    }).finally(() => setLoading(false));
  }, [id]);
  // Meetings for the calendar and the recent list.
  useEffect(() => {
    api<MeetingDto[]>("/meetings?scope=upcoming").then(setUpcoming).catch(() => setUpcoming([]));
    api<MeetingDto[]>("/meetings?scope=past").then(setPast).catch(() => setPast([]));
  }, []);

  // Every meeting on the calendar, keyed by day: upcoming ones (weekly ones repeated for 6 months) and past ones.
  const byDay = useMemo(() => {
    const map = new Map<string, Occ[]>();
    const add = (m: MeetingDto, at: Date, isPast: boolean) => {
      const k = dayKey(at);
      map.set(k, [...(map.get(k) ?? []), { m, at, past: isPast }]);
    };
    for (const m of upcoming ?? []) {
      const first = new Date(m.nextAt ?? m.startAt);
      if (m.repeat === "weekly") for (let i = 0; i < 26; i++) add(m, new Date(first.getTime() + i * 7 * 86400_000), false);
      else add(m, first, false);
    }
    for (const m of past ?? []) add(m, new Date(m.startAt), true);
    for (const list of map.values()) list.sort((a, b) => +a.at - +b.at);
    return map;
  }, [upcoming, past]);

  /**
   * Save. New meetings send invites straight away (the server reports per person what was sent).
   * Encrypted meetings get their secret key created here, in the browser only.
   */
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    // Invitees from the rows plus any pasted list.
    const list = [...invitees.filter((i) => i.phone || i.email), ...parseBulk(bulk)];
    const body: any = {
      title, start_at: new Date(`${day}T${time}`).toISOString(), duration_min: duration, time_zone: localTz(), repeat_rule: repeat,
      languages: langs, waiting_room: waitingRoom, open_mic: openMic, anyone_can_share: anyoneCanShare, verify_guests: verifyGuests, e2ee,
      ...(passcode ? { passcode } : {}),
    };
    try {
      if (editing) {
        await api(`/meetings/${id}`, { method: "PATCH", body });
        toast("Saved. Invitees were told about any time change.");
        nav(`/meetings/${id}`);
      } else {
        const m = await api<MeetingDto & { invites: any[] }>("/meetings", { body: { ...body, invitees: list, send_sms: sendSms } });
        if (e2ee) saveKey(m.slug, newKey());
        const sent = m.invites.filter((i) => i.result?.email === "sent" || i.result?.whatsapp === "sent").length;
        toast(list.length ? `Scheduled. Invites sent to ${sent} of ${list.length}.` : "Scheduled.");
        nav(`/meetings/${m.id}`);
      }
    } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };

  if (loading) return <div className="py-20 text-center text-brand-700"><Spinner /></div>;
  // Update one field of one invitee row.
  const setInv = (i: number, k: keyof Inv, v: string) => setInvitees((x) => x.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const today = dayKey(new Date());
  /** Pick a day on the calendar: list its meetings, and use it for the new meeting unless it's in the past. */
  const pickDay = (k: string) => {
    setPicked(k);
    if (k >= today) setDay(k);
    const d = fromDayKey(k);
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  // Quick picks above the calendar.
  const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return dayKey(d); };
  const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return dayKey(d); };
  const quick = [
    { label: "Today", k: today },
    { label: "Tomorrow", k: plusDays(1) },
    { label: "Next Monday", k: nextMonday() },
    { label: "In 2 weeks", k: plusDays(14) },
  ];
  // The time list includes the meeting's own time when editing (it may not be on the half hour).
  const slots = SLOTS.includes(time) ? SLOTS : [...SLOTS, time].sort();
  const dayMeetings = byDay.get(picked) ?? [];
  const pickedDate = fromDayKey(picked);
  const recent = (past ?? []).slice(0, 4);

  return (
    <div>
      <PageTitle title={editing ? "Edit meeting" : "Schedule a meeting"} sub={editing ? "Changing the time sends one update to everyone invited." : "Pick a day, invite people. Invites go out on WhatsApp first and email second."} />
      {/* Three cards: form (left), calendar (right, both rows), recent meetings (left, under the form) */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <form onSubmit={submit}>
          <Card className="space-y-4">
            <h2 className="text-xl font-bold text-stone-900">{editing ? "Meeting details" : "Create new meeting"}</h2>
            <Field label="Name of meeting"><Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly sales review" maxLength={120} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Day"><Input type="date" required min={editing ? undefined : today} value={day} onChange={(e) => { setDay(e.target.value); if (e.target.value) pickDay(e.target.value); }} /></Field>
              <Field label="Time"><Select value={time} onChange={(e) => setTime(e.target.value)}>{slots.map((t) => <option key={t} value={t}>{slotLabel(t)}</option>)}</Select></Field>
              <Field label="Length"><Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 30, 45, 60, 90, 120, 180, 240, 300].map((d) => <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} h`}</option>)}</Select></Field>
              <Field label="Repeat"><Select value={repeat} onChange={(e) => setRepeat(e.target.value as any)}><option value="none">Does not repeat</option><option value="weekly">Every week</option></Select></Field>
            </div>
            <p className="-mt-2 text-xs text-stone-500">Your time zone: {localTz()}. Each person sees the time in their own.</p>

            {/* Invitees (only when creating; the meeting page adds more later) */}
            {!editing && (
              <div className="space-y-2">
                <div className="flex items-center justify-between"><span className="text-sm font-medium text-stone-700">Invite people</span><span className="text-xs text-stone-500">WhatsApp number, email, or both</span></div>
                {invitees.map((inv, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-xl bg-stone-50 p-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:bg-transparent sm:p-0">
                    <Input placeholder="Name" value={inv.name} onChange={(e) => setInv(i, "name", e.target.value)} />
                    <button type="button" onClick={() => setInvitees((x) => x.length > 1 ? x.filter((_, j) => j !== i) : [blank()])} className="rounded-xl p-2 text-stone-400 hover:bg-stone-100 hover:text-red-600 sm:order-last" aria-label="Remove"><Icon name="x" /></button>
                    <Input placeholder="WhatsApp 0803..." type="tel" value={inv.phone} onChange={(e) => setInv(i, "phone", e.target.value)} className="col-span-2 sm:col-span-1" />
                    <Input placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv(i, "email", e.target.value)} className="col-span-2 sm:col-span-1" />
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="ghost" icon="plus" onClick={() => setInvitees((x) => [...x, blank()])}>Add person</Button>
                  <details className="min-w-0 flex-1 text-sm">
                    <summary className="cursor-pointer py-2 font-medium text-stone-600">Paste a list</summary>
                    <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={4} className="mt-1 w-full rounded-xl border border-stone-300 p-2 font-mono text-xs" placeholder={"Tolu Ade, 0803 111 2222\nAmina Bello, amina@acme.ng"} />
                    {bulk && <p className="mt-1 text-xs text-stone-500">{parseBulk(bulk).length} people found (one per line)</p>}
                  </details>
                </div>
                {!me?.integrations.whatsapp && <p className="text-xs text-stone-500">WhatsApp sending isn't connected on this server, so after scheduling you'll get one-tap WhatsApp links to send each invite yourself. Emails go out automatically.</p>}
              </div>
            )}

            <Field label="Caption languages" hint="People can also pick their own language when they join.">
              <div className="flex flex-wrap gap-1.5">
                {LANGS.map((l) => {
                  const on = langs.includes(l.id);
                  return <button type="button" key={l.id} onClick={() => setLangs(on ? (langs.length > 1 ? langs.filter((x) => x !== l.id) : langs) : [...langs, l.id])}
                    className={`rounded-full border px-3 py-1 text-sm font-medium ${on ? "border-brand-600 bg-brand-50 text-brand-800" : "border-stone-300 text-stone-600"}`}>{on && "✓ "}{l.name}</button>;
                })}
              </div>
            </Field>

            {/* Meeting settings, folded away: most meetings keep the defaults */}
            <details className="rounded-xl border border-stone-200 px-3" open={editing}>
              <summary className="cursor-pointer py-2.5 text-sm font-semibold text-stone-700">More options <span className="font-normal text-stone-500">· passcode, waiting room, open mic, encryption</span></summary>
              <div className="divide-y divide-stone-100 pb-2">
                <div className="py-2"><Field label="Passcode (optional)" hint={editing ? "Leave empty to keep the current one." : "4–12 letters or digits"}><Input value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="e.g. 4821" maxLength={12} /></Field></div>
                <Toggle checked={waitingRoom} onChange={setWaitingRoom} label="Waiting room" hint="You admit each guest." />
                <Toggle checked={openMic} onChange={setOpenMic} label="Open mic" hint="Guests can talk without raising a hand." />
                <Toggle checked={anyoneCanShare} onChange={setAnyoneCanShare} label="Anyone can share their screen" hint="Skip share approval for trusted calls." />
                <Toggle checked={verifyGuests} onChange={setVerifyGuests} label="Check guests' email with a code" hint="For sensitive meetings." />
                <Toggle checked={e2ee} onChange={setE2ee} disabled={editing} label="End-to-end encryption" hint="Only people with the secure link can see or hear. Turns off captions, summaries and recording." />
                {!editing && me?.integrations.sms && <Toggle checked={sendSms} onChange={setSendSms} label="Also send SMS" hint="For people without WhatsApp. SMS costs money per message." />}
              </div>
            </details>

            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button loading={busy} icon={editing ? "check" : "calendar"} className="w-full">{editing ? "Save changes" : "Schedule and invite"}</Button>
            {editing && <button type="button" onClick={() => nav(-1)} className="w-full text-sm text-stone-500 hover:text-stone-800">Cancel</button>}
          </Card>
        </form>

        {/* ---------------- Right: calendar and the picked day's meetings ---------------- */}
        <Card className="space-y-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
            {quick.map((q) => (
              <button key={q.label} type="button" onClick={() => pickDay(q.k)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold ${picked === q.k ? "bg-brand-50 text-brand-800 ring-1 ring-brand-300" : "bg-stone-100 text-stone-600 hover:bg-stone-200"}`}>{q.label}</button>
            ))}
          </div>
          <MonthCalendar month={month} setMonth={setMonth} picked={picked} today={today} hasMeetings={(k) => byDay.has(k)} onPick={pickDay} />

          <div>
            <h3 className="mb-3 font-bold text-stone-900">
              {picked === today ? "Today's meetings" : `Meetings on ${new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(pickedDate)}`}
            </h3>
            {!upcoming || !past ? <div className="py-6 text-center text-brand-700"><Spinner /></div>
              : !dayMeetings.length ? (
                <div className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
                  Nothing on this day.{picked >= today && <> The new meeting will be on this day.</>}
                </div>
              )
              : <div className="space-y-2.5">{dayMeetings.map((o) => (
                <MeetingRow key={`${o.m.id}-${+o.at}`} m={o.m} at={o.at}
                  action={o.past
                    ? <Link to={`/meetings/${o.m.id}`} className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50">Summary</Link>
                    : <Link to={`/j/${o.m.slug}`} className="shrink-0 rounded-lg border border-stone-300 bg-white px-4 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-50">{o.m.live ? "Join" : "Start"}</Link>} />
              ))}</div>}
          </div>
        </Card>

        {/* Recent meetings: what happened lately, with a link to each summary */}
        <Card className="space-y-3 lg:col-start-1">
          <div className="flex items-center justify-between"><h2 className="text-xl font-bold text-stone-900">Recent meetings</h2><Link to="/past" className="text-sm font-semibold text-brand-700 hover:underline">See all</Link></div>
          {!past ? <div className="py-6 text-center text-brand-700"><Spinner /></div>
            : !recent.length ? <p className="py-4 text-sm text-stone-500">No past meetings yet. Summaries and recordings will show here.</p>
            : recent.map((m, i) => (
              <MeetingRow key={m.id} m={m} at={new Date(m.startAt)} tint={["bg-sky-50", "bg-amber-50", "bg-emerald-50", "bg-rose-50"][i % 4]}
                action={<Link to={`/meetings/${m.id}`} className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50">View summary</Link>} />
            ))}
        </Card>
      </div>
    </div>
  );
}

/**
 * Month grid, Monday first. Today has an outline, the picked day is filled, days with meetings get a dot.
 * « » jump a year, ‹ › a month. Days from the next/previous month are shown faded.
 */
function MonthCalendar({ month, setMonth, picked, today, hasMeetings, onPick }: {
  month: Date; setMonth: (d: Date) => void; picked: string; today: string; hasMeetings: (k: string) => boolean; onPick: (k: string) => void;
}) {
  // Start on the Monday on or before the 1st; always 6 rows so the card doesn't jump.
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - startOffset + i));
  const shift = (months: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + months, 1));
  const navBtn = "flex h-7 w-7 items-center justify-center rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-100";
  return (
    <div>
      <div className="mb-3 flex items-center gap-1.5">
        <button type="button" onClick={() => shift(-12)} className={navBtn} aria-label="Previous year">«</button>
        <button type="button" onClick={() => shift(-1)} className={navBtn} aria-label="Previous month">‹</button>
        <p className="flex-1 text-center text-sm font-semibold text-stone-800">{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month)}</p>
        <button type="button" onClick={() => shift(1)} className={navBtn} aria-label="Next month">›</button>
        <button type="button" onClick={() => shift(12)} className={navBtn} aria-label="Next year">»</button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
        {WEEKDAYS.map((w) => <span key={w} className="pb-1 text-xs font-medium text-stone-500">{w}</span>)}
        {days.map((d) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === month.getMonth();
          const isPicked = k === picked;
          return (
            <button key={k} type="button" onClick={() => onPick(k)} aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(d)} aria-pressed={isPicked}
              className={`relative mx-auto flex h-9 w-9 items-center justify-center rounded-lg transition
                ${isPicked ? "bg-brand-600 font-semibold text-white" : k === today ? "font-semibold text-brand-700 ring-1 ring-brand-500" : inMonth ? "text-stone-800 hover:bg-stone-100" : "text-stone-300 hover:bg-stone-50"}`}>
              {d.getDate()}
              {hasMeetings(k) && <span className={`absolute bottom-1 h-1 w-1 rounded-full ${isPicked ? "bg-white" : "bg-clay-500"}`} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One meeting in a list: a "23 / Mon" date badge, title, time range and length, invitee faces, and an action button. */
function MeetingRow({ m, at, action, tint = "bg-stone-50" }: { m: MeetingDto; at: Date; action: React.ReactNode; tint?: string }) {
  const end = new Date(at.getTime() + m.durationMin * 60_000);
  const faces = m.people?.length ? m.people : [m.host.name];
  const more = Math.max(0, (m.invited ?? 0) - faces.length);
  return (
    <div className={`flex items-center gap-3 rounded-xl p-3 ${tint}`}>
      <div className="flex w-12 shrink-0 flex-col items-center rounded-lg bg-white py-1.5 leading-tight shadow-sm">
        <b className="text-sm text-stone-900">{at.getDate()}</b>
        <span className="text-[11px] text-stone-500">{new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-stone-900">{m.title}{m.repeat === "weekly" && <span className="ml-1.5 text-[10px] font-medium text-stone-500">weekly</span>}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500">
          <span>{fmtTime(at)} to {fmtTime(end)}</span>
          <span className="flex items-center gap-0.5"><Icon name="clock" size={11} />{m.durationMin < 60 ? `${m.durationMin} min` : `${m.durationMin / 60} h`}</span>
          <span className="flex items-center">
            {faces.map((n, i) => <span key={i} title={n} className={`rounded-full ring-2 ring-white ${i ? "-ml-1.5" : ""}`}><Initials name={n} size={18} /></span>)}
            {more > 0 && <span className="ml-1 font-semibold">+{more}</span>}
          </span>
        </div>
      </div>
      {action}
    </div>
  );
}
