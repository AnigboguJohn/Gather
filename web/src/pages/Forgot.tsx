/**
 * Forgot password ("/forgot"): email → 6-digit code → new password → sign in.
 * The server answers the same whether or not the email has an account, so the page always says "if it's yours".
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { AuthShell, CodeTimers, ErrorNote, field, Heading, OtpInput, PasswordInput, PasswordRules, passwordOk, useNow, type Side } from "./AuthKit";

const side = (step: number): Side => ({
  chip: "Account help",
  title: "Locked out? Let's get you back in",
  text: "Reset your password in three quick steps. Your meetings, history and team stay just as they were.",
  steps: ["Enter your email", "Confirm the code", "Choose a new password"], step,
});

export default function Forgot() {
  const nav = useNavigate();
  const now = useNow();
  const [params] = useSearchParams();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sent, setSent] = useState<{ expiresAt: number; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [ok, setOk] = useState(false);
  const [resetToken, setResetToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const r = await api<{ expiresInSeconds: number; resendInSeconds: number }>("/auth/reset/start", { body: { email: email.trim().toLowerCase() }, token: null });
    setSent({ expiresAt: Date.now() + r.expiresInSeconds * 1000, resendAt: Date.now() + r.resendInSeconds * 1000 });
    setCode("");
  };
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await send(); setStep(2); } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  const verify = async (c: string) => {
    if (c.length !== 6 || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ resetToken: string }>("/auth/reset/verify", { body: { email: email.trim().toLowerCase(), code: c }, token: null });
      setResetToken(r.resetToken); setOk(true);
      setTimeout(() => { setStep(3); setOk(false); }, 700);
    } catch (err) { setError((err as ApiError).message); setCode(""); } finally { setBusy(false); }
  };
  useEffect(() => { if (step === 2 && code.length === 6) verify(code); }, [code]);
  const choose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordOk(password, { email })) { setError("Your new password doesn't meet all the rules yet."); return; }
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true); setError(null);
    try {
      await api("/auth/reset/complete", { body: { resetToken, password }, token: null });
      toast("Password changed");
      nav(`/signin?reset=1&email=${encodeURIComponent(email.trim().toLowerCase())}`, { replace: true });
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 401) { setStep(1); setSent(null); }
      setError(e.message); setBusy(false);
    }
  };

  return (
    <AuthShell side={side(step)}>
      {step === 1 && <>
        <Heading title="Forgot your password?">Enter your email and we'll send you a 6-digit code to reset it.</Heading>
        <form onSubmit={start} className="space-y-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-stone-700">Email</span>
            <input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={field} />
          </label>
          <ErrorNote error={error} />
          <Button className="w-full !rounded-xl !py-3.5" loading={busy}>Send reset code</Button>
          <Link to="/signin" className="block w-full rounded-xl border border-stone-200 py-3 text-center text-sm font-semibold text-stone-700 hover:bg-stone-50">Back to sign in</Link>
        </form>
      </>}

      {step === 2 && sent && <>
        <Heading title={ok ? "Thanks!" : "Enter your code"}>
          {ok ? "Code confirmed. Now choose a new password…" : <>If <b className="text-stone-700">{email}</b> has a Gather account, a 6-digit code is on its way. It may take a minute.</>}
        </Heading>
        <form onSubmit={(e) => { e.preventDefault(); verify(code); }} className="space-y-5">
          <OtpInput value={code} onChange={setCode} disabled={busy || now >= sent.expiresAt} ok={ok} autoFocus />
          <CodeTimers now={now} expiresAt={sent.expiresAt} resendAt={sent.resendAt} resending={resending}
            onResend={async () => { setResending(true); setError(null); try { await send(); toast("New code sent"); } catch (err) { setError((err as ApiError).message); } finally { setResending(false); } }} />
          <ErrorNote error={error} />
          <Button className="w-full !rounded-xl !py-3.5" loading={busy} disabled={code.length !== 6 || ok}>Confirm code</Button>
          <button type="button" onClick={() => { setStep(1); setError(null); }} className="w-full rounded-xl border border-stone-200 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-50">Back</button>
        </form>
      </>}

      {step === 3 && <>
        <Heading title="Choose a new password">For <b className="text-stone-700">{email}</b>. You'll use it to sign in from now on.</Heading>
        <form onSubmit={choose} className="space-y-4">
          <label className="block"><span className="mb-1.5 block text-sm font-medium text-stone-700">New password</span>
            <PasswordInput required autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <PasswordRules password={password} email={email} />
          <label className="block"><span className="mb-1.5 block text-sm font-medium text-stone-700">Confirm new password</span>
            <PasswordInput required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <ErrorNote error={error} />
          <Button className="w-full !rounded-xl !py-3.5" loading={busy}>Save new password</Button>
        </form>
      </>}
    </AuthShell>
  );
}
