/**
 * Small fetch wrapper used by every page: JSON in/out, the signed-in session token from localStorage,
 * and readable error messages (the server sends { error: "..." }).
 */
// Where the host's session token is kept in the browser.
const TOKEN_KEY = "gather.token";

/** Read the saved session token: a remembered one (localStorage) or this tab's (sessionStorage). */
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
/**
 * Save or clear the session token. "Remember me" keeps it after the browser closes (localStorage);
 * otherwise it lasts until the tab closes (sessionStorage). Private-mode browsers may block storage; we ignore that.
 */
export const setToken = (t: string | null, remember = true) => {
  try {
    localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
    if (t) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
  } catch { /* private mode */ }
};

/** Error thrown for non-2xx replies: HTTP status, the server's message, and any extra fields (e.g. which form field). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public data: any = {}) { super(message); }
}

/**
 * Call the Gather API: api("/meetings") → GET, api("/x", { body }) → POST JSON, api("/x", { form }) → POST multipart.
 * Pass token: null for public calls (guest join, RSVP) so a signed-in session isn't sent.
 */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; token?: string | null; form?: FormData } = {}): Promise<T> {
  const token = opts.token === undefined ? getToken() : opts.token;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
    headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!r.ok) {
    // An expired session anywhere signs the user out (AuthProvider listens for this event).
    if (r.status === 401 && token && !path.startsWith("/public") && !path.startsWith("/admin")) window.dispatchEvent(new Event("gather:signedout"));
    throw new ApiError(r.status, data.error ?? `Request failed (${r.status})`, data);
  }
  return data as T;
}
