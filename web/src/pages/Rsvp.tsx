/** RSVP page ("/r/:token"): the "I'll attend" / "Can't make it" links in WhatsApp and email invites open here. */
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Layout";
import { Button, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { fmtWhen } from "../lib/format";

/** Landing page for the "I'll attend" / "Can't make it" links in invites. */
export default function Rsvp() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  // Save the answer (public call: the invite token is the only key needed).
  const answer = (v: "yes" | "no") => api(`/public/rsvp/${token}`, { body: { r: v }, token: null }).then(setR).catch((e) => setErr((e as ApiError).message));
  // Links in invites already carry ?r=yes or ?r=no, so answer immediately on open.
  useEffect(() => { const v = params.get("r"); if (v === "yes" || v === "no") answer(v); }, []);
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-stone-100 px-4">
      <Logo />
      <div className="mt-6 w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-sm">
        {err ? <p className="text-red-600">{err}</p> : !r ? (params.get("r") ? <Spinner /> : (
          <div className="space-y-3"><p className="font-semibold">Will you attend?</p><Button className="w-full" onClick={() => answer("yes")}>I'll attend</Button><Button className="w-full" variant="secondary" onClick={() => answer("no")}>Can't make it</Button></div>
        )) : (
          <div className="space-y-3">
            <p className="text-4xl">{r.rsvp === "yes" ? "🙌" : "👋"}</p>
            <p className="text-lg font-bold">{r.rsvp === "yes" ? "See you there" : "Thanks for letting them know"}</p>
            <p className="text-stone-600">{r.title}<br />{fmtWhen(r.startAt, r.timeZone)}</p>
            {r.rsvp === "yes" && r.status !== "cancelled" && <Link to={`/j/${r.slug}?i=${token}`} className="block rounded-xl bg-brand-700 py-3 font-semibold text-white">Open the meeting page</Link>}
            <button className="text-sm text-stone-500" onClick={() => answer(r.rsvp === "yes" ? "no" : "yes")}>Change my answer</button>
          </div>
        )}
      </div>
    </div>
  );
}
