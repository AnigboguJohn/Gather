/** "Ask your meetings": a chat with the Gather assistant, which answers from past meetings' captions and chat. */
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { PageTitle } from "../components/Layout";
import { api, ApiError } from "../lib/api";
import { fmtDate, fmtTime } from "../lib/format";

// Example questions in the assistant's welcome message.
const EXAMPLES = ["What did we decide about the Lagos launch?", "Who is sending the price list?", "When is the next delivery?"];

/** One quoted line from a meeting that an answer relies on (M1, M2...). */
interface Passage { ref: string; meeting: string; meetingId: string; sessionId: string; date: string; speaker: string; text: string }
/** One message in the chat: my question, or the assistant's answer with its sources (or an error). */
type Msg =
  | { id: number; who: "me"; text: string; at: Date }
  | { id: number; who: "bot"; text: string; at: Date; sources: Passage[]; error?: boolean };

/**
 * Ask ("/search"): ask in your own words; the server finds matching lines in captions and chat from past meetings
 * and the AI answers with numbered sources that link back to the call. Each question is answered on its own.
 * "?q=" (from the dashboard's search box) asks straight away.
 */
export default function Search() {
  const [params] = useSearchParams();
  const [q, setQ] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const ask = async (question: string) => {
    const text = question.trim();
    if (text.length < 3 || busy) return;
    setQ(""); setBusy(true);
    setMsgs((m) => [...m, { id: nextId.current++, who: "me", text, at: new Date() }]);
    try {
      const r = await api<{ answer: string; citations?: string[]; passages?: Passage[] }>("/search", { body: { question: text } });
      // Show only the passages the answer cited (or all if it cited none).
      const sources = (r.passages ?? []).filter((p) => !r.citations?.length || r.citations.includes(p.ref));
      setMsgs((m) => [...m, { id: nextId.current++, who: "bot", text: r.answer, at: new Date(), sources }]);
    } catch (e) {
      setMsgs((m) => [...m, { id: nextId.current++, who: "bot", text: (e as ApiError).message, at: new Date(), sources: [], error: true }]);
    } finally { setBusy(false); }
  };
  useEffect(() => { const pre = params.get("q"); if (pre) ask(pre); }, [params]);
  // Keep the newest message in view.
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs.length, busy]);

  return (
    <div>
      <PageTitle title="Ask your meetings" sub="Ask in your own words. Answers come from captions and chat, with sources." />
      <div className="mx-auto flex h-[calc(100vh-16rem)] min-h-[30rem] max-w-3xl flex-col overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm md:h-[calc(100vh-14rem)]">
        {/* Header: the assistant */}
        <div className="flex items-center gap-4 border-b border-stone-100 px-5 py-4">
          <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white">
            <Icon name="sparkle" size={22} />
            <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-white" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold text-stone-900">Gather assistant</p>
            <p className="truncate text-sm text-stone-500">Reads what was said in your past meetings</p>
          </div>
          {msgs.length > 0 && <button onClick={() => setMsgs([])} aria-label="New chat" className="flex shrink-0 items-center gap-1.5 rounded-xl border border-stone-200 p-2 text-sm font-medium text-stone-600 hover:bg-stone-50 sm:px-3 sm:py-1.5"><Icon name="refresh" size={14} /><span className="hidden sm:inline">New chat</span></button>}
        </div>

        {/* Messages */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-stone-50 px-4 py-5 sm:px-6">
          <BotBubble>
            <p>👋 Hi! Ask me anything that was said in your meetings: decisions, who's doing what, dates, prices.</p>
            {!msgs.length && (
              <div className="mt-3 flex flex-wrap gap-2">
                {EXAMPLES.map((e) => <button key={e} onClick={() => ask(e)} className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-left text-sm text-brand-800 hover:bg-brand-100">{e}</button>)}
              </div>
            )}
          </BotBubble>
          {msgs.map((m) => m.who === "me" ? (
            <div key={m.id} className="flex flex-col items-end">
              <span className="mb-1 text-xs text-stone-400">You · {fmtTime(m.at)}</span>
              <p className="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-tr-lg bg-brand-700 px-4 py-3 text-[15px] leading-relaxed text-white">{m.text}</p>
            </div>
          ) : (
            <BotBubble key={m.id} error={m.error} at={m.at}>
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.sources.length > 0 && (
                <div className="mt-3 border-t border-stone-100 pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{m.sources.length} source{m.sources.length === 1 ? "" : "s"}</p>
                  <ul className="space-y-2">
                    {m.sources.map((p) => (
                      <li key={p.ref}>
                        <Link to={`/meetings/${p.meetingId}/sessions/${p.sessionId}`} className="block rounded-2xl bg-stone-50 p-3 text-sm ring-1 ring-stone-100 transition hover:ring-brand-300">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="rounded-md bg-brand-100 px-1.5 font-mono text-xs font-semibold text-brand-800">{p.ref}</span>
                            <span className="font-semibold text-stone-900">{p.meeting}</span>
                            <span className="text-xs text-stone-500">{fmtDate(p.date)} · {p.speaker}</span>
                          </span>
                          <span className="mt-1 block text-stone-600">“{p.text}”</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </BotBubble>
          ))}
          {/* Typing dots while the answer is on its way */}
          {busy && (
            <BotBubble>
              <span className="flex gap-1 py-1" aria-label="Thinking">
                {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-stone-400" style={{ animationDelay: `${i * 150}ms` }} />)}
              </span>
            </BotBubble>
          )}
          <div ref={end} />
        </div>

        {/* Write a question */}
        <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex items-center gap-2 border-t border-stone-100 bg-white p-3 sm:p-4">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your meetings…" aria-label="Your question" maxLength={300}
            className="min-w-0 flex-1 rounded-full bg-stone-100 px-5 py-3 text-[15px] outline-none ring-brand-500 placeholder:text-stone-400 focus:bg-white focus:ring-2" />
          <button disabled={busy || q.trim().length < 3} aria-label="Ask"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white transition hover:bg-brand-800 disabled:bg-stone-300">
            <Icon name="arrow" size={20} />
          </button>
        </form>
      </div>
      <p className="mx-auto mt-3 max-w-3xl text-center text-xs text-stone-500">Only meetings with captions on can be searched. Each question is answered on its own; end-to-end encrypted meetings are never read.</p>
    </div>
  );
}

/** An assistant message: small avatar and name above a white bubble. */
function BotBubble({ children, error, at }: { children: React.ReactNode; error?: boolean; at?: Date }) {
  return (
    <div className="flex flex-col items-start">
      <span className="mb-1.5 flex items-center gap-2 text-sm text-stone-600">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-700 text-white"><Icon name="sparkle" size={14} /></span>
        Gather assistant{at && <span className="text-xs text-stone-400">· {fmtTime(at)}</span>}
      </span>
      <div className={`ml-9 max-w-[85%] rounded-3xl rounded-tl-lg px-4 py-3 text-[15px] leading-relaxed shadow-sm ${error ? "bg-red-50 text-red-700" : "bg-white text-stone-800"}`}>{children}</div>
    </div>
  );
}
