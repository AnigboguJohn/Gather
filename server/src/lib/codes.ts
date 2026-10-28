/** One-time codes (sign-in, guest verification). Pure functions, unit tested. */
import crypto from "node:crypto";

// A code expires 10 minutes after it is sent and locks after 5 wrong guesses.
export const CODE_TTL_MINUTES = 3;
export const CODE_MAX_ATTEMPTS = 5;

/** Random 6-digit code; leading zeros kept. */
export const generateCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

/** HMAC so a database leak does not reveal live codes. */
export const hashCode = (code: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(code.replace(/\s+/g, "")).digest("hex");

/** Constant-time compare. */
export function codeMatches(code: string, storedHash: string, secret: string): boolean {
  const a = Buffer.from(hashCode(code, secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Short, readable, URL-safe meeting code like "kdt-qmra-wpe" (no look-alike letters). */
export function meetingSlug(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz";
  const part = (n: number) => Array.from({ length: n }, () => abc[crypto.randomInt(0, abc.length)]).join("");
  return `${part(3)}-${part(4)}-${part(3)}`;
}

/** Passcodes are short, so use scrypt with a random salt. Format: salt:hash */
/**
 * Meeting passcodes are short and guessable, so use a slow hash (scrypt) with a random salt.
 * Stored format: "salt:hash" (both hex).
 */
export function hashPasscode(pass: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pass, salt, 32).toString("hex")}`;
}
/** Check a passcode against the stored "salt:hash" (constant-time; false for malformed values). */
export function passcodeMatches(pass: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pass, salt, 32);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
