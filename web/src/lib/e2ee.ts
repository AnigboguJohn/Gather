/**
 * End-to-end encryption keys never reach the server: they live in the link's #fragment
 * (browsers don't send fragments to servers) and in the host's browser.
 */
// localStorage key holding the secret for one meeting.
const k = (slug: string) => `gather.e2ee.${slug}`;
/** Make a random 192-bit key, URL-safe base64 so it fits in a link. */
export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Remember a meeting's key in this browser (so the host can share the secure link later). */
export function saveKey(slug: string, key: string) { try { localStorage.setItem(k(slug), key); } catch { /* ignore */ } }
/** The key saved for a meeting, if this browser has it. */
export function loadKey(slug: string): string | null { try { return localStorage.getItem(k(slug)); } catch { return null; } }
/** Read the key from the current URL's #k=... fragment (the secure link a guest opened). */
export function keyFromHash(): string | null {
  const m = window.location.hash.match(/[#&]k=([\w-]+)/);
  return m ? m[1] : null;
}
/** Adds the key to a join URL (and to share text) when the meeting is encrypted. */
export function withKey(url: string, slug: string, e2ee: boolean) {
  if (!e2ee) return url;
  const key = loadKey(slug);
  return key ? `${url}#k=${key}` : url;
}
