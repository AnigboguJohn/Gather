/**
 * Log out with a confirmation: a bottom sheet on phones (a centred card on laptops) with a red "Log out" and a
 * separate "Cancel", like the iOS action sheet. Used in the sidebar and at the bottom of Settings.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Icon } from "./Icon";

/** The trigger (styled by the caller) plus the confirmation sheet it opens. */
export function SignOutButton({ className, children }: { className: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>{children}</button>
      {/* Rendered on <body>: the sidebar is position:fixed, which would trap the sheet under the page content */}
      {open && createPortal(<SignOutSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** "Are you sure you want to log out?" sheet. Logging out only removes the sign-in from this browser. */
function SignOutSheet({ onClose }: { onClose: () => void }) {
  const { signOut } = useAuth();
  const nav = useNavigate();
  // Escape closes it, like the other dialogs.
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:items-center" onClick={onClose}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="signout-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-2">
        <div className="relative overflow-hidden rounded-3xl bg-white text-center shadow-xl">
          <button onClick={onClose} aria-label="Close" className="absolute right-2.5 top-2.5 rounded-full p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"><Icon name="x" size={16} /></button>
          <h2 id="signout-title" className="px-10 py-5 text-base font-semibold text-stone-900">Are you sure you want to log out?</h2>
          <button autoFocus onClick={() => { signOut(); nav("/"); }} className="w-full border-t border-stone-100 py-4 text-[17px] font-semibold text-red-600 hover:bg-red-50">Log out</button>
        </div>
        <button onClick={onClose} className="w-full rounded-3xl bg-white py-4 text-[17px] font-semibold text-sky-600 shadow-xl hover:bg-stone-50">Cancel</button>
      </div>
    </div>
  );
}
