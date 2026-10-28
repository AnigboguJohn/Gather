/** Billing pages: plans, checkout (Paystack, Flutterwave or demo) and payment confirmation. */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, Spinner, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, hoursLabel, naira } from "../lib/format";

// How each payment provider is named on buttons.
const PROVIDER_LABEL: Record<string, string> = { paystack: "Paystack", flutterwave: "Flutterwave", demo: "Demo checkout (no real money)" };
// One line under each plan name.
const PLAN_BLURB: Record<string, string> = {
  free: "For trying Gather and everyday calls with your team.",
  pro: "For teams that meet every day and need longer calls.",
  business: "For large meetings, trainings and whole organisations.",
};
// How many months to pay for at once (payments never renew by themselves).
const TERMS = [{ months: 1, label: "1 month" }, { months: 3, label: "3 months" }, { months: 12, label: "12 months" }];

/** What one plan includes, as the card's tick list. Paid plans list "Everything in <previous plan>" plus what they add. */
function features(p: any, prev: any | undefined): string[] {
  if (!prev) return [
    `Meetings up to ${hoursLabel(p.meetingLimitMinutes)}`,
    `Up to ${p.maxParticipants} people per meeting`,
    "Live captions, translated into 7 languages",
    "Screen sharing, chat, polls and breakouts",
    "WhatsApp and email invites with reminders",
    "Summaries sent in each person's language",
  ];
  return [
    `Everything in ${prev.name}`,
    ...(p.meetingLimitMinutes > prev.meetingLimitMinutes ? ["No meeting length limit"] : []),
    ...(p.maxParticipants > prev.maxParticipants ? [`Up to ${p.maxParticipants} people per meeting`] : []),
    ...(p.recordings && !prev.recordings ? ["Meeting recordings"] : []),
    ...(p.dialIn && !prev.dialIn ? ["Phone dial-in for people without data"] : []),
  ];
}

/**
 * Plan and billing ("/billing"): "Choose your plan" with Free / Pro / Business cards (Pro recommended),
 * a 1 / 3 / 12 month switch, a pay button per plan for the payment provider(s) the server has set up,
 * and past payments. Only workspace admins can pay.
 */
export function Billing() {
  const { me } = useAuth();
  const [b, setB] = useState<any>(null);
  const [months, setMonths] = useState(1);
  useEffect(() => { api("/billing").then(setB); }, []);
  if (!b) return <div className="py-20 text-center text-brand-700"><Spinner /></div>;
  const isAdmin = me?.user.role !== "member";
  const currentName = b.plans.find((p: any) => p.id === b.current)?.name;
  const realProviders = b.providers.filter((x: string) => x !== "demo");
  return (
    <div className="space-y-10">
      {/* Heading, centred like the design */}
      <div className="pt-2 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-stone-900 md:text-4xl">Choose your plan</h1>
        <p className="mt-2 text-stone-500">
          {b.current === "free" ? "You're on Free: meetings last up to 2 hours." : `You're on ${currentName} until ${fmtDate(b.paidUntil)}.`}
          {realProviders.length > 0 && ` Pay in Naira with ${realProviders.map((x: string) => PROVIDER_LABEL[x]).join(" or ")}.`}
        </p>
        {/* How many months to pay for */}
        <div className="mt-6 inline-flex rounded-full bg-sky-50 p-1 ring-1 ring-sky-100" role="radiogroup" aria-label="Pay for">
          {TERMS.map((t) => (
            <button key={t.months} role="radio" aria-checked={months === t.months} onClick={() => setMonths(t.months)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${months === t.months ? "bg-white text-stone-900 shadow-sm ring-1 ring-sky-100" : "text-stone-500 hover:text-stone-800"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* The three plans; Pro sits in a raised blue frame ("Recommended for you" while on Free, then "Most popular") */}
      <div className="mx-auto grid max-w-4xl items-center gap-5 md:grid-cols-3 md:gap-4">
        {b.plans.map((p: any, i: number) => {
          const pro = p.id === "pro";
          const current = p.id === b.current;
          const list = features(p, b.plans[i - 1]);
          const card = (
            <div className={`relative flex h-full flex-col overflow-hidden rounded-2xl border bg-white p-6 ${pro ? "border-sky-100" : "border-sky-100/80 shadow-sm"}`}>
              <PlanArt id={p.id} />
              <div className="flex items-center gap-2"><h2 className="text-xl font-bold text-stone-900">{p.name}</h2>{current && <Badge tone="green">Current plan</Badge>}</div>
              <p className="mt-1 max-w-[13.5rem] text-sm text-stone-500">{PLAN_BLURB[p.id]}</p>
              <p className="mt-6 text-4xl font-bold tracking-tight text-stone-900">
                {naira(p.priceNgnMonthly * 100)}<span className="text-sm font-normal text-stone-500">/month</span>
              </p>
              <p className="mt-1 h-4 text-xs text-stone-500">{p.priceNgnMonthly && months > 1 ? `${naira(p.priceNgnMonthly * 100 * months)} for ${months} months` : ""}</p>
              <hr className="my-5 border-stone-200" />
              <p className="text-sm font-semibold text-stone-800">What's included:</p>
              <ul className="mt-3 flex-1 space-y-2.5 text-sm text-stone-600">
                {list.map((f) => <li key={f} className="flex gap-2"><Icon name="check" size={16} className="mt-0.5 shrink-0 text-sky-600" />{f}</li>)}
              </ul>
              <div className="mt-7">
                <PlanButton p={p} pro={pro} current={current} onFree={b.current === "free"} isAdmin={isAdmin} providers={b.providers} months={months} />
              </div>
            </div>
          );
          if (!pro) return <div key={p.id} className="h-full md:py-6">{card}</div>;
          return (
            <div key={p.id} className="relative h-full rounded-[1.25rem] bg-sky-100 p-1 pt-0 shadow-xl shadow-sky-200/60 ring-1 ring-sky-200">
              <p className="py-2 text-center text-xs font-semibold text-sky-900">{b.current === "free" ? "Recommended for you" : "Most popular"}</p>
              <div className="h-[calc(100%-2.25rem)]">{card}</div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-stone-500">You pay once for 1, 3 or 12 months. Nothing renews or charges you automatically; pay again to extend.</p>

      {b.payments.length > 0 && (
        <Card className="mx-auto max-w-4xl">
          <h2 className="mb-3 font-bold">Payments</h2>
          <ul className="divide-y divide-stone-100 text-sm">{b.payments.map((p: any) => (
            <li key={p.reference} className="flex flex-wrap items-center gap-3 py-2"><span className="flex-1">{fmtDate(p.created_at)} · {p.plan} × {p.months} · {PROVIDER_LABEL[p.provider]}</span><span className="font-semibold">{naira(p.amount_minor)}</span><Badge tone={p.status === "success" ? "green" : p.status === "failed" ? "red" : "stone"}>{p.status}</Badge></li>
          ))}</ul>
        </Card>
      )}
    </div>
  );
}

/**
 * The button at the bottom of a plan card. Free: "Your plan" or "Included". Paid: "Start with Pro" / "Extend Pro",
 * which opens the checkout page for that plan and number of months. Members (not admins) can't pay.
 */
function PlanButton({ p, pro, current, onFree, isAdmin, providers, months }: {
  p: any; pro: boolean; current: boolean; onFree: boolean; isAdmin: boolean; providers: string[]; months: number;
}) {
  const quiet = "w-full rounded-xl border border-sky-100 bg-sky-50/70 py-2.5 text-sm font-semibold text-stone-800";
  if (p.id === "free") return <button disabled className={`${quiet} cursor-default text-stone-500`}>{onFree ? "Your plan" : "Included in your plan"}</button>;
  if (!isAdmin) return <p className="rounded-xl bg-stone-50 py-2.5 text-center text-xs text-stone-500">Ask a workspace admin to upgrade.</p>;
  if (!providers.length) return <p className="rounded-xl bg-stone-50 py-2.5 text-center text-xs text-stone-500">Payments aren't set up on this server.</p>;
  const amount = naira(p.priceNgnMonthly * 100 * months);
  return (
    <div className="space-y-2">
      <Link to={`/billing/checkout?plan=${p.id}&months=${months}`}
        className={pro
          ? "relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-[#0c2a5b] py-3 text-sm font-semibold text-white shadow-lg shadow-sky-900/20 transition hover:bg-[#0a234c]"
          : `${quiet} flex items-center justify-center gap-2 transition hover:bg-sky-100`}>
        {/* A few faint stars on the Pro button, as in the design */}
        {pro && <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(1px 1px at 18% 30%, #fff, transparent), radial-gradient(1px 1px at 72% 65%, #fff, transparent), radial-gradient(1px 1px at 86% 25%, #fff, transparent), radial-gradient(1px 1px at 35% 75%, #fff, transparent)" }} />}
        <span className="relative">{current ? `Extend ${p.name}` : `Start with ${p.name}`}</span>
      </Link>
      <p className="text-center text-[11px] text-stone-500">{amount} for {months} month{months > 1 ? "s" : ""} · card, bank transfer or USSD</p>
    </div>
  );
}

/** Faint line drawings in each card's top-right corner: rings (Free), a four-point star (Pro), a globe (Business). */
function PlanArt({ id }: { id: string }) {
  const cls = "pointer-events-none absolute -right-7 -top-7 h-24 w-24 text-stone-200/80";
  if (id === "free") return (
    <svg viewBox="0 0 100 100" className={cls} fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <ellipse cx="35" cy="50" rx="14" ry="42" /><ellipse cx="55" cy="50" rx="14" ry="42" /><ellipse cx="75" cy="50" rx="14" ry="42" />
    </svg>
  );
  if (id === "pro") return (
    <svg viewBox="0 0 100 100" className={cls} aria-hidden="true">
      <path d="M60 8 L66 44 L96 52 L66 60 L60 96 L54 60 L24 52 L54 44 Z" fill="#f1f3f6" stroke="#e2e6eb" strokeWidth="1" />
    </svg>
  );
  return (
    <svg viewBox="0 0 100 100" className={cls} fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="58" cy="50" r="40" /><ellipse cx="58" cy="50" rx="18" ry="40" /><path d="M18 50h80 M22 32h72 M22 68h72 M58 10v80" />
    </svg>
  );
}

/**
 * Fake payment page ("/billing/demo") used when no payment keys are configured, so the whole flow can be tried
 * locally. It stands in for Paystack's / Flutterwave's page: "Pay" or "Cancel", then the confirmation page.
 */
export function BillingDemo() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const ref = params.get("reference") ?? "";
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/billing/payments/${encodeURIComponent(ref)}`).then(setP).catch(() => setP(null)); }, [ref]);
  const done = async (outcome: "success" | "cancel") => {
    setBusy(true);
    try {
      await api("/billing/demo/complete", { body: { reference: ref, outcome } });
      if (outcome === "success") await refresh();
      nav(`/billing/receipt/${ref}${outcome === "cancel" ? "?msg=You cancelled the payment. No money was taken." : ""}`, { replace: true });
    } catch (e) { toast((e as ApiError).message, "error"); setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-md">
      <Card className="space-y-5 text-center">
        <Badge tone="amber">Demo checkout · no real money</Badge>
        <div>
          <p className="text-sm text-stone-500">Pay Gather</p>
          <p className="mt-1 text-4xl font-extrabold tracking-tight">{p ? naira(Number(p.amount_minor)) : "…"}</p>
          {p && <p className="mt-1 text-sm text-stone-500">Gather {p.plan_name} × {p.months} month{p.months > 1 ? "s" : ""} · {p.payer_email}</p>}
        </div>
        <p className="rounded-xl bg-stone-50 p-3 text-xs text-stone-500">Order <span className="font-mono">{ref}</span>. With Paystack or Flutterwave keys, their secure card page shows here instead.</p>
        <Button className="w-full" loading={busy} onClick={() => done("success")}>Pay now</Button>
        <Button className="w-full" variant="secondary" disabled={busy} onClick={() => done("cancel")}>Cancel</Button>
      </Card>
    </div>
  );
}

/**
 * Return page ("/billing/return"): Paystack/Flutterwave send the payer back here.
 * We never trust the redirect alone: the server verifies the payment with the provider before upgrading,
 * then the confirmation page shows the result (paid, still pending, or not completed).
 */
export function BillingReturn() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const ran = useRef(false);
  useEffect(() => {
    // React StrictMode runs effects twice in development; verify only once.
    if (ran.current) return; ran.current = true;
    const provider = params.get("provider");
    // Paystack returns ?reference=..., Flutterwave returns ?tx_ref=...&transaction_id=...&status=...
    const reference = params.get("reference") ?? params.get("trxref") ?? params.get("tx_ref") ?? "";
    const show = (msg?: string) => nav(`/billing/receipt/${encodeURIComponent(reference)}${msg ? `?msg=${encodeURIComponent(msg)}` : ""}`, { replace: true });
    if (!reference) { nav("/billing", { replace: true }); return; }
    if (provider === "flutterwave" && params.get("status") === "cancelled") { show("You cancelled the payment. No money was taken."); return; }
    const body = provider === "flutterwave"
      ? { provider, transaction_id: params.get("transaction_id") ?? undefined }
      : { provider, reference };
    api("/billing/verify", { body }).then(async () => { await refresh(); show(); }).catch((e) => show((e as ApiError).message));
  }, []);
  return <Card className="mx-auto max-w-md text-center"><p className="flex items-center justify-center gap-2"><Spinner />Confirming your payment…</p></Card>;
}
