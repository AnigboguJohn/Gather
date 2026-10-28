/**
 * Account safety rules shared by sign-up, password reset, profile edits and the admin panel:
 *  - phone numbers: must start with the country code, must be a real, dialable number for that country's
 *    numbering plan, are stored in international form (E.164) and may belong to one account only;
 *  - passwords: strong rules, and never one that has appeared in a data breach (checked privately against
 *    Have I Been Pwned: only the first 5 characters of the password's SHA-1 hash ever leave the server).
 */
import crypto from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { one } from "../db.js";
import { log } from "../log.js";
import { HttpError } from "./http.js";

/**
 * "+234 803 123 4567" → "+2348031234567". Throws a readable 400 if the country code is missing or the number
 * can't exist (wrong length or prefix for that country). Checks every country's numbering plan.
 */
export function normalizePhone(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith("+")) throw new HttpError(400, "Add your country code, e.g. +234 for Nigeria or +254 for Kenya.", { field: "phone" });
  const n = parsePhoneNumberFromString(s);
  if (!n || !n.isValid()) throw new HttpError(400, "That phone number doesn't exist. Check the country code and the number.", { field: "phone" });
  return n.number; // E.164
}

/** Phone numbers can belong to one account only. `exceptUserId`: the person editing their own profile. */
export async function assertPhoneFree(e164: string, exceptUserId?: string) {
  const taken = await one("SELECT 1 FROM users WHERE phone = $1 AND id IS DISTINCT FROM $2", [e164, exceptUserId ?? null]);
  if (taken) throw new HttpError(409, "This phone number is already used by another Gather account.", { field: "phone" });
}

/** The password rules, in the order they're shown to people. */
export function passwordProblems(pw: string, context: { email?: string; name?: string } = {}): string[] {
  const out: string[] = [];
  if (pw.length < 12) out.push("Use at least 12 characters.");
  if (!/[a-z]/.test(pw)) out.push("Add a lowercase letter.");
  if (!/[A-Z]/.test(pw)) out.push("Add a capital letter.");
  if (!/\d/.test(pw)) out.push("Add a number.");
  if (!/[^A-Za-z0-9]/.test(pw)) out.push("Add a symbol, like ! ? # or @.");
  if (/(.)\1\1/.test(pw)) out.push("Don't repeat the same character 3 times in a row.");
  const lower = pw.toLowerCase();
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) out.push("Don't use your email address in your password.");
  for (const part of (context.name ?? "").toLowerCase().split(/\s+/)) if (part.length >= 3 && lower.includes(part)) { out.push("Don't use your name in your password."); break; }
  if (/(password|qwerty|123456|abcdef|gather|letmein|welcome|iloveyou|admin)/.test(lower)) out.push("Avoid common words like \"password\", \"qwerty\" or \"123456\".");
  return out;
}

/**
 * How many times this password appears in known data breaches (Have I Been Pwned "range" API, k-anonymity:
 * only the first 5 hex characters of its SHA-1 are sent). Returns 0 if the service can't be reached.
 */
async function breachCount(pw: string): Promise<number> {
  const sha = crypto.createHash("sha1").update(pw).digest("hex").toUpperCase();
  // Slow mobile networks: allow 10 seconds and try twice before giving up (then only the rules apply).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      for (const line of (await r.text()).split("\n")) {
        const [suffix, count] = line.trim().split(":");
        if (suffix === sha.slice(5)) return Number(count) || 0;
      }
      return 0;
    } catch (e: any) {
      if (attempt === 2) log.warn({ err: e?.message }, "breached-password check unavailable");
    }
  }
  return 0;
}

/** Throw a readable 400 if the password breaks a rule or has appeared in a data breach. */
export async function assertStrongPassword(pw: string, context: { email?: string; name?: string } = {}) {
  const problems = passwordProblems(pw, context);
  if (problems.length) throw new HttpError(400, problems[0], { field: "password", problems });
  if ((await breachCount(pw)) > 0) {
    throw new HttpError(400, "This password has appeared in a data breach, so hackers already know it. Choose a different one.", { field: "password" });
  }
}
