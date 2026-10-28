/**
 * Public reviews page ("/reviews"): the score summary on the left (big score, Trustpilot-style boxes, one bar per
 * score) and every published review on the right, newest first, filterable by stars. Good and bad reviews are
 * all shown; new ones appear live.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Layout";
import { Icon } from "../components/Icon";
import { ReviewCard, ScoreSummary, useLiveReviews, WORDS, type PublicReview } from "../components/Reviews";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";

export default function ReviewsPage() {
  const [stars, setStars] = useState<number | null>(null);
  const { data, fresh, setData } = useLiveReviews({ limit: 20, stars });
  const [more, setMore] = useState<"idle" | "busy" | "end">("idle");
  const loadMore = async () => {
    if (!data?.reviews.length) return;
    setMore("busy");
    const last = data.reviews[data.reviews.length - 1].createdAt;
    const d = await api<{ reviews: PublicReview[] }>(`/public/reviews?limit=20&before=${encodeURIComponent(last)}${stars ? `&stars=${stars}` : ""}`).catch(() => null);
    if (d) setData({ ...data, reviews: [...data.reviews, ...d.reviews] });
    setMore(!d || d.reviews.length < 20 ? "end" : "idle");
  };
  return (
    <div className="min-h-full bg-sky-50/60 text-stone-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Link to="/"><Logo /></Link>
        <Link to="/signup" className="rounded-full bg-brand-700 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-800">Start for free</Link>
      </header>
      <main className="mx-auto grid max-w-6xl gap-6 px-5 pb-16 md:grid-cols-[0.9fr_1.1fr] md:items-start">
        <section className="rounded-[2rem] bg-white p-7 shadow-sm md:sticky md:top-6">
          <Link to="/" className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-600 hover:bg-stone-200" aria-label="Back"><Icon name="back" size={18} /></Link>
          <h1 className="mt-6 text-4xl font-bold tracking-tight">Reviews and ratings</h1>
          <p className="mt-2 text-sm text-stone-500">From hosts and guests after their first Gather meeting. Every review is shown, good or bad.</p>
          {data ? <ScoreSummary s={data.summary} className="mt-7 border-t border-stone-100 pt-7" /> : <div className="py-10"><Spinner /></div>}
        </section>
        <section className="rounded-[2rem] bg-white p-5 shadow-sm md:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 pb-4">
            <h2 className="text-xl font-bold">Reviews <span className="font-normal text-stone-400">{data?.summary.count ?? ""}</span></h2>
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <span className="sr-only">Filter by rating</span>
              <select value={stars ?? ""} onChange={(e) => { setStars(e.target.value ? Number(e.target.value) : null); setMore("idle"); }} className="rounded-full border border-stone-200 bg-white px-3 py-1.5 font-medium">
                <option value="">All ratings</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? "s" : ""} · {WORDS[n]}</option>)}
              </select>
            </label>
          </div>
          {!data ? <div className="py-10"><Spinner /></div> : !data.reviews.length ? (
            <p className="py-14 text-center text-sm text-stone-500">{stars ? "No reviews with this rating yet." : "No reviews yet. Hosts and guests are asked after their first meeting."}</p>
          ) : (
            <div className="mt-5 space-y-4">
              {data.reviews.map((r) => <ReviewCard key={r.id} r={r} className={`!shadow-none ring-1 ring-stone-100 ${r.id === fresh ? "rise-in !ring-2 !ring-brand-400" : ""}`} />)}
              {more !== "end" && data.reviews.length >= 20 && (
                <button onClick={loadMore} disabled={more === "busy"} className="w-full rounded-full border border-stone-200 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50">{more === "busy" ? "Loading…" : "Show more reviews"}</button>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
