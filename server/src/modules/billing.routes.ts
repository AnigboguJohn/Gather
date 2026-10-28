/**
 * Payments: Paystack and Flutterwave (cards, bank transfer, USSD, mobile money).
 *
 * Flow: the host picks a plan → we create a pending payment and ask the provider for a checkout link →
 * the host pays on the provider's page → the provider redirects back (we verify with the provider's API)
 * and also calls our webhook (signature checked). Either path activates the plan; activation is idempotent.
 * Amounts are always checked against what we asked for, so a tampered redirect can't upgrade for less.
 *
 * With no keys set, DEMO_PAYMENTS gives a fake checkout page so the whole flow can be tried locally.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { one, q, tx } from "../db.js";
import { log } from "../log.js";
import { requireAdmin, requireAuth } from "../lib/auth.js";
import { ah, HttpError, parse } from "../lib/http.js";
import { sendEmail } from "../lib/notify.js";
import { effectivePlan, meetingLimitMinutes, PLANS, priceMinor, type Plan } from "../lib/plans.js";

// Routes: /billing, /billing/checkout, /billing/verify, /billing/demo/complete, /billing/webhooks/*
export const billingRouter = Router();
/** Payment providers we support ("demo" = fake checkout for local testing). */
type Provider = "paystack" | "flutterwave" | "demo";

/** Providers with keys configured (plus demo when DEMO_PAYMENTS=true), in the order shown to users. */
export const providersAvailable = (): Provider[] => [
  ...(config.paystack.secretKey ? ["paystack" as const] : []),
  ...(config.flutterwave.secretKey ? ["flutterwave" as const] : []),
  ...(config.demoPayments ? ["demo" as const] : []),
];

/* ---------- Signature checks (exported for tests) ---------- */
/** Paystack signs the raw webhook body with HMAC-SHA512 using your secret key (x-paystack-signature header). */
export function paystackSignatureValid(raw: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Flutterwave sends the "secret hash" you set in its dashboard in the verif-hash header. */
export function flutterwaveSignatureValid(header: string | undefined, hash: string): boolean {
  if (!header || !hash) return false;
  const a = Buffer.from(header), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Payment methods as shown on receipts. */
const PROVIDER_NAME: Record<Provider, string> = { paystack: "Paystack", flutterwave: "Flutterwave", demo: "Demo checkout (no real money)" };
/** Kobo → "₦5,000". */
const naira = (minor: number) => `₦${(Number(minor) / 100).toLocaleString("en-NG")}`;

/** Email the payer a receipt once a payment succeeds (failures are logged by sendEmail, never thrown). */
async function sendReceipt(reference: string) {
  const p = await one(
    `SELECT p.*, u.email, u.name, o.name AS org_name, o.paid_until FROM payments p
     JOIN organizations o ON o.id = p.org_id LEFT JOIN users u ON u.id = p.user_id WHERE p.reference = $1`, [reference]);
  if (!p?.email) return;
  const until = new Date(p.paid_until).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  await sendEmail({
    to: p.email, kind: "payment_receipt", subject: `Payment received: Gather ${PLANS[p.plan as Plan].name} for ${p.org_name}`,
    text: [
      `Hi ${p.name?.split(" ")[0] ?? "there"},`, "",
      `Thank you. Your payment was successful and ${p.org_name} is now on Gather ${PLANS[p.plan as Plan].name}.`, "",
      `Order number: ${p.reference}`,
      `Plan: ${PLANS[p.plan as Plan].name} × ${p.months} month${p.months > 1 ? "s" : ""}`,
      `Amount paid: ${naira(p.amount_minor)}`,
      `Paid with: ${PROVIDER_NAME[p.provider as Provider]}`,
      `Active until: ${until}`, "",
      "Nothing renews automatically. Pay again from Plan and billing to extend.",
      `${config.appUrl}/billing/receipt/${p.reference}`,
    ].join("\n"),
  });
}

/** Mark a payment successful and extend the plan. Safe to call many times for the same reference. */
export async function activate(reference: string, paid: { amountMinor: number; currency: string; raw?: unknown }) {
  const r = await tx(async (c) => {
    /**     // Lock the payment row so the redirect and the webhook arriving together cannot both extend the plan. */
    const p = (await c.query("SELECT * FROM payments WHERE reference = $1 FOR UPDATE", [reference])).rows[0];
    if (!p) throw new HttpError(404, "Unknown payment.");
    /**     // Already activated (e.g. by the webhook): do nothing, report it. */
    if (p.status === "success") return { already: true, plan: p.plan };
    /**     // Never upgrade for less than we asked (or in another currency). */
    if (Number(paid.amountMinor) < Number(p.amount_minor) || paid.currency.toUpperCase() !== p.currency) {
      await c.query("UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1", [p.id, JSON.stringify({ reason: "amount mismatch", paid })]);
      return { mismatch: true as const };
    }
    await c.query("UPDATE payments SET status = 'success', paid_at = now(), raw = $2 WHERE id = $1", [p.id, JSON.stringify(paid.raw ?? null)]);
    // Extend from the later of now and the current paid-up date.
    await c.query(
      `UPDATE organizations SET plan = $2,
         paid_until = greatest(coalesce(paid_until, now()), now()) + ($3 || ' days')::interval WHERE id = $1`,
      [p.org_id, p.plan, String(30 * p.months)]);
    log.info({ reference, plan: p.plan, org: p.org_id }, "plan activated");
    return { already: false, plan: p.plan };
  });
  if ("mismatch" in r) throw new HttpError(400, "Payment amount does not match.");
  // Only the call that actually activated the plan sends the receipt (the redirect and webhook may both arrive).
  if (!r.already) sendReceipt(reference).catch((e) => log.warn({ err: e?.message, reference }, "receipt"));
  return r;
}

/* ---------- Provider calls ---------- */
/** Ask Paystack for a checkout page; returns the URL to send the user to. */
async function paystackInit(o: { email: string; amount: number; reference: string; callback: string; metadata: unknown }) {
  const r = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST", headers: { authorization: `Bearer ${config.paystack.secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ email: o.email, amount: o.amount, currency: "NGN", reference: o.reference, callback_url: o.callback, metadata: o.metadata }),
  });
  const j: any = await r.json();
  if (!r.ok || !j.status) throw new HttpError(502, `Paystack: ${j.message ?? r.status}`);
  return j.data.authorization_url as string;
}
/** Ask Paystack whether a payment really succeeded, and for how much. */
async function paystackVerify(reference: string) {
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { authorization: `Bearer ${config.paystack.secretKey}` },
  });
  const j: any = await r.json();
  if (!r.ok || !j.status) throw new HttpError(502, `Paystack: ${j.message ?? r.status}`);
  return { ok: j.data.status === "success", amountMinor: j.data.amount, currency: j.data.currency, raw: j.data };
}
/** Ask Flutterwave for a checkout link (Flutterwave takes amounts in Naira, not kobo). */
async function flutterwaveInit(o: { email: string; name: string; amount: number; reference: string; callback: string }) {
  const r = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST", headers: { authorization: `Bearer ${config.flutterwave.secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      tx_ref: o.reference, amount: o.amount / 100, currency: "NGN", redirect_url: o.callback,
      customer: { email: o.email, name: o.name }, customizations: { title: "Gather" },
    }),
  });
  const j: any = await r.json();
  if (!r.ok || j.status !== "success") throw new HttpError(502, `Flutterwave: ${j.message ?? r.status}`);
  return j.data.link as string;
}
/** Ask Flutterwave whether a transaction succeeded; also returns our reference (tx_ref). */
async function flutterwaveVerify(transactionId: string) {
  const r = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { authorization: `Bearer ${config.flutterwave.secretKey}` },
  });
  const j: any = await r.json();
  if (!r.ok || j.status !== "success") throw new HttpError(502, `Flutterwave: ${j.message ?? r.status}`);
  return { ok: j.data.status === "successful", reference: j.data.tx_ref as string, amountMinor: Math.round(j.data.amount * 100), currency: j.data.currency, raw: j.data };
}

/* ---------- Routes ---------- */
/** Current plan, paid-up date, available providers, plan list and payment history for the billing page. */
billingRouter.get("/billing", requireAuth, ah(async (req, res) => {
  const org = await one("SELECT plan, paid_until FROM organizations WHERE id = $1", [req.user!.orgId]);
  const current = effectivePlan(org);
  const payments = await q(
    "SELECT reference, provider, plan, months, amount_minor, currency, status, created_at, paid_at FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50",
    [req.user!.orgId]);
  res.json({
    current, paidUntil: org.paid_until, providers: providersAvailable(),
    plans: (Object.keys(PLANS) as Plan[]).map((id) => ({ id, ...PLANS[id], meetingLimitMinutes: meetingLimitMinutes(id) })),
    payments,
  });
}));

/** One payment of my workspace, for the confirmation / receipt page. */
billingRouter.get("/billing/payments/:reference", requireAuth, ah(async (req, res) => {
  const p = await one(
    `SELECT p.reference, p.provider, p.plan, p.months, p.amount_minor, p.currency, p.status, p.created_at, p.paid_at,
            u.name AS payer_name, u.email AS payer_email, o.name AS org_name, o.paid_until
     FROM payments p JOIN organizations o ON o.id = p.org_id LEFT JOIN users u ON u.id = p.user_id
     WHERE p.reference = $1 AND p.org_id = $2`, [req.params.reference, req.user!.orgId]);
  if (!p) throw new HttpError(404, "We couldn't find that payment.");
  res.json({ ...p, plan_name: PLANS[p.plan as Plan].name, provider_name: PROVIDER_NAME[p.provider as Provider] });
}));

/** Admins: start paying for a plan. Creates a pending payment with our own reference, returns the checkout URL. */
billingRouter.post("/billing/checkout", requireAuth, requireAdmin, ah(async (req, res) => {
  const b = parse(z.object({
    plan: z.enum(["pro", "business"]), months: z.number().int().min(1).max(12).default(1),
    provider: z.enum(["paystack", "flutterwave", "demo"]),
  }), req.body);
  if (!providersAvailable().includes(b.provider)) throw new HttpError(400, `${b.provider} is not set up on this server.`);
  /**   // The price comes from our plan table, never from the browser. */
  const amount = priceMinor(b.plan, b.months);
  const reference = `gth_${crypto.randomBytes(9).toString("hex")}`;
  await q("INSERT INTO payments (org_id, user_id, provider, reference, plan, months, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,'NGN')",
    [req.user!.orgId, req.user!.id, b.provider, reference, b.plan, b.months, amount]);
  const callback = `${config.appUrl}/billing/return?provider=${b.provider}`;
  let url: string;
  if (b.provider === "paystack") url = await paystackInit({ email: req.user!.email, amount, reference, callback, metadata: { org: req.user!.orgId, plan: b.plan } });
  else if (b.provider === "flutterwave") url = await flutterwaveInit({ email: req.user!.email, name: req.user!.name, amount, reference, callback });
  else url = `${config.appUrl}/billing/demo?reference=${reference}`;
  res.json({ url, reference, amountMinor: amount, currency: "NGN" });
}));

/** Called by the web app when the provider redirects back. */
/** After the provider redirects back: confirm with the provider's API (never trust the redirect alone), then activate. */
billingRouter.post("/billing/verify", requireAuth, ah(async (req, res) => {
  const b = parse(z.object({
    provider: z.enum(["paystack", "flutterwave", "demo"]), reference: z.string().max(80).optional(), transaction_id: z.string().max(40).optional(),
  }), req.body);
  if (b.provider === "paystack") {
    if (!b.reference) throw new HttpError(400, "Missing reference.");
    await ownPayment(req.user!.orgId, b.reference);
    const v = await paystackVerify(b.reference);
    if (!v.ok) { await markFailed(b.reference, v.raw?.status); throw new HttpError(402, "The payment was not completed."); }
    return res.json(await activate(b.reference, v));
  }
  if (b.provider === "flutterwave") {
    if (!b.transaction_id) throw new HttpError(400, "Missing transaction id.");
    const v = await flutterwaveVerify(b.transaction_id);
    await ownPayment(req.user!.orgId, v.reference);
    if (!v.ok) { await markFailed(v.reference, v.raw?.status); throw new HttpError(402, "The payment was not completed."); }
    return res.json(await activate(v.reference, v));
  }
  throw new HttpError(400, "Use the demo checkout.");
}));

/** The provider says this payment failed or was abandoned: record it (a successful one is never downgraded). */
async function markFailed(reference: string, providerStatus: unknown) {
  await q("UPDATE payments SET status = 'failed', raw = $2 WHERE reference = $1 AND status = 'pending'", [reference, JSON.stringify({ providerStatus })]);
}

/** Make sure a payment reference belongs to the caller's workspace. */
async function ownPayment(orgId: string, reference: string) {
  const p = await one("SELECT org_id FROM payments WHERE reference = $1", [reference]);
  if (!p || p.org_id !== orgId) throw new HttpError(404, "Unknown payment.");
}

/** Demo checkout (no real money): "Pay" or "Cancel". */
/** Demo checkout result: "success" activates the plan, "cancel" marks the payment failed. */
billingRouter.post("/billing/demo/complete", requireAuth, ah(async (req, res) => {
  if (!config.demoPayments) throw new HttpError(404, "Demo payments are off.");
  const b = parse(z.object({ reference: z.string().max(80), outcome: z.enum(["success", "cancel"]) }), req.body);
  const p = await one("SELECT * FROM payments WHERE reference = $1 AND org_id = $2 AND provider = 'demo'", [b.reference, req.user!.orgId]);
  if (!p) throw new HttpError(404, "Unknown payment.");
  if (b.outcome === "cancel") {
    await q("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [p.id]);
    return res.json({ cancelled: true });
  }
  res.json(await activate(b.reference, { amountMinor: Number(p.amount_minor), currency: p.currency, raw: { demo: true } }));
}));

/* Webhooks: raw body is kept by express.json's verify hook (see app.ts). */
/** Paystack webhook: verified by signature; charge.success activates the plan (idempotent). */
billingRouter.post("/billing/webhooks/paystack", ah(async (req: any, res) => {
  if (!paystackSignatureValid(req.rawBody ?? "", req.get("x-paystack-signature"), config.paystack.secretKey)) {
    return res.status(401).json({ error: "bad signature" });
  }
  const ev = req.body;
  if (ev?.event === "charge.success") {
    await activate(ev.data.reference, { amountMinor: ev.data.amount, currency: ev.data.currency, raw: ev.data }).catch((e) => log.warn({ err: e?.message }, "paystack webhook"));
  }
  res.json({ ok: true });
}));

/** Flutterwave webhook: verified by secret hash, then double-checked with Flutterwave's API before activating. */
billingRouter.post("/billing/webhooks/flutterwave", ah(async (req, res) => {
  if (!flutterwaveSignatureValid(req.get("verif-hash"), config.flutterwave.webhookHash)) return res.status(401).json({ error: "bad signature" });
  const d = req.body?.data;
  if (d?.status === "successful" && d.id) {
    // Never trust webhook amounts alone: confirm with Flutterwave.
    const v = await flutterwaveVerify(String(d.id)).catch(() => null);
    if (v?.ok) await activate(v.reference, v).catch((e) => log.warn({ err: e?.message }, "flutterwave webhook"));
  }
  res.json({ ok: true });
}));
