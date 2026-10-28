/** Shared UI building blocks for Gather pages: buttons, form fields, toggles, cards, badges, modals and toasts. */
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { Icon } from "./Icon";

// Button styles: primary (green), accent (orange), secondary (outlined), ghost (text), danger (red).
type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-700/50",
  accent: "bg-clay-500 text-white hover:bg-clay-600 disabled:opacity-50",
  secondary: "bg-white text-stone-800 border border-stone-300 hover:bg-stone-100 disabled:opacity-50",
  ghost: "text-stone-700 hover:bg-stone-200/70 disabled:opacity-50",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:opacity-50",
};

/** Standard button. `icon` shows an icon before the label; `loading` shows a spinner and disables it. */
export function Button({ variant = "primary", icon, loading, className = "", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: string; loading?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${VARIANTS[variant]} ${className}`}>
      {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
}

/** A labelled form field: label on top, then the input, then an error (red) or a hint (grey). */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-stone-700">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-sm text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-stone-500">{hint}</span> : null}
    </label>
  );
}

// Shared look for text inputs, selects and textareas.
const inputCls = "w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-[15px] outline-none transition placeholder:text-stone-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";
/** Text input with Gather styling (extra classes can be passed in). */
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${inputCls} ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${inputCls} ${p.className ?? ""}`} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${inputCls} ${p.className ?? ""}`} />;

/** On/off switch with a label and hint, used for meeting settings (waiting room, open mic...). */
export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-4 rounded-xl py-2 text-left disabled:opacity-50">
      <span>
        <span className="block text-sm font-medium text-stone-800">{label}</span>
        {hint && <span className="block text-xs text-stone-500">{hint}</span>}
      </span>
      <span className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-brand-600" : "bg-stone-300"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${checked ? "left-[22px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/** White rounded panel used to group content on pages. */
export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) =>
  <div className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>;

/** Small coloured pill for statuses ("Live", "Attending", "sent"). */
export function Badge({ children, tone = "stone" }: { children: ReactNode; tone?: "stone" | "green" | "amber" | "red" | "blue" }) {
  const t = { stone: "bg-stone-100 text-stone-700", green: "bg-brand-100 text-brand-800", amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-700", blue: "bg-sky-100 text-sky-800" }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${t}`}>{children}</span>;
}

/** Loading spinner (inherits the text colour). */
export function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className}`}><circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" fill="none" /><path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" /></svg>;
}

/** Friendly empty state: icon, title and a short explanation. */
export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-stone-300 px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-brand-50 p-3 text-brand-700"><Icon name={icon} size={24} /></div>
      <p className="font-semibold text-stone-800">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-stone-500">{children}</div>}
    </div>
  );
}

/**
 * Dialog: a bottom sheet on phones, a centred box on larger screens.
 * Closes on Escape, the X button, or a click on the dark backdrop.
 */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="rounded-full p-1.5 hover:bg-stone-100" aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/*
 * Toasts: short pop-up messages. Call toast("Saved") from anywhere; <Toaster/> (mounted once in App) shows them.
 * confirmToast("Remove John?") asks a yes/no question in a toast (instead of the browser's confirm box).
 */
type Tone = "ok" | "error" | "info";
/** One toast. A question toast has a confirm label and a resolve callback, and stays until answered. */
type T = { id: number; text: string; tone: Tone; ask?: { confirm: string; danger?: boolean; resolve: (yes: boolean) => void } };
/** Show a toast. It travels as a window event so any code can call it without React context. */
export function toast(text: string, tone: Tone = "ok") { window.dispatchEvent(new CustomEvent("gather:toast", { detail: { text, tone } })); }
/**
 * Ask a yes/no question in a toast with "Cancel" and a confirm button (red when `danger`).
 * Resolves true on confirm; false on Cancel, ✕ or Escape.
 */
export function confirmToast(text: string, o: { confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent("gather:toast", { detail: { text, tone: "info", ask: { ...o, resolve } } })));
}
// A toast waiting to be shown after a page reload (kept in sessionStorage for this tab only).
const PENDING_TOAST = "gather.toast";
/** Reload the page, then show this toast (used after saving a form, so the page shows what was stored). */
export function reloadWithToast(text: string, tone: Tone = "ok") {
  try { sessionStorage.setItem(PENDING_TOAST, JSON.stringify({ text, tone })); } catch { /* storage blocked: reload without it */ }
  window.location.reload();
}
/**
 * Renders the latest toasts at the top of the screen. Messages disappear after 4.5 seconds (errors after 7);
 * questions stay until answered. Every toast has a ✕. `dark` = call-screen style.
 */
export function Toaster({ dark }: { dark?: boolean }) {
  const [items, setItems] = useState<T[]>([]);
  const close = (id: number, answer = false) => setItems((x) => {
    x.find((i) => i.id === id)?.ask?.resolve(answer);
    return x.filter((i) => i.id !== id);
  });
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const id = Date.now() + Math.random();
      setItems((x) => [...x.slice(-3), { id, ...d }]);
      if (!d.ask) setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), d.tone === "error" ? 7000 : 4500);
    };
    window.addEventListener("gather:toast", on);
    // A toast left by reloadWithToast() before the page reloaded.
    try {
      const pending = sessionStorage.getItem(PENDING_TOAST);
      if (pending) { sessionStorage.removeItem(PENDING_TOAST); const p = JSON.parse(pending); toast(p.text, p.tone); }
    } catch { /* ignore */ }
    return () => window.removeEventListener("gather:toast", on);
  }, []);
  // Escape answers "no" to the newest open question.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { const q = [...items].reverse().find((i) => i.ask); if (q) close(q.id); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [items]);
  const base = (t: T) => t.tone === "error" ? "bg-red-600 text-white" : dark ? "bg-white text-stone-900" : "bg-stone-900 text-white";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} role={t.ask ? "alertdialog" : "status"} aria-label={t.ask ? t.text : undefined}
          className={`pointer-events-auto w-full max-w-md rounded-xl text-sm font-medium shadow-lg ${base(t)} ${t.ask ? "p-4" : "flex items-start gap-3 py-2.5 pl-4 pr-2"}`}>
          {t.ask ? (
            <>
              <div className="flex items-start gap-3">
                <p className="flex-1">{t.text}</p>
                <button onClick={() => close(t.id)} aria-label="Close" className="-mr-1 -mt-1 rounded-full p-1 opacity-70 hover:opacity-100"><Icon name="x" size={16} /></button>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => close(t.id)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${dark ? "bg-stone-100 text-stone-800 hover:bg-stone-200" : "bg-white/15 hover:bg-white/25"}`}>Cancel</button>
                <button autoFocus onClick={() => close(t.id, true)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${t.ask.danger ? "bg-red-600 text-white hover:bg-red-700" : "bg-brand-600 text-white hover:bg-brand-700"}`}>{t.ask.confirm}</button>
              </div>
            </>
          ) : (
            <>
              <p className="flex-1 break-words">{t.text}</p>
              <button onClick={() => close(t.id)} aria-label="Close message" className="rounded-full p-0.5 opacity-60 hover:opacity-100"><Icon name="x" size={15} /></button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Copy text to the clipboard and confirm with a toast; where the clipboard is blocked, the toast shows the text to copy by hand. */
export async function copy(text: string, label = "Link copied") {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast(`Couldn't copy automatically. Select and copy: ${text}`, "info"); }
}
