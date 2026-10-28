/**
 * Sign-up in three pages, then sign in:
 *  /signup          email → we send a 6-digit code (a team invite link fills the email in)
 *  /signup/verify   type the code in six boxes (countdown until it expires, resend after a short wait)
 *  /signup/details  name, phone, workspace, password → account saved → /signin
 */
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { LANGS } from "../lib/format";
import { PhoneInput, phoneValid } from "../components/PhoneInput";
import { AuthShell, CodeTimers, ErrorNote, field, Heading, OtpInput, PasswordInput, PasswordRules, passwordOk, useNow, type Side } from "./AuthKit";

/** Progress through sign-up, kept in sessionStorage so a page refresh doesn't lose it. */
interface Pending { email: string; expiresAt: number; resendAt: number; signupToken?: string; invitedTo?: string | null }
const KEY = "gather.signup";
const load = (): Pending | null => { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } };
const save = (p: Pending | null) => { try { p ? sessionStorage.setItem(KEY, JSON.stringify(p)) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } };

/** Ask the server to email a sign-up code and remember when it expires and when a new one may be sent. */
async function sendCode(email: string): Promise<Pending> {
  const r = await api<{ expiresInSeconds: number; resendInSeconds: number }>("/auth/signup/start", { body: { email }, token: null });
  const p = { email, expiresAt: Date.now() + r.expiresInSeconds * 1000, resendAt: Date.now() + r.resendInSeconds * 1000 };
  save(p);
  return p;
}

/** The brand panel for sign-up, with the step we're on. */
const side = (step: number, invite?: boolean): Side => ({
  chip: invite ? "You're invited 👋" : "Join Gather",
  title: invite ? "Join your team on Gather" : "Start your first meeting in minutes",
  text: "Calls that work on weak data, captions in your language, and a summary for everyone when it ends. Free meetings last up to 2 hours.",
  steps: ["Enter your email", "Confirm the code", "Set up your profile"], step,
});

/**
 * Step 1: email. "?email=" comes from a team invite link: the email is filled in and the page says it's an invitation.
 * If this browser is already signed in as someone else, it asks before switching accounts.
 */
export function SignUp() {
  const { me, signOut } = useAuth();
  const nav = useNavigate();
  const invite = new URLSearchParams(window.location.search).get("email")?.trim().toLowerCase() || null;
  const [email, setEmail] = useState(invite ?? load()?.email ?? "");
  const [agree, setAgree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Already signed in as this person (or not following an invite): straight to the dashboard.
  if (me && (!invite || me.user.email.toLowerCase() === invite)) return <Navigate to="/home" replace />;
  if (me && invite) {
    return (
      <AuthShell side={side(1, true)}>
        <Heading title="Accept your invitation">This invitation is for <b>{invite}</b>, but this browser is signed in as <b>{me.user.email}</b>.</Heading>
        <div className="space-y-3">
          <Button className="w-full !rounded-xl !py-3.5" onClick={() => signOut()}>Log out and accept the invitation</Button>
          <Button className="w-full !rounded-xl !py-3.5" variant="secondary" onClick={() => nav("/home")}>Stay signed in as {me.user.name.split(" ")[0]}</Button>
          <p className="text-center text-xs text-stone-500">Log out first so the invitation goes to the right account.</p>
        </div>
      </AuthShell>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const pending = load();
      // Going back to the same email inside the resend wait reuses the code already sent.
      if (!(pending && pending.email === email.trim().toLowerCase() && pending.resendAt > Date.now())) await sendCode(email.trim().toLowerCase());
      nav("/signup/verify");
    } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <AuthShell side={side(1, Boolean(invite))}>
      <Heading title={invite ? "Accept your invitation" : "Create your account"}>
        {invite ? "Confirm it's you: we'll email you a 6-digit code, then you choose your password." : "Enter your email and we'll send you a 6-digit code to confirm it's yours."}
      </Heading>
      <form onSubmit={submit} className="space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-stone-700">Email</span>
          <input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={field} />
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-xs text-stone-500">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-700" />
          <span>I agree that Gather may email me codes, invitations and meeting summaries.</span>
        </label>
        <ErrorNote error={error} />
        <Button className="w-full !rounded-xl !py-3.5" loading={busy} disabled={!agree}>Send code</Button>
        <p className="text-center text-sm text-stone-500">Already have an account? <Link to="/signin" className="font-semibold text-brand-700 hover:underline">Sign in</Link></p>
      </form>
    </AuthShell>
  );
}

/** Step 2: the code from the email in six boxes, with a countdown and a resend button. Submits on the 6th digit. */
export function SignUpVerify() {
  const nav = useNavigate();
  const now = useNow();
  const [pending, setPending] = useState(load);
  const [code, setCode] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const expired = pending ? now >= pending.expiresAt : false;

  const verify = async (c = code) => {
    if (!pending || c.length !== 6 || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<{ signupToken: string; invitedTo: string | null }>("/auth/signup/verify", { body: { email: pending.email, code: c }, token: null });
      save({ ...pending, signupToken: r.signupToken, invitedTo: r.invitedTo });
      setOk(true);
      setTimeout(() => nav("/signup/details"), 700);
    } catch (err) { setError((err as ApiError).message); setCode(""); } finally { setBusy(false); }
  };
  useEffect(() => { if (code.length === 6) verify(code); }, [code]);
  if (!pending) return <Navigate to="/signup" replace />;
  const resend = async () => {
    setResending(true); setError(null); setNotice(null);
    try { setPending(await sendCode(pending.email)); setCode(""); setNotice("New code sent. The old one no longer works."); }
    catch (err) { setError((err as ApiError).message); } finally { setResending(false); }
  };

  return (
    <AuthShell side={side(2, Boolean(pending.invitedTo))}>
      <Heading title={ok ? "Thanks!" : "Enter your code"}>
        {ok ? "Your email is confirmed. Taking you to the next step…" : <>We sent a 6-digit code to <b className="text-stone-700">{pending.email}</b>. <Link to="/signup" className="whitespace-nowrap font-semibold text-brand-700">Change email</Link></>}
      </Heading>
      <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="space-y-5">
        <OtpInput value={code} onChange={setCode} disabled={expired || busy} ok={ok} autoFocus />
        <CodeTimers now={now} expiresAt={pending.expiresAt} resendAt={pending.resendAt} resending={resending} onResend={resend} />
        <ErrorNote error={error} />
        {notice && <p className="rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-800">{notice}</p>}
        <Button className="w-full !rounded-xl !py-3.5" loading={busy} disabled={expired || code.length !== 6 || ok}>Confirm code</Button>
        <Link to="/signup" className="block w-full rounded-xl border border-stone-200 py-3 text-center text-sm font-semibold text-stone-700 hover:bg-stone-50">Back</Link>
        <p className="text-center text-xs text-stone-500">Can't find it? Check your spam or promotions folder.</p>
      </form>
    </AuthShell>
  );
}

/** Step 3: profile and password. Saving creates the account, then we send them to sign in. */
export function SignUpDetails() {
  const nav = useNavigate();
  const pending = load();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accountType, setAccountType] = useState<"individual" | "company">("individual");
  const [orgName, setOrgName] = useState("");
  const [language, setLanguage] = useState("en");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!pending?.signupToken) return <Navigate to={pending ? "/signup/verify" : "/signup"} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneValid(phone)) { setError("Enter a real phone number with its country code."); return; }
    if (!passwordOk(password, { email: pending.email, name })) { setError("Your password doesn't meet all the rules yet."); return; }
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true); setError(null);
    try {
      await api("/auth/signup/complete", { body: { signupToken: pending.signupToken, name, phone, password, accountType, orgName, language }, token: null });
      save(null);
      nav(`/signin?created=1&email=${encodeURIComponent(pending.email)}${pending.invitedTo ? `&joined=${encodeURIComponent(pending.invitedTo)}` : ""}`, { replace: true });
    } catch (err) {
      const e = err as ApiError;
      // Token too old: start again from the email step.
      if (e.status === 401) { save(null); nav("/signup", { replace: true }); return; }
      setError(e.message);
    } finally { setBusy(false); }
  };
  const label = (t: string, el: React.ReactNode, hint?: string) => (
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-stone-700">{t}</span>{el}{hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}</label>
  );

  return (
    <AuthShell side={side(3, Boolean(pending.invitedTo))}>
      <Heading title="Set up your profile">Email confirmed: <b className="text-stone-700">{pending.email}</b></Heading>
      <form onSubmit={submit} className="space-y-4">
        {pending.invitedTo && <p className="rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-900">You're joining the <b>{pending.invitedTo}</b> workspace.</p>}
        {label("Full name", <input required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Okafor" className={field} />)}
        {label("Phone number", <PhoneInput required value={phone} onChange={setPhone} />, "Pick your country, then type your number. One number per account.")}
        {/* Invited people already belong to a workspace, so they don't pick an account type */}
        {!pending.invitedTo && <div className="grid grid-cols-2 gap-2">
          {(["individual", "company"] as const).map((t) => (
            <button type="button" key={t} onClick={() => setAccountType(t)}
              className={`rounded-xl border px-3 py-3 text-left text-sm transition ${accountType === t ? "border-brand-600 bg-brand-50 ring-4 ring-brand-500/10" : "border-stone-200 bg-stone-50"}`}>
              <b className="block">{t === "individual" ? "Just me" : "A company"}</b>
              <span className="text-xs text-stone-500">{t === "individual" ? "Tutor, freelancer, church..." : "Team, shared history, admin"}</span>
            </button>
          ))}
        </div>}
        {!pending.invitedTo && accountType === "company" && label("Company name", <input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Ltd" className={field} />)}
        {label("Language", <select value={language} onChange={(e) => setLanguage(e.target.value)} className={field}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>)}
        {label("Password", <PasswordInput required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />)}
        <PasswordRules password={password} email={pending.email} name={name} />
        {label("Confirm password", <PasswordInput required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />)}
        {confirm && <p className={`-mt-2 text-xs ${confirm === password ? "text-brand-700" : "text-red-600"}`}>{confirm === password ? "✓ Passwords match" : "Passwords don't match yet"}</p>}
        <ErrorNote error={error} />
        <Button className="w-full !rounded-xl !py-3.5" loading={busy}>Create account</Button>
      </form>
    </AuthShell>
  );
}
