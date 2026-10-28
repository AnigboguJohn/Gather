/**
 * Meeting history ("/past"): every call that happened, grouped by day (Today, Yesterday, 27 January...).
 * Top: this month's count and total time. Tabs: meetings held / cancelled. Search filters by title.
 * Each row: title, start time, who came, summary status and recordings; the call's length on the right.
 * Tapping a row opens that session (attendance, summary, transcript, recordings).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Initials, PageTitle } from "../components/Layout";
import { Empty, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { fmtTime } from "../lib/format";

/** One finished call, as /history returns it. */
interface Session {
  id: string; meeting_id: string; title: string; kind: string; repeat_rule: string; started_at: string; ended_at: string;
  end_reason: string | null; summary_status: string; attendees: number; people: string[]; recordings: number;
}
interface Cancelled { meeting_id: string; title: string; start_at: string; repeat_rule: string }

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
/** "Today", "Yesterday", or "27 January" (with the year when it isn't this year). */
function dayLabel(d: Date) {
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(d);
}
/** Minutes → "45 min" / "1 h 05 min". */
function length(mins: number) {
  if (mins < 60) return `${Math.max(1, mins)} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min`;
}
const minutesOf = (s: Session) => Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000);
// Summary status → chip text and colour.
const SUMMARY: Record<string, { text: string; cls: string }> = {
  done: { text: "Summary ready", cls: "bg-brand-50 text-brand-800" },
  running: { text: "Summarising…", cls: "bg-sky-50 text-sky-800" },
  failed: { text: "Summary failed", cls: "bg-red-50 text-red-700" },
};

/** Group a list into [label, items] by day, keeping the newest-first order. */
function byDay<T>(items: T[], date: (t: T) => Date): [string, T[]][] {
  const groups: [string, T[]][] = [];
  for (const it of items) {
    const label = dayLabel(date(it));
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(it); else groups.push([label, [it]]);
  }
  return groups;
}

export default function Past() {
  const [data, setData] = useState<{ sessions: Session[]; cancelled: Cancelled[] } | null>(null);
  const [tab, setTab] = useState<"held" | "cancelled">("held");
  const [search, setSearch] = useState<string | null>(null);
  useEffect(() => { api<{ sessions: Session[]; cancelled: Cancelled[] }>("/history").then(setData).catch(() => setData({ sessions: [], cancelled: [] })); }, []);

  // This month's calls and their total length, for the summary line.
  const month = useMemo(() => {
    const now = new Date();
    const list = (data?.sessions ?? []).filter((s) => { const d = new Date(s.started_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    return { count: list.length, minutes: list.reduce((a, s) => a + minutesOf(s), 0), name: new Intl.DateTimeFormat(undefined, { month: "long" }).format(now) };
  }, [data]);
  const match = (title: string) => !search || title.toLowerCase().includes(search.toLowerCase());
  const sessions = (data?.sessions ?? []).filter((s) => match(s.title));
  const cancelled = (data?.cancelled ?? []).filter((c) => match(c.title));

  return (
    <div>
      <PageTitle title="History" sub="Attendance, summaries, transcripts and recordings." />
      <div className="mx-auto max-w-3xl overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
        {/* Summary line + search */}
        <div className="flex items-center gap-3 border-b border-stone-100 px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon name="clock" size={20} /></span>
          {search === null ? (
            <>
              <p className="flex-1 text-stone-500">In {month.name}</p>
              <p className="text-right font-semibold text-brand-700">{month.count} meeting{month.count === 1 ? "" : "s"}{month.count > 0 && <span className="font-normal text-stone-500"> · {length(month.minutes)}</span>}</p>
              <button onClick={() => setSearch("")} className="rounded-full p-2 text-stone-500 hover:bg-stone-100" aria-label="Search history"><Icon name="search" size={18} /></button>
            </>
          ) : (
            <>
              <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by meeting name" aria-label="Search by meeting name"
                className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2 text-[15px] outline-none focus:border-brand-500" />
              <button onClick={() => setSearch(null)} className="rounded-full p-2 text-stone-500 hover:bg-stone-100" aria-label="Close search"><Icon name="x" size={18} /></button>
            </>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-stone-100 px-2" role="tablist">
          {([["held", `Meetings held${data ? ` (${sessions.length})` : ""}`], ["cancelled", `Cancelled${data ? ` (${cancelled.length})` : ""}`]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`-mb-px flex-1 border-b-2 px-3 py-3 text-xs font-semibold uppercase tracking-wide transition sm:flex-none sm:px-5 ${tab === id ? "border-brand-600 text-stone-900" : "border-transparent text-stone-400 hover:text-stone-600"}`}>{label}</button>
          ))}
        </div>

        {!data ? <div className="py-14 text-center text-brand-700"><Spinner /></div>
          : tab === "held" ? (
            !sessions.length
              ? <div className="p-5"><Empty icon="history" title={search ? "No meetings with that name" : "No past meetings yet"}>{!search && "After a call you'll find who came, the summary, the transcript and recordings here."}</Empty></div>
              : byDay(sessions, (s) => new Date(s.started_at)).map(([label, items]) => (
                <section key={label}>
                  <h2 className="bg-stone-50/80 px-5 pb-2 pt-5 text-xs font-bold uppercase tracking-wide text-stone-500">{label}</h2>
                  <ul>{items.map((s) => <SessionRow key={s.id} s={s} />)}</ul>
                </section>
              ))
          ) : (
            !cancelled.length
              ? <div className="p-5"><Empty icon="calendar" title={search ? "No cancelled meetings with that name" : "No cancelled meetings"} /></div>
              : byDay(cancelled, (c) => new Date(c.start_at)).map(([label, items]) => (
                <section key={label}>
                  <h2 className="bg-stone-50/80 px-5 pb-2 pt-5 text-xs font-bold uppercase tracking-wide text-stone-500">{label}</h2>
                  <ul>{items.map((c) => (
                    <li key={c.meeting_id}>
                      <Link to={`/meetings/${c.meeting_id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-stone-50">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500"><Icon name="calendar" size={20} /></span>
                        <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-stone-900">{c.title}</span><span className="text-sm text-stone-500">Was set for {fmtTime(c.start_at)}{c.repeat_rule === "weekly" ? " · weekly" : ""}</span></span>
                        <span className="text-sm font-semibold text-red-600">Cancelled</span>
                      </Link>
                    </li>
                  ))}</ul>
                </section>
              ))
          )}
      </div>
    </div>
  );
}

/** One finished call: icon, title, start time, faces + headcount, summary chip, recordings; the length on the right. */
function SessionRow({ s }: { s: Session }) {
  const sum = SUMMARY[s.summary_status];
  return (
    <li>
      <Link to={`/meetings/${s.meeting_id}/sessions/${s.id}`} className="flex items-center gap-4 px-5 py-4 transition hover:bg-stone-50">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon name={s.kind === "instant" ? "cam" : "calendar"} size={20} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-stone-900">{s.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-stone-500">
            <span>{fmtTime(s.started_at)}</span>
            {s.attendees > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="flex">{s.people.map((n, i) => <span key={i} title={n} className={`overflow-hidden rounded-full ring-2 ring-white ${i ? "-ml-1.5" : ""}`}><Initials name={n} size={20} /></span>)}</span>
                {s.attendees} {s.attendees === 1 ? "person" : "people"}
              </span>
            )}
            {sum && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${sum.cls}`}>{sum.text}</span>}
            {s.recordings > 0 && <span className="flex items-center gap-1 text-xs"><Icon name="record" size={13} />{s.recordings} recording{s.recordings === 1 ? "" : "s"}</span>}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-semibold text-stone-900">{length(minutesOf(s))}</span>
          {s.end_reason === "time_limit" && <span className="block text-xs text-amber-700">hit time limit</span>}
        </span>
      </Link>
    </li>
  );
}
