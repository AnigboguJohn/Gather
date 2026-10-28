/**
 * Sign-in page ("/signin"): email + password, or "Email me a code instead" (six-box one-time code).
 * "Remember me" keeps you signed in for 30 days; unticked, the sign-in ends when the tab closes.
 * Forgot password → /forgot. New hosts create an account at /signup. Guests never need one.
 */
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AuthShell, CodeTimers, ErrorNote, field, Heading, OtpInput, PasswordInput, RememberMe, useNow, type Side } from "./AuthKit";

const SIDE: Side = {
  chip: "Welcome back",
  title: "Meetings that work on weak data, in your language",
  text: "Start a call in one tap, share it on WhatsApp, and everyone gets a summary in their own language when it ends.",
};

export default function SignIn() {
  const { me, signIn } = useAuth();
  const nav = useNavigate();
  const now = useNow();
  const [params] = useSearchParams();
  // Where to go after signing in (set by the Private guard, e.g. a /j/ link the host opened).
  const next = params.get("next") || "/home";
  const [mode, setMode] = useState<"password" | "code">("password");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [sent, setSent] = useState<{ expiresAt: number; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Signed in: welcome a new team member, then go where they were headed. */
  const finish = async (token: string) => {
    await signIn(token, remember);
    if (params.get("joined")) toast(`Welcome to the ${params.get("joined")} team! You can now host and join its meetings.`);
    nav(next, { replace: true });
  };
  const withPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await api<{ token: string }>("/auth/login", { body: { email, password, remember }, token: null }); await finish(r.token); }
    catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  const sendCode = async () => {
    setError(null);
    const r = await api<{ expiresInSeconds: number; resendInSeconds: number }>("/auth/code/start", { body: { email }, token: null });
    setSent({ expiresAt: Date.now() + r.expiresInSeconds * 1000, resendAt: Date.now() + r.resendInSeconds * 1000 });
    setCode("");
  };
  const startCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await sendCode(); } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  const verifyCode = async (c: string) => {
    if (c.length !== 6 || busy) return;
    setBusy(true); setError(null);
    try { const r = await api<{ token: string }>("/auth/code/verify", { body: { email, code: c, remember }, token: null }); await finish(r.token); }
    catch (err) { setError((err as ApiError).message); setCode(""); setBusy(false); }
  };
  useEffect(() => { if (code.length === 6) verifyCode(code); }, [code]);

  if (me) return <Navigate to={next} replace />;
  // Old "Start free" links (/signin?new=1) go to the sign-up flow.
  if (params.get("new")) return <Navigate to="/signup" replace />;
  const switchMode = (m: "password" | "code") => { setMode(m); setError(null); setSent(null); setCode(""); };

  const banner = params.get("created")
    ? <p className="mb-5 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-800">{params.get("joined") ? <>You've joined <b>{params.get("joined")}</b>. Sign in with your email and the password you just chose.</> : "Your account is ready. Sign in with your email and password."}</p>
    : params.get("reset")
      ? <p className="mb-5 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-800">Your password was changed. Sign in with the new one.</p>
      : null;

  // Code sent: the six boxes
  if (mode === "code" && sent) {
    return (
      <AuthShell side={SIDE}>
        <Heading title="Enter your code">We sent a 6-digit code to <b className="text-stone-700">{email}</b>. It may take a minute to arrive.</Heading>
        <form onSubmit={(e) => { e.preventDefault(); verifyCode(code); }} className="space-y-5">
          <OtpInput value={code} onChange={setCode} disabled={busy || now >= sent.expiresAt} autoFocus />
          <CodeTimers now={now} expiresAt={sent.expiresAt} resendAt={sent.resendAt} resending={resending}
            onResend={async () => { setResending(true); try { await sendCode(); toast("New code sent"); } catch (err) { setError((err as ApiError).message); } finally { setResending(false); } }} />
          <RememberMe checked={remember} onChange={setRemember} />
          <ErrorNote error={error} />
          <Button className="w-full !rounded-xl !py-3.5" loading={busy} disabled={code.length !== 6}>Sign in</Button>
          <button type="button" onClick={() => setSent(null)} className="w-full rounded-xl border border-stone-200 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-50">Back</button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell side={SIDE}>
      <Heading title="Welcome back!">Sign in to start or join your meetings.</Heading>
      {banner}
      {/* Password or one-time code */}
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 text-sm font-semibold" role="tablist" aria-label="How to sign in">
        {([["password", "Password"], ["code", "Email me a code"]] as const).map(([m, l]) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => switchMode(m)} className={`rounded-lg py-2 transition ${mode === m ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"}`}>{l}</button>
        ))}
      </div>
      <form onSubmit={mode === "password" ? withPassword : startCode} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-stone-700">Email</span>
          <input type="email" required autoFocus={!email} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={field} />
        </label>
        {mode === "password" ? (
          <>
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-stone-700">Password<Link to={`/forgot${email ? `?email=${encodeURIComponent(email)}` : ""}`} className="text-xs font-semibold text-brand-700 hover:underline">Forgot password?</Link></span>
              <PasswordInput required autoFocus={Boolean(email)} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <RememberMe checked={remember} onChange={setRemember} />
          </>
        ) : (
          <p className="flex items-center gap-2 rounded-xl bg-stone-50 px-3 py-2.5 text-sm text-stone-600"><Icon name="key" size={16} className="shrink-0 text-brand-700" />No password needed. We'll email you a 6-digit code.</p>
        )}
        <ErrorNote error={error} />
        <Button className="w-full !rounded-xl !py-3.5" loading={busy}>{mode === "password" ? "Sign in" : "Send code"}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-stone-500">New to Gather? <Link to="/signup" className="font-semibold text-brand-700 hover:underline">Create account</Link></p>
      <p className="mt-2 text-center text-xs text-stone-500">Joining someone's meeting? Open their link. Guests don't need an account.</p>
    </AuthShell>
  );
}
