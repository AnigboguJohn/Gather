/** Session history page for hosts. */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, Spinner, toast } from "../components/ui";
import { api, getToken } from "../lib/api";
import { fmtDuration, fmtTime, fmtWhen, langName } from "../lib/format";

/**
 * One past session ("/meetings/:id/sessions/:sid"): summary, attendance (+ CSV), transcript, chat, polls, recordings.
 * Polls the server while the meeting is live or the summary is still being written.
 */
export default function SessionDetail() {
  const { id, sid } = useParams();
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<"summary" | "people" | "transcript" | "chat" | "polls" | "recordings">("summary");
  const load = () => api(`/meetings/${id}/sessions/${sid}`).then(setD);
  useEffect(() => { load(); }, [id, sid]);
  useEffect(() => {
    if (d?.session?.summary_status !== "running" && d?.session?.ended_at) return;
    const t = setInterval(load, 5000); return () => clearInterval(t);
  }, [d?.session?.summary_status, d?.session?.ended_at]);
  if (!d) return <div className="py-20 text-center text-brand-700"><Spinner /></div>;
  const s = d.session;
  // A failed summary is stored as { error }, so only show real summaries.
  const sum = s.summary && !s.summary.error ? s.summary : null;

  /** Download attendance as CSV (authenticated fetch → file). */
  const csv = async () => {
    const r = await fetch(`/api/meetings/${id}/sessions/${sid}/attendance.csv`, { headers: { authorization: `Bearer ${getToken()}` } });
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `attendance-${d.meeting.slug}.csv`; a.click();
  };
  const tabs = [["summary", "Summary"], ["people", `Attendance (${d.participants.length})`], ["transcript", "Transcript"], ["chat", `Chat (${d.chat.length})`], ["polls", `Polls (${d.polls.length})`], ["recordings", `Recordings (${d.recordings.length})`]] as const;

  return (
    <div className="space-y-5">
      <Link to={`/meetings/${id}`} className="inline-flex items-center gap-1 text-sm font-medium text-stone-500 hover:text-stone-800"><Icon name="back" size={16} />{d.meeting.title}</Link>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{fmtWhen(s.started_at)}</h1>
        <p className="text-stone-500">{s.ended_at ? `Lasted ${fmtDuration((+new Date(s.ended_at) - +new Date(s.started_at)) / 1000)}` : "Live now"}{s.end_reason === "time_limit" ? " · ended at the plan's time limit" : ""}</p>
      </div>
      <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4">
        {tabs.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold ${tab === k ? "bg-stone-900 text-white" : "bg-white text-stone-600 border border-stone-200"}`}>{label}</button>)}
      </div>

      {tab === "summary" && (
        <Card className="space-y-4">
          {s.summary_status === "running" && <p className="flex items-center gap-2 text-brand-700"><Spinner size={16} />Writing the summary…</p>}
          {s.summary_status === "failed" && <div className="flex items-center gap-3"><Badge tone="red">Summary failed</Badge><Button variant="secondary" icon="refresh" onClick={async () => { await api(`/meetings/${id}/sessions/${sid}/summary/retry`, { method: "POST" }); toast("Retrying"); load(); }}>Try again</Button></div>}
          {!s.ended_at && <p className="text-stone-500">The summary is written when the meeting ends.</p>}
          {sum && (
            <>
              <p className="text-[15px] leading-relaxed">{sum.summary}</p>
              {sum.decisions?.length > 0 && <div><h3 className="mb-1 font-bold">Decisions</h3><ul className="list-disc space-y-1 pl-5">{sum.decisions.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
              {sum.action_items?.length > 0 && <div><h3 className="mb-1 font-bold">Action items</h3><ul className="space-y-1.5">{sum.action_items.map((a: any, i: number) => <li key={i} className="flex gap-2"><Icon name="check" size={18} className="mt-0.5 shrink-0 text-brand-600" /><span><b>{a.owner}:</b> {a.task}{a.due ? <span className="text-stone-500"> (by {a.due})</span> : null}</span></li>)}</ul></div>}
              <p className="text-xs text-stone-400">Sent to everyone who left a contact, in their language ({Object.keys(sum.by_language ?? {}).map(langName).join(", ")}). Engine: {sum.engine}.</p>
            </>
          )}
        </Card>
      )}
      {tab === "people" && (
        <Card>
          <div className="mb-3 flex justify-end"><Button variant="secondary" icon="download" onClick={csv}>Download CSV</Button></div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-stone-500"><tr><th className="py-2 pr-3">Name</th><th className="pr-3">Contact</th><th className="pr-3">Language</th><th className="pr-3">Joined</th><th className="pr-3">Left</th><th>Time</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {d.participants.map((p: any, i: number) => (
                  <tr key={i}><td className="py-2 pr-3 font-medium">{p.name} {p.role !== "guest" && <Badge tone="green">{p.role}</Badge>} {p.via === "phone" && <Badge>phone</Badge>} {p.verified && <Badge tone="blue">verified</Badge>}</td>
                    <td className="pr-3 text-stone-600">{p.email || p.phone || "—"}</td><td className="pr-3">{langName(p.language)}</td>
                    <td className="pr-3">{fmtTime(p.joined_at)}</td><td className="pr-3">{p.left_at ? fmtTime(p.left_at) : "—"}</td><td>{fmtDuration(p.seconds)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === "transcript" && (
        <Card>{!d.transcript.length ? <p className="text-stone-500">No captions were captured in this meeting.</p> : (
          <ul className="space-y-2.5 text-sm">{d.transcript.map((t: any, i: number) => (
            <li key={i}><span className="text-xs text-stone-400">{fmtTime(t.created_at)}</span> <b>{t.speaker_name}</b> <span className="text-xs text-stone-400">({langName(t.lang)})</span>: {t.text}{t.english && t.lang !== "en" && <span className="block pl-4 text-stone-500">EN: {t.english}</span>}</li>
          ))}</ul>)}
        </Card>
      )}
      {tab === "chat" && <Card>{!d.chat.length ? <p className="text-stone-500">No chat messages.</p> : <ul className="space-y-2 text-sm">{d.chat.map((c: any, i: number) => <li key={i}><span className="text-xs text-stone-400">{fmtTime(c.created_at)}</span> <b>{c.sender_name}</b>: {c.text}</li>)}</ul>}</Card>}
      {tab === "polls" && <Card>{!d.polls.length ? <p className="text-stone-500">No polls.</p> : d.polls.map((p: any) => {
        const total = p.results.reduce((a: number, r: any) => a + r.votes, 0);
        return <div key={p.id} className="mb-5"><p className="font-bold">{p.question}</p>{p.options.map((o: string, i: number) => { const n = p.results.find((r: any) => r.option === i)?.votes ?? 0; return <div key={i} className="mt-1.5"><div className="flex justify-between text-sm"><span>{o}</span><span>{n}</span></div><div className="h-2 rounded bg-stone-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></div></div>; })}</div>;
      })}</Card>}
      {tab === "recordings" && <Card>{!d.recordings.length ? <p className="text-stone-500">No recordings. Hosts on Pro or Business can record from the call's More menu.</p> : d.recordings.map((r: any) => <Recording key={r.id} r={r} />)}</Card>}
    </div>
  );
}

/** A recording player: asks the server for a short-lived signed link, then plays it in a <video>. */
function Recording({ r }: { r: any }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { api(`/recordings/${r.id}/link`).then((x) => setUrl(x.url)); }, [r.id]);
  return (
    <div className="mb-4">
      <p className="mb-1 text-sm text-stone-500">{fmtWhen(r.created_at)} · {(r.size_bytes / 1e6).toFixed(1)} MB</p>
      {url ? <video src={url} controls className="w-full rounded-xl bg-black" preload="metadata" /> : <Spinner />}
      {url && <a href={url} download className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand-700"><Icon name="download" size={14} />Download</a>}
    </div>
  );
}
