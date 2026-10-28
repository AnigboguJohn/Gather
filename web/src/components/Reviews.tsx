/**
 * Reviews of Gather: the rating form (end of a first meeting, and the /review/:token link), star rows,
 * review cards, the Trustpilot-style score summary, and a hook that keeps reviews live on open pages.
 *
 * Rating form (after the references): a pill track that fills with colour as you pick (red → amber → green),
 * stars that pop in while unpicked ones wait as dots, the word for the score (Bad … Excellent), "What did you like
 * the most?" chips (or "What went wrong?" for low scores), a comment box with a counter, "Remain anonymous",
 * and Not now / Submit. variant="call" is drawn dark (the call screen's light switch re-colours it);
 * variant="page" is a white card for normal pages.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "./Icon";

export interface PublicReview { id: string; rating: number; tags: string[]; comment: string | null; name: string; role: "Host" | "Guest"; via: string; createdAt: string }
export interface ReviewSummary { score: number; count: number; label: string | null; dist: { stars: number; count: number }[] }
export type ReviewTags = { good: string[]; bad: string[] };
export interface ReviewInput { rating: number; tags: string[]; comment?: string; anonymous: boolean }

/** The word for each score, Trustpilot style, with a face. */
export const WORDS = ["", "Bad", "Poor", "Average", "Great", "Excellent"];
const FACES = ["", "😞", "😕", "😐", "🙂", "🤩"];
/** Track colour by score: red for bad through amber to green. */
const FILL = ["", "from-red-600 to-red-500", "from-orange-600 to-orange-400", "from-amber-500 to-yellow-400", "from-lime-600 to-brand-500", "from-brand-600 to-emerald-400"];
/** Trustpilot box colours per score. */
export const BOX = ["#dcdce6", "#ff3722", "#ff8622", "#ffce00", "#73cf11", "#00b67a"];

const STAR = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z";

/** A row of stars that can show fractions (4.7 → four and seven tenths). */
export function Stars({ value, size = 16, className = "text-amber-400", empty = "text-stone-300" }: { value: number; size?: number; className?: string; empty?: string }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const f = Math.max(0, Math.min(1, value - i));
        return (
          <span key={i} className="relative inline-block" style={{ width: size, height: size }}>
            <svg viewBox="0 0 24 24" width={size} height={size} className={`absolute inset-0 ${empty}`} fill="currentColor"><path d={STAR} /></svg>
            {f > 0 && <span className="absolute inset-0 overflow-hidden" style={{ width: `${f * 100}%` }}><svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="currentColor"><path d={STAR} /></svg></span>}
          </span>
        );
      })}
    </span>
  );
}

/** Trustpilot-style square boxes with white stars, coloured by the score (the last box can be part-filled). */
export function StarBoxes({ value, size = 28 }: { value: number; size?: number }) {
  const colour = BOX[Math.max(1, Math.round(value))] ?? BOX[5];
  return (
    <span className="inline-flex gap-[3px]" role="img" aria-label={`${value} out of 5 stars`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const f = Math.max(0, Math.min(1, value - i));
        return (
          <span key={i} className="relative inline-flex items-center justify-center" style={{ width: size, height: size, background: BOX[0] }}>
            <span className="absolute inset-y-0 left-0" style={{ width: `${f * 100}%`, background: colour }} />
            <svg viewBox="0 0 24 24" width={size * 0.72} height={size * 0.72} className="relative text-white" fill="currentColor"><path d={STAR} /></svg>
          </span>
        );
      })}
    </span>
  );
}

/** Round avatar with initials, coloured from the name (no photos are collected). */
export function Initials({ name, className = "h-11 w-11 text-sm" }: { name: string; className?: string }) {
  const palette = ["bg-brand-700", "bg-sky-700", "bg-amber-600", "bg-rose-600", "bg-violet-700", "bg-teal-700"];
  const n = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const letters = name === "Anonymous" ? "?" : name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return <span className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white ${palette[n % palette.length]} ${className}`}>{letters}</span>;
}

/** "3 days ago", "Jan 11". */
export function when(iso: string) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** One review as a card: initials, name and role, stars, the comment (in quotes) and the tags they picked. */
export function ReviewCard({ r, tone = "white", className = "" }: { r: PublicReview; tone?: "white" | "brand"; className?: string }) {
  const brand = tone === "brand";
  return (
    <article className={`flex flex-col rounded-3xl p-5 shadow-lg ${brand ? "bg-brand-800 text-white shadow-brand-900/20" : "bg-white text-stone-800 shadow-stone-900/5 ring-1 ring-stone-100"} ${className}`}>
      <header className="flex items-center gap-3">
        <Initials name={r.name} className={`h-11 w-11 text-sm ${brand ? "!bg-white/15" : ""}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{r.name}</p>
          <p className={`flex items-center gap-1 text-xs ${brand ? "text-white/70" : "text-stone-500"}`}><Icon name="check" size={12} />{r.role} · verified meeting</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 ${brand ? "bg-white" : "bg-stone-50 ring-1 ring-stone-100"}`}><Stars value={r.rating} size={14} /></span>
      </header>
      {r.comment ? (
        <p className={`relative mt-4 flex-1 pl-6 text-sm leading-relaxed ${brand ? "text-white/90" : "text-stone-600"}`}>
          <span aria-hidden="true" className={`absolute -top-2 left-0 font-serif text-4xl leading-none ${brand ? "text-brand-300" : "text-brand-600"}`}>“</span>{r.comment}
        </p>
      ) : (
        <p className={`mt-4 flex-1 text-sm font-medium ${brand ? "text-white/90" : "text-stone-700"}`}>Rated Gather “{WORDS[r.rating]}”</p>
      )}
      <footer className="mt-4 flex flex-wrap items-center gap-1.5">
        {r.tags.slice(0, 3).map((t) => <span key={t} className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${brand ? "bg-white/15 text-white" : "bg-brand-50 text-brand-800"}`}>{t}</span>)}
        <span className={`ml-auto text-[11px] ${brand ? "text-white/60" : "text-stone-400"}`}>{when(r.createdAt)}</span>
      </footer>
    </article>
  );
}

/** Big score, boxes, "Based on N reviews" and one bar per score (Excellent … Bad). */
export function ScoreSummary({ s, className = "" }: { s: ReviewSummary; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-end gap-4">
        <p className="text-6xl font-bold leading-none tracking-tight text-stone-800">{s.count ? s.score.toFixed(1) : "–"}</p>
        <div className="space-y-1.5 pb-1">
          <StarBoxes value={s.score} size={26} />
          <p className="text-sm text-stone-500">{s.count ? <><b className="text-stone-700">{s.label}</b> · based on {s.count} review{s.count === 1 ? "" : "s"}</> : "No reviews yet"}</p>
        </div>
      </div>
      <ul className="mt-6 space-y-3">
        {s.dist.map((d) => {
          const pct = s.count ? Math.round((d.count / s.count) * 100) : 0;
          return (
            <li key={d.stars} className="grid grid-cols-[5.5rem_1fr_2.5rem] items-center gap-3 text-sm">
              <span className="text-stone-600">{WORDS[d.stars]}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-stone-100"><span className="block h-full rounded-full transition-[width] duration-1000" style={{ width: `${pct}%`, background: BOX[d.stars] }} /></span>
              <span className="text-right font-semibold text-stone-700">{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Published reviews, kept live: loads /api/public/reviews and reloads whenever the server says a review was added
 * or hidden (Server-Sent Events). `stars` filters by score.
 */
export function useLiveReviews(opts: { limit?: number; stars?: number | null } = {}) {
  const [data, setData] = useState<{ summary: ReviewSummary; reviews: PublicReview[] } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // id of a review that just arrived (for a highlight)
  const qs = `?limit=${opts.limit ?? 20}${opts.stars ? `&stars=${opts.stars}` : ""}`;
  useEffect(() => {
    let alive = true;
    const load = () => api<{ summary: ReviewSummary; reviews: PublicReview[] }>(`/public/reviews${qs}`).then((d) => alive && setData(d)).catch(() => {});
    load();
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/public/reviews/stream");
      es.addEventListener("review", (e) => { try { setFresh(JSON.parse((e as MessageEvent).data).id); } catch { /* ignore */ } load(); });
      es.addEventListener("changed", load);
    } catch { /* old browser: the list just won't update live */ }
    return () => { alive = false; es?.close(); };
  }, [qs]);
  return { data, fresh, setData };
}

/* ------------------------------------------------------------------------------------------------ */
/* Rating form                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

const LOOK = {
  call: {
    card: "bg-ink-700 text-white ring-1 ring-white/10 shadow-2xl", muted: "text-white/60", badge: "bg-white/10 ring-1 ring-white/10",
    chip: "bg-white/10 text-white/80 hover:bg-white/15", chipOn: "bg-brand-600 text-white", input: "bg-white/5 text-white ring-1 ring-white/10 placeholder:text-white/40",
    skip: "bg-white/10 hover:bg-white/15", dot: "bg-white/40", check: "border-white/10 bg-white/10",
  },
  page: {
    card: "bg-white text-stone-900 ring-1 ring-stone-200 shadow-xl", muted: "text-stone-500", badge: "bg-white ring-1 ring-stone-200",
    chip: "bg-stone-100 text-stone-700 hover:bg-stone-200", chipOn: "bg-brand-700 text-white", input: "bg-white text-stone-900 ring-1 ring-stone-200 placeholder:text-stone-400",
    skip: "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50", dot: "bg-white/60", check: "border-stone-300",
  },
};

/**
 * The rating form. `onSubmit` saves (throws to show an error); `onSkip` (optional) is the "Not now" button.
 * Shows a thank-you once saved.
 */
export function RatingForm({ variant, tags, title = "Rate your experience", subtitle, onSubmit, onSkip, skipLabel = "Not now", thanks }: {
  variant: "call" | "page"; tags: ReviewTags; title?: string; subtitle?: string;
  onSubmit: (r: ReviewInput) => Promise<unknown>; onSkip?: () => void; skipLabel?: string; thanks?: React.ReactNode;
}) {
  const L = LOOK[variant];
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const shown = hover || rating;
  const options = rating >= 4 ? tags.good : tags.bad;
  const pick = (n: number) => { if (n >= 4 !== rating >= 4) setPicked([]); setRating(n); setErr(""); };
  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t].slice(0, 8)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rating) { setErr("Tap a star to rate Gather."); return; }
    setBusy(true); setErr("");
    try { await onSubmit({ rating, tags: picked, comment: comment.trim() || undefined, anonymous }); setDone(true); }
    catch (x: any) { setErr(x?.message ?? "We couldn't save your review. Try again."); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className={`rise-in w-full max-w-md rounded-3xl p-7 text-center ${L.card}`}>
        <p className="text-5xl">{FACES[rating]}</p>
        <h2 className="mt-3 text-xl font-bold">Thank you!</h2>
        <p className={`mt-2 text-sm ${L.muted}`}>{thanks ?? "Your review is now on the Gather home page. It helps other people choose a call app that works on their network."}</p>
        <span className="mt-4 inline-block"><Stars value={rating} size={22} /></span>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={`rise-in w-full max-w-md rounded-3xl p-6 text-left ${L.card}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${L.badge}`}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d={STAR} /><path d="M9.5 12.5s1 1.3 2.5 1.3 2.5-1.3 2.5-1.3" strokeLinecap="round" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold leading-tight">{title}</h2>
          <p className={`mt-0.5 text-sm ${L.muted}`}>{subtitle ?? "How was your meeting on Gather? Good or bad, tell us."}</p>
        </div>
        {onSkip && <button type="button" onClick={onSkip} aria-label="Close" className={`rounded-full p-1.5 ${L.muted} hover:opacity-80`}><Icon name="x" size={18} /></button>}
      </div>

      {/* The track fills as you pick; picked stars pop in, the rest wait as dots */}
      <div className="keep-dark relative mt-5 h-14 overflow-hidden rounded-2xl bg-ink-600" onMouseLeave={() => setHover(0)}>
        <span className={`absolute inset-y-0 left-0 rounded-2xl bg-gradient-to-r transition-[width] duration-500 ${FILL[shown] ?? ""}`} style={{ width: `${(shown / 5) * 100}%` }} />
        <div className="relative grid h-full grid-cols-5" role="radiogroup" aria-label="Your rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? "s" : ""}: ${WORDS[n]}`}
              onClick={() => pick(n)} onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)}
              // The star/dot inside is swapped on hover and focus; it ignores the pointer so taps always land on the button.
              className="flex items-center justify-center text-white transition hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 [&>*]:pointer-events-none">
              {n <= shown
                ? <svg key={`s${n}-${shown >= n}`} viewBox="0 0 24 24" width="28" height="28" fill="currentColor" className="star-pop drop-shadow" style={{ animationDelay: `${(n - 1) * 40}ms` }}><path d={STAR} /></svg>
                : <span className={`h-3 w-3 rounded-full ${L.dot} transition`} />}
            </button>
          ))}
        </div>
      </div>
      <p className={`mt-2 h-5 text-center text-sm font-semibold ${shown ? "" : L.muted}`} aria-live="polite">{shown ? `${FACES[shown]} ${WORDS[shown]}` : "Tap a star"}</p>

      {rating > 0 && (
        <div className="rise-in">
          <p className="mt-4 text-sm font-semibold">{rating >= 4 ? "What did you like the most?" : rating === 3 ? "What could be better?" : "What went wrong?"}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {options.map((t) => (
              <button key={t} type="button" onClick={() => toggle(t)} aria-pressed={picked.includes(t)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${picked.includes(t) ? L.chipOn : L.chip}`}>{picked.includes(t) && "✓ "}{t}</button>
            ))}
          </div>
        </div>
      )}

      <label className="mt-5 block">
        <span className="sr-only">Comment</span>
        <span className={`relative block rounded-2xl ${L.input}`}>
          <textarea value={comment} onChange={(e) => setComment(e.target.value.slice(0, 300))} rows={3} placeholder={rating && rating < 4 ? "Tell us what happened (optional)…" : "Write a comment (optional)…"}
            className="block w-full resize-none rounded-2xl bg-transparent px-4 pb-7 pt-3 text-sm outline-none focus:ring-2 focus:ring-brand-500" />
          <span className={`pointer-events-none absolute bottom-2 right-3 text-[11px] ${L.muted}`}>{comment.length}/300</span>
        </span>
      </label>

      <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="peer sr-only" />
        <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition peer-checked:border-brand-600 peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 ${L.check}`}>{anonymous && <Icon name="check" size={12} className="text-white" />}</span>
        <span>Remain anonymous <span className={`text-xs ${L.muted}`}>(we'll show "Anonymous")</span></span>
      </label>

      {err && <p className="mt-3 text-sm font-medium text-red-500" role="alert">{err}</p>}
      <div className="mt-5 flex gap-3">
        {onSkip && <button type="button" onClick={onSkip} className={`flex-1 rounded-xl py-3 text-sm font-semibold ${L.skip}`}>{skipLabel}</button>}
        <button disabled={busy} className="flex-1 rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">{busy ? "Sending…" : "Submit"}</button>
      </div>
    </form>
  );
}
