/**
 * Plans and limits (the business rules behind billing).
 *  - Free: meetings last up to 2 hours (FREE_MEETING_MINUTES), up to 100 people.
 *  - Pro / Business: no practical length limit (24-hour safety cap), recordings and dial-in.
 * Prices are in Naira per month; payments are handled in modules/billing.routes.ts.
 */
import { config } from "../config.js";

/** Plan ids as stored in organizations.plan. */
export type Plan = "free" | "pro" | "business";

/** What each plan includes. Used for limits on the server and shown on the billing page. */
export const PLANS: Record<Plan, {
  name: string; priceNgnMonthly: number; maxParticipants: number; recordings: boolean; dialIn: boolean;
}> = {
  free: { name: "Free", priceNgnMonthly: 0, maxParticipants: 100, recordings: false, dialIn: false },
  pro: { name: "Pro", priceNgnMonthly: 5000, maxParticipants: 150, recordings: true, dialIn: true },
  business: { name: "Business", priceNgnMonthly: 15000, maxParticipants: 300, recordings: true, dialIn: true },
};

/** A paid plan only counts while it is paid up; otherwise the org is on Free. */
export function effectivePlan(org: { plan: string; paid_until: Date | string | null }, now = new Date()): Plan {
  if (org.plan === "free" || !org.paid_until) return "free";
  return new Date(org.paid_until) > now ? (org.plan as Plan) : "free";
}

/** How long one meeting may run on this plan; sets sessions.ends_at when a room starts. */
export function meetingLimitMinutes(plan: Plan): number {
  return plan === "free" ? config.freeMeetingMinutes : config.paidMeetingMinutes;
}

/** Amount to charge in kobo (NGN minor units). */
export function priceMinor(plan: Plan, months: number): number {
  return PLANS[plan].priceNgnMonthly * 100 * months;
}
