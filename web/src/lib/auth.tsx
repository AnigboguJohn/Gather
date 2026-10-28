/**
 * Sign-in state for the whole app (React context).
 * Loads the current user, workspace, plan and server features from GET /api/me,
 * and exposes signIn/signOut so pages don't handle tokens themselves.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "./api";

/** Everything the app needs about the signed-in host: profile, workspace, plan limits, calendar and integrations. */
export interface Me {
  user: { id: string; name: string; email: string; phone: string | null; language: string; role: "owner" | "admin" | "member"; onboarded: boolean };
  org: { id: string; name: string; kind: "individual" | "company"; country: string; dataRegion: string };
  plan: { id: "free" | "pro" | "business"; name: string; meetingLimitMinutes: number; maxParticipants: number; recordings: boolean; dialIn: boolean; paidUntil: string | null };
  calendar: { feedUrl: string; google: { available: boolean; connected: boolean }; microsoft: { available: boolean; connected: boolean } };
  integrations: { whatsapp: boolean; sms: boolean; dialIn: boolean };
  languages: { id: string; name: string }[];
}

// What useAuth() returns.
interface Ctx { me: Me | null; loading: boolean; refresh: () => Promise<void>; signIn: (token: string, remember?: boolean) => Promise<void>; signOut: () => void }
const AuthCtx = createContext<Ctx>(null as any);

/** Wrap the app with this once (main.tsx). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  // Re-read /me (after sign-in, profile changes or an upgrade). No token = signed out.
  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try { setMe(await api<Me>("/me")); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    refresh();
    // api.ts fires "gather:signedout" when any request gets 401: drop the session everywhere.
    const out = () => { setToken(null); setMe(null); };
    window.addEventListener("gather:signedout", out);
    return () => window.removeEventListener("gather:signedout", out);
  }, [refresh]);
  const signIn = async (t: string, remember = true) => { setToken(t, remember); await refresh(); };
  const signOut = () => { setToken(null); setMe(null); };
  return <AuthCtx.Provider value={{ me, loading, refresh, signIn, signOut }}>{children}</AuthCtx.Provider>;
}
/** Hook: const { me, signIn, signOut } = useAuth(); */
export const useAuth = () => useContext(AuthCtx);
