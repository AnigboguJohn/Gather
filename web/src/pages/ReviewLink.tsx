/** Review link page ("/review/:token"): people who skipped the rating after their first meeting get this link on WhatsApp/email. */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Logo } from "../components/Layout";
import { RatingForm, type ReviewTags } from "../components/Reviews";
import { Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";

/** Rate Gather without signing in: the link's token says who is reviewing. */
export default function ReviewLink() {
  const { token } = useParams();
  const [info, setInfo] = useState<{ name: string; reviewed: boolean; tags: ReviewTags } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/public/review-links/${token}`, { token: null }).then(setInfo).catch((e) => setErr((e as ApiError).message)); }, [token]);
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-stone-100 px-4 py-10">
      <Link to="/"><Logo /></Link>
      <div className="mt-6 flex w-full justify-center">
        {err ? <p className="rounded-2xl bg-white p-6 text-red-600 shadow-sm">{err}</p>
          : !info ? <Spinner />
          : info.reviewed ? (
            <div className="w-full max-w-md rounded-3xl bg-white p-7 text-center shadow-sm">
              <p className="text-4xl">💚</p>
              <p className="mt-2 text-lg font-bold">You've already reviewed Gather</p>
              <p className="mt-1 text-sm text-stone-600">Thank you, {info.name}. See what others say on the reviews page.</p>
              <Link to="/reviews" className="mt-5 inline-block rounded-full bg-brand-700 px-6 py-2.5 text-sm font-semibold text-white">See reviews</Link>
            </div>
          ) : (
            <RatingForm variant="page" tags={info.tags} title="Rate Gather" subtitle={`Hi ${info.name}, how was your meeting? Good or bad, your review helps us.`}
              onSubmit={(r) => api(`/public/review-links/${token}`, { body: r, token: null })}
              thanks={<>Your review is live on the Gather home page. <Link to="/reviews" className="font-semibold text-brand-700 underline">See all reviews</Link></>} />
          )}
      </div>
    </div>
  );
}
