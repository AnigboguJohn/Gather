/**
 * Checkout and order confirmation for paid plans.
 *  - CheckoutPage ("/billing/checkout?plan=pro&months=1"): steps (Plan → Payment → Confirmation), how to pay
 *    (Paystack, Flutterwave, or the demo checkout), months, who's billed, and the order summary. "Pay" creates the
 *    order on the server (the price comes from the server) and goes to the provider's secure page.
 *    Card numbers are typed on Paystack's / Flutterwave's page, never into Gather.
 *  - ReceiptPage ("/billing/receipt/:reference"): "Payment successful" with the order details, or what went wrong.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Spinner, copy, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, fmtTime, naira } from "../lib/format";

/** Each way to pay: name, what it accepts, and a short note. */
const METHODS: Record<string, { name: string; accepts: string; note: string }> = {
  paystack: { name: "Paystack", accepts: "Card, bank transfer, USSD", note: "Visa, Mastercard and Verve. You'll confirm with your bank's OTP." },
  flutterwave: { name: "Flutterwave", accepts: "Card, bank transfer, mobile money", note: "Works across Africa, including M-Pesa and MoMo." },
  demo: { name: "Demo checkout", accepts: "No real money", note: "For trying the flow. Nothing is charged." },
};
const TERMS = [1, 3, 12];
const DAY = 86_400_000;

/** Plan → Payment → Confirmation, with ticks for finished steps. */
function Steps({ at }: { at: 1 | 2 | 3 }) {
  const steps = ["Plan", "Payment", "Confirmation"];
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Checkout steps">
      {steps.map((s, i) => {
        // Finished steps get a tick; on the confirmation page every step is finished.
        const n = i + 1; const done = n < at || at === 3; const now = n === at && !done;
        return (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span className={`h-px w-6 sm:w-10 ${n <= at ? "bg-brand-500" : "bg-stone-300"}`} />}
            <span aria-current={n === at ? "step" : undefined} className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-brand-600 text-white" : now ? "bg-brand-600 text-white ring-4 ring-brand-100" : "border border-stone-300 text-stone-400"}`}>
              {done ? <Icon name="check" size={13} strokeWidth={3} /> : n}
            </span>
            <span className={now || done ? "font-semibold text-stone-800" : "text-stone-400"}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Top bar of both pages: back link and the padlock. */
function TopBar({ back, label }: { back: string; label: string }) {
  return (
    <div className="mb-6 flex items-center justify-between text-sm">
      <Link to={back} className="flex items-center gap-1.5 font-semibold text-brand-700 hover:underline"><Icon name="back" size={16} />{label}</Link>
      <span className="flex items-center gap-1.5 text-stone-500"><Icon name="lock" size={14} />Secure checkout</span>
    </div>
  );
}

/* ------------------------------------------------------------------ Checkout */
export function CheckoutPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [b, setB] = useState<any>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("/billing").then((x) => { setB(x); setMethod(x.providers[0] ?? null); }); }, []);
  if (!b) return <div className="py-20 text-center text-brand-700"><Spinner /></div>;

  const plan = b.plans.find((p: any) => p.id === params.get("plan") && p.priceNgnMonthly > 0);
  const months = TERMS.includes(Number(params.get("months"))) ? Number(params.get("months")) : 1;
  if (!plan) return <div className="mx-auto max-w-md py-16 text-center"><p className="font-semibold">Pick a paid plan first.</p><Link to="/billing" className="mt-3 inline-block font-semibold text-brand-700">See plans</Link></div>;
  const isAdmin = me?.user.role !== "member";
  const total = plan.priceNgnMonthly * 100 * months;
  // The server extends from the later of today and the current paid-up date.
  const from = Math.max(Date.now(), b.paidUntil && b.current !== "free" ? new Date(b.paidUntil).getTime() : 0);
  const until = new Date(from + 30 * months * DAY);
  const extending = b.current === plan.id;

  /** Create the order (server sets the price) and go to the provider's secure page. */
  const pay = async () => {
    if (!method) return;
    setBusy(true);
    try { const r = await api("/billing/checkout", { body: { plan: plan.id, provider: method, months } }); window.location.href = r.url; }
    catch (e) { toast((e as ApiError).message, "error"); setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <TopBar back="/billing" label="Back to plans" />
      <h1 className="text-3xl font-extrabold tracking-tight text-stone-900">Checkout</h1>
      <div className="mt-3"><Steps at={2} /></div>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Left: how to pay, how long, who's billed */}
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 font-bold text-stone-900">How would you like to pay?</h2>
            {!b.providers.length ? <p className="rounded-2xl bg-stone-100 p-4 text-sm text-stone-600">Payments aren't set up on this server yet.</p> : (
              <div className="space-y-3" role="radiogroup" aria-label="Payment method">
                {b.providers.map((id: string) => {
                  const m = METHODS[id]; const on = method === id;
                  return (
                    <button key={id} type="button" role="radio" aria-checked={on} onClick={() => setMethod(id)}
                      className={`flex w-full items-start gap-4 rounded-2xl border bg-white p-4 text-left transition ${on ? "border-stone-900 ring-1 ring-stone-900" : "border-stone-200 hover:border-stone-400"}`}>
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${on ? "border-brand-600" : "border-stone-300"}`}>{on && <span className="h-2.5 w-2.5 rounded-full bg-brand-600" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-stone-900">{m.name}</span>
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${id === "demo" ? "bg-amber-100 text-amber-800" : "bg-stone-100 text-stone-600"}`}>{m.accepts}</span>
                        </span>
                        <span className="mt-1 block text-sm text-stone-500">{m.note}</span>
                      </span>
                      <Icon name={id === "demo" ? "sparkle" : "card"} size={22} className="mt-0.5 shrink-0 text-stone-400" />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 font-bold text-stone-900">How long?</h2>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Months">
              {TERMS.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={months === t} onClick={() => setParams({ plan: plan.id, months: String(t) }, { replace: true })}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-semibold ${months === t ? "border-brand-600 bg-brand-50 text-brand-800" : "border-stone-200 bg-white text-stone-700"}`}>
                  {t} month{t > 1 ? "s" : ""}<span className="block text-xs font-normal text-stone-500">{naira(plan.priceNgnMonthly * 100 * t)}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-bold text-stone-900">Billed to</h2>
            <p className="text-stone-800">{me?.org.name}</p>
            <p className="text-stone-500">{me?.user.name} · {me?.user.email}</p>
            <p className="mt-2 text-xs text-stone-500">The receipt goes to this email.</p>
          </section>

          {isAdmin ? (
            <div>
              <button onClick={pay} disabled={busy || !method}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-700 py-4 text-base font-semibold text-white shadow-lg shadow-brand-900/15 transition hover:bg-brand-800 disabled:opacity-60">
                {busy ? <Spinner size={18} /> : <Icon name="lock" size={18} />}
                Pay {naira(total)}{method ? ` with ${METHODS[method].name}` : ""}
              </button>
              <p className="mt-2 text-center text-xs text-stone-500">
                {method === "demo" ? "A practice payment page opens. No money moves." : "You'll go to a secure payment page. Gather never sees your card number."}
              </p>
            </div>
          ) : <p className="rounded-2xl bg-stone-100 p-4 text-center text-sm text-stone-600">Only a workspace admin can pay for the plan.</p>}
        </div>

        {/* Right: order summary */}
        <aside className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm lg:sticky lg:top-6">
          <h2 className="font-bold text-stone-900">Order summary</h2>
          <div className="mt-4 flex items-center gap-3 rounded-2xl bg-stone-50 p-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-white"><Icon name="cam" size={22} /></span>
            <span className="min-w-0">
              <span className="block font-semibold text-stone-900">Gather {plan.name}</span>
              <span className="block text-xs text-stone-500">{extending ? "Extend your plan" : "Upgrade"} · up to {plan.maxParticipants} people · no time limit</span>
            </span>
          </div>
          <dl className="mt-5 space-y-3 border-b border-stone-100 pb-5 text-sm">
            <div className="flex justify-between"><dt className="text-stone-500">{naira(plan.priceNgnMonthly * 100)} × {months} month{months > 1 ? "s" : ""}</dt><dd className="text-stone-800">{naira(total)}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Active until</dt><dd className="text-stone-800">{fmtDate(until)}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Renews automatically</dt><dd className="text-stone-800">No</dd></div>
          </dl>
          <div className="flex items-end justify-between pt-5">
            <span className="font-semibold text-stone-900">Total</span>
            <span className="text-3xl font-extrabold tracking-tight text-brand-700">{naira(total)}</span>
          </div>
          <div className="mt-6 grid grid-cols-3 gap-2 border-t border-stone-100 pt-5 text-center text-xs text-stone-600">
            <span><Icon name="shield" size={22} className="mx-auto mb-1 text-brand-600" />Secure payment</span>
            <span><Icon name="card" size={22} className="mx-auto mb-1 text-brand-600" />Pay in Naira</span>
            <span><Icon name="refresh" size={22} className="mx-auto mb-1 text-brand-600" />No auto-renewal</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Confirmation / receipt */
export function ReceiptPage() {
  const { reference = "" } = useParams();
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    api(`/billing/payments/${encodeURIComponent(reference)}`).then((x) => { setP(x); if (x.status === "success") refresh(); }).catch((e) => setErr((e as ApiError).message));
  }, [reference, tries]);
  // Still pending (the provider's webhook can be a few seconds late): check again every 3 s for up to 30 s.
  useEffect(() => {
    if (p?.status !== "pending" || tries >= 10) return;
    const t = setTimeout(() => setTries((n) => n + 1), 3000);
    return () => clearTimeout(t);
  }, [p, tries]);

  if (err) return <div className="mx-auto max-w-md py-16 text-center"><p className="font-semibold text-red-600">{err}</p><Link to="/billing" className="mt-3 inline-block font-semibold text-brand-700">Back to plans</Link></div>;
  if (!p) return <div className="py-20 text-center text-brand-700"><Spinner /></div>;
  const ok = p.status === "success";
  const pending = p.status === "pending";
  const retry = `/billing/checkout?plan=${p.plan}&months=${p.months}`;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="print:hidden"><TopBar back="/billing" label="Plan and billing" /></div>
      <div className="mb-8 flex justify-center print:hidden"><Steps at={ok ? 3 : 2} /></div>

      <div className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
        {/* Outcome */}
        <div className="px-6 pb-6 pt-8 text-center">
          <span className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${ok ? "bg-brand-50 text-brand-600" : pending ? "bg-sky-50 text-sky-600" : "bg-red-50 text-red-600"}`}>
            {pending ? <Spinner size={28} /> : <Icon name={ok ? "check" : "x"} size={32} strokeWidth={2.5} />}
          </span>
          <h1 className="mt-4 text-2xl font-extrabold text-stone-900">{ok ? "Payment successful" : pending ? "Confirming your payment…" : "Payment not completed"}</h1>
          <p className="mx-auto mt-1 max-w-md text-stone-500">
            {ok ? <>Your order is confirmed. {p.org_name} is on Gather {p.plan_name} until <b className="font-semibold text-stone-800">{fmtDate(p.paid_until)}</b>. A receipt was sent to {p.payer_email}.</>
              : pending ? (tries >= 10 ? "This is taking longer than usual. If money left your account, it will show here shortly; you can refresh this page." : "We're waiting for the payment provider to confirm. This usually takes a few seconds.")
              : params.get("msg") ?? "No money was taken for this order. You can try again."}
          </p>
        </div>

        {/* Order details */}
        <dl className="divide-y divide-dashed divide-stone-200 border-t border-dashed border-stone-200 px-6 text-sm">
          {[
            ["Order number", <span className="flex items-center gap-2 font-mono text-xs">{p.reference}<button className="print:hidden" onClick={() => copy(p.reference, "Order number copied")} aria-label="Copy order number"><Icon name="copy" size={14} className="text-stone-400 hover:text-stone-700" /></button></span>],
            ["Date", `${fmtDate(p.paid_at ?? p.created_at)}, ${fmtTime(p.paid_at ?? p.created_at)}`],
            ["Plan", `Gather ${p.plan_name} × ${p.months} month${p.months > 1 ? "s" : ""}`],
            ["Workspace", p.org_name],
            ["Billed to", `${p.payer_name ?? ""} · ${p.payer_email ?? ""}`],
            ["Paid with", p.provider_name],
            ["Status", <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ok ? "bg-brand-100 text-brand-800" : pending ? "bg-sky-100 text-sky-800" : "bg-red-100 text-red-700"}`}>{ok ? "Paid" : pending ? "Pending" : "Not completed"}</span>],
          ].map(([k, v]) => (
            <div key={k as string} className="flex items-center justify-between gap-4 py-3"><dt className="text-stone-500">{k}</dt><dd className="text-right text-stone-800">{v}</dd></div>
          ))}
        </dl>
        <div className="flex items-end justify-between border-t border-stone-200 bg-stone-50 px-6 py-5">
          <span className="font-semibold text-stone-900">{ok ? "Amount paid" : "Amount"}</span>
          <span className="text-3xl font-extrabold tracking-tight text-stone-900">{naira(Number(p.amount_minor))}</span>
        </div>
      </div>

      {/* Next steps */}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row print:hidden">
        {ok ? <>
          <Link to="/home" className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 py-3.5 font-semibold text-white hover:bg-brand-800"><Icon name="cam" size={18} />Start a meeting</Link>
          <button onClick={() => window.print()} className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-stone-300 bg-white py-3.5 font-semibold text-stone-800 hover:bg-stone-50"><Icon name="download" size={18} />Print or save receipt</button>
        </> : !pending ? <>
          <Link to={retry} className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 py-3.5 font-semibold text-white hover:bg-brand-800"><Icon name="refresh" size={18} />Try again</Link>
          <Link to="/billing" className="flex flex-1 items-center justify-center rounded-2xl border border-stone-300 bg-white py-3.5 font-semibold text-stone-800 hover:bg-stone-50">Back to plans</Link>
        </> : null}
      </div>
    </div>
  );
}
