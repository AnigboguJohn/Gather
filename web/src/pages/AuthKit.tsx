/**
 * Shared pieces of the sign-up, sign-in and forgot-password pages:
 *  - AuthShell: split layout. A green brand panel on the left (photo, headline, steps) and the form on the right;
 *    on phones only the form, with the logo on top.
 *  - OtpInput: six boxes for a 6-digit code (typing, paste, backspace; turns green once the code is accepted).
 *  - PasswordInput: password field with a show/hide eye.
 *  - useNow / mmss: the countdowns for code expiry and resend.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Layout";
import { Icon } from "../components/Icon";
import { P, photo } from "./Landing";

/** Current time, updated every second (drives the countdowns). */
export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return now;
}
export const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Red note under a form. */
export const ErrorNote = ({ error }: { error: string | null }) =>
  error ? <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null;

/** What the brand panel shows: a chip, a headline, a line of text, and optional numbered steps. */
export interface Side { chip: string; title: string; text: string; steps?: string[]; step?: number }

/**
 * Split layout used by every auth page. `side` fills the brand panel (hidden on phones); `step` highlights
 * one of its steps and also shows a small progress bar above the form on phones.
 */
export function AuthShell({ side, children }: { side: Side; children: ReactNode }) {
  return (
    <div className="min-h-full bg-stone-100 p-3 sm:p-5 lg:flex lg:items-center lg:justify-center">
      <div className="mx-auto grid w-full max-w-6xl overflow-hidden rounded-[2rem] bg-white shadow-sm md:min-h-[40rem] md:grid-cols-[1fr_1fr] lg:min-h-[44rem] lg:grid-cols-[1.05fr_1fr]">
        {/* Phones: a short photo banner with the headline */}
        <div className="relative overflow-hidden bg-brand-900 px-6 pb-6 pt-5 text-white md:hidden">
          <img src={photo(P.amara, 700, 420)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" />
          <div className="absolute inset-0 bg-gradient-to-br from-brand-900/90 to-brand-600/70" />
          <Link to="/" className="relative block w-fit"><Logo light /></Link>
          <span className="relative mt-6 inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-medium">{side.chip}</span>
          <p className="relative mt-2 text-xl font-semibold leading-snug">{side.title}</p>
        </div>
        {/* Brand panel (tablets and laptops) */}
        <aside className="relative hidden overflow-hidden bg-brand-900 p-8 text-white md:flex md:flex-col lg:p-10">
          <img src={photo(P.amara, 900, 1100)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />
          <div className="absolute inset-0 bg-gradient-to-br from-brand-900/90 via-brand-800/80 to-brand-600/70" />
          <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-brand-400/30 blur-3xl" />
          <Link to="/" className="relative w-fit"><Logo light /></Link>
          {/* A small live-caption card, as a hint of what Gather does */}
          <div className="relative mt-14 w-fit max-w-xs rounded-2xl bg-white/95 p-3 text-stone-800 shadow-xl" aria-hidden="true">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-700"><span className="h-1.5 w-1.5 rounded-full bg-red-500" />LIVE · Yoruba → English</p>
            <p className="mt-1 text-sm">“We start the training on Monday.”</p>
          </div>
          <div className="relative mt-auto">
            <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-sm font-medium backdrop-blur">{side.chip}</span>
            <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-tight lg:text-4xl">{side.title}</h2>
            <p className="mt-3 max-w-md text-white/80">{side.text}</p>
            {side.steps && (
              <ol className="mt-8 grid grid-cols-3 gap-2 lg:gap-3">
                {side.steps.map((s, i) => {
                  const n = i + 1; const on = n === side.step; const done = side.step !== undefined && n < side.step;
                  return (
                    <li key={s} aria-current={on ? "step" : undefined} className={`flex min-h-[7.5rem] flex-col justify-between rounded-2xl p-3 transition lg:p-4 ${on ? "bg-white text-stone-900" : "bg-white/10 text-white/80 backdrop-blur"}`}>
                      <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${on ? "bg-brand-700 text-white" : done ? "bg-white text-brand-800" : "ring-1 ring-white/50"}`}>{done ? <Icon name="check" size={14} strokeWidth={3} /> : n}</span>
                      <span className="text-sm font-medium leading-snug">{s}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </aside>

        {/* Form */}
        <main className="flex flex-col px-6 py-8 sm:px-12 md:px-10 lg:px-16">
          {side.steps && side.step && (
            <div className="mb-6 flex gap-1.5 md:hidden" aria-label={`Step ${side.step} of ${side.steps.length}`}>
              {side.steps.map((_, i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${i < side.step! ? "bg-brand-600" : "bg-stone-200"}`} />)}
            </div>
          )}
          <div className="mx-auto my-auto w-full max-w-sm">{children}</div>
          <p className="mt-8 flex justify-between text-xs text-stone-400"><Link to="/" className="hover:text-stone-600">← Back to Gather</Link><span>© {new Date().getFullYear()} Gather</span></p>
        </main>
      </div>
    </div>
  );
}

/** Page title and one line under it, centred like the designs. */
export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-7 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-stone-900">{title}</h1>
      {children && <p className="mt-2 text-sm text-stone-500">{children}</p>}
    </div>
  );
}

// The look of every field on these pages: light grey, rounded, green focus ring.
export const field = "w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-[15px] outline-none transition placeholder:text-stone-400 focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/10";

/** Password field with a show/hide eye. */
export function PasswordInput(p: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...p} type={show ? "text" : "password"} className={`${field} pr-12`} />
      <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-stone-400 hover:text-stone-700">
        <Icon name={show ? "eyeOff" : "eye"} size={18} />
      </button>
    </div>
  );
}

/**
 * Six boxes for a 6-digit code. Typing moves to the next box, Backspace goes back, and pasting (or the phone's
 * one-time-code suggestion) fills them all. `ok` turns them green with a tick (code accepted).
 */
export function OtpInput({ value, onChange, disabled, ok, autoFocus }: { value: string; onChange: (v: string) => void; disabled?: boolean; ok?: boolean; autoFocus?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number) => refs.current[Math.max(0, Math.min(5, i))]?.focus();
  const set = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return;
    const next = (value.slice(0, i) + digits).slice(0, 6);
    onChange(next);
    focus(next.length);
  };
  return (
    <div className="flex items-center justify-between gap-2" role="group" aria-label="6-digit code">
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} value={value[i] ?? ""} disabled={disabled || ok} autoFocus={autoFocus && i === 0}
          inputMode="numeric" autoComplete={i === 0 ? "one-time-code" : "off"} aria-label={`Digit ${i + 1} of 6`} placeholder={i === 0 ? "123456" : undefined}
          onChange={(e) => set(i, e.target.value)}
          onPaste={(e) => { e.preventDefault(); set(0, e.clipboardData.getData("text")); }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") { e.preventDefault(); onChange(value.slice(0, value[i] ? i : i - 1)); focus(value[i] ? i : i - 1); }
            if (e.key === "ArrowLeft") focus(i - 1);
            if (e.key === "ArrowRight") focus(i + 1);
          }}
          onFocus={(e) => e.target.select()}
          className={`h-14 w-full min-w-0 rounded-xl border text-center text-2xl font-semibold outline-none transition placeholder:text-transparent sm:h-16
            ${ok ? "border-brand-300 bg-brand-50 text-brand-800" : value[i] ? "border-stone-300 bg-white" : "border-stone-200 bg-stone-50"} focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/10`} />
      ))}
      {ok && <span className="sr-only">Code accepted</span>}
    </div>
  );
}

/** The password rules, as a live checklist (the server checks the same rules, plus known data breaches). */
export function passwordRules(pw: string, ctx: { email?: string; name?: string } = {}) {
  const lower = pw.toLowerCase();
  const local = ctx.email?.split("@")[0]?.toLowerCase() ?? "";
  const nameParts = (ctx.name ?? "").toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
  return [
    { ok: pw.length >= 12, text: "At least 12 characters" },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), text: "Capital and lowercase letters" },
    { ok: /\d/.test(pw), text: "A number" },
    { ok: /[^A-Za-z0-9]/.test(pw), text: "A symbol, like ! ? # or @" },
    { ok: pw.length > 0 && !/(.)\1\1/.test(pw) && !/(password|qwerty|123456|abcdef|gather|letmein|welcome|iloveyou|admin)/.test(lower)
        && !(local.length >= 3 && lower.includes(local)) && !nameParts.some((p) => lower.includes(p)), text: "No common words, your name or email" },
  ];
}
export function PasswordRules({ password, email, name }: { password: string; email?: string; name?: string }) {
  const rules = passwordRules(password, { email, name });
  const score = rules.filter((r) => r.ok).length;
  const tone = score <= 2 ? "bg-red-500" : score <= 4 ? "bg-amber-500" : "bg-brand-600";
  return (
    <div className="-mt-1 space-y-2" aria-live="polite">
      <div className="flex gap-1">{rules.map((_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${i < score ? tone : "bg-stone-200"}`} />)}</div>
      <ul className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
        {rules.map((r) => <li key={r.text} className={r.ok ? "text-brand-700" : "text-stone-500"}>{r.ok ? "✓" : "•"} {r.text}</li>)}
      </ul>
    </div>
  );
}
export const passwordOk = (pw: string, ctx: { email?: string; name?: string } = {}) => passwordRules(pw, ctx).every((r) => r.ok);

/** "Remember me for 30 days" checkbox. */
export function RememberMe({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-600">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded accent-emerald-700" />
      Remember me for 30 days
    </label>
  );
}

/** Code expiry line and the "Send a new code" button with its wait time. */
export function CodeTimers({ now, expiresAt, resendAt, resending, onResend }: { now: number; expiresAt: number; resendAt: number; resending: boolean; onResend: () => void }) {
  const expired = now >= expiresAt;
  const canResend = now >= resendAt;
  return (
    <div className="flex items-center justify-between text-sm" aria-live="polite">
      <span className={expired ? "font-medium text-red-600" : expiresAt - now < 60_000 ? "text-clay-600" : "text-stone-500"}>
        {expired ? "Code expired" : <>Expires in <b className="tabular-nums">{mmss(expiresAt - now)}</b></>}
      </span>
      <button type="button" onClick={onResend} disabled={!canResend || resending} className="font-semibold text-brand-700 hover:underline disabled:cursor-not-allowed disabled:font-medium disabled:text-stone-400 disabled:no-underline">
        {resending ? "Sending…" : canResend ? "Resend code" : <>Resend in <span className="tabular-nums">{mmss(resendAt - now)}</span></>}
      </button>
    </div>
  );
}
