/**
 * Welcome tour ("coach marks"): on a new person's first sign-in (new accounts and invited team members), and from
 * Settings → Take the tour. The screen dims, the real button is lit up, and a box beside it (with an arrow) says
 * what it does. Next moves to the next button, opening its page when needed (Home → History → Ask → Team → Plan →
 * Settings), until Finish. Skip, Back and ✕ are always there. Skipping, closing or finishing marks it as seen.
 * Targets are elements with data-tour="…" (Home tiles, search, meetings, and the menu links).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Icon } from "./Icon";

/** Open the tour from anywhere (e.g. Settings → Take the tour). */
export const openTour = () => window.dispatchEvent(new Event("gather:tour"));

/** One stop: which page, which element to light up (none = a centred box), and what to say. */
interface Step { route: string; target?: string; title: string; text: string }

function steps(first: string, org: string, admin: boolean, invited: boolean): Step[] {
  return [
    { route: "/home", title: `Welcome to Gather, ${first}!`,
      text: `${invited ? `You're now part of the ${org} team. ` : ""}Let's take a quick look around. We'll point at each button and say what it does. It takes about a minute.` },
    { route: "/home", target: "new-meeting", title: "New meeting",
      text: "Starts a call right now. You get a link to share on WhatsApp, email or SMS. Guests join from any phone browser, with no account." },
    { route: "/home", target: "join", title: "Join meeting",
      text: "Paste an invitation link, or type a meeting ID, to join someone else's call." },
    { route: "/home", target: "schedule", title: "Schedule",
      text: "Plan a meeting for later: pick a day and time, and invite people by WhatsApp number or email. They get RSVP buttons and reminders 24 hours and 15 minutes before." },
    { route: "/home", target: "share-screen", title: "Share screen",
      text: "Opens a room ready for you to present your screen, a window or a tab. Works from a laptop or desktop." },
    { route: "/home", target: "search", title: "Search by keywords",
      text: "Find anything said in your past meetings, like “What did we decide on pricing?”. You'll get an answer with sources." },
    { route: "/home", target: "meetings", title: "Your day and your meetings",
      text: "The clock shows your local time. Each card is an upcoming meeting: ⋯ shares or edits it, id copies the meeting ID, and Start opens the room." },
    { route: "/past", target: "nav-past", title: "History",
      text: "Every call that happened, by day: who came, how long it lasted, the summary and action items, the transcript and recordings." },
    { route: "/search", target: "nav-search", title: "Ask",
      text: "Chat with the Gather assistant. It answers from what was said in your meetings and shows where it found it." },
    { route: "/team", target: "nav-team", title: "Team",
      text: admin ? "Invite colleagues by email as members or admins, change their role, or remove them. Everyone shares one plan and one history."
        : `See who's in the ${org} workspace. Admins can invite people and change roles.` },
    { route: "/billing", target: "nav-billing", title: "Plan",
      text: admin ? "Free meetings last up to 2 hours. Upgrade for no time limit, more people and recordings. Pay in Naira by card, bank transfer or USSD."
        : "Your workspace's plan and how long meetings can last. Admins look after upgrades." },
    { route: "/settings", target: "nav-settings", title: "Settings",
      text: "Your name and WhatsApp number for reminders, a mic and speaker test, Google Calendar, and this tour if you want to see it again." },
    { route: "/home", title: "You're ready!",
      text: "In a call, the buttons along the bottom do the talking: Mic, Cam, Share screen, Raise hand, React, Captions, Volume (up to 300%) and Leave. Start your first meeting whenever you like." },
  ];
}

/** The first visible element for a tour target (the sidebar link on laptops, the bottom-bar link on phones). */
function findTarget(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

const PAD = 8; // space around the lit-up element
const GAP = 14; // space between the element and the box
const W = 340; // box width on larger screens

export function Onboarding() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  // The explanation box's real height, so it can always be placed fully on screen.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(0);

  // Show once for people who haven't seen it; Settings can open it again.
  useEffect(() => { if (me && !me.user.onboarded) { setI(0); setOpen(true); } }, [me?.user.id, me?.user.onboarded]);
  useEffect(() => {
    const replay = () => { setI(0); setOpen(true); };
    window.addEventListener("gather:tour", replay);
    return () => window.removeEventListener("gather:tour", replay);
  }, []);

  const list = me ? steps(me.user.name.split(" ")[0], me.org.name, me.user.role !== "member", me.user.role !== "owner") : [];
  const s = list[i];

  // Go to the step's page, wait for its button to appear, scroll it into view and light it up.
  useEffect(() => {
    if (!open || !s) return;
    setRect(null);
    if (loc.pathname !== s.route) { nav(s.route); return; }
    if (!s.target) return;
    let tries = 0, timer = 0;
    const look = () => {
      const el = findTarget(s.target!);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        timer = window.setTimeout(() => setRect(el.getBoundingClientRect()), 350);
      } else if (tries++ < 30) timer = window.setTimeout(look, 100); // the page is still loading
    };
    look();
    return () => clearTimeout(timer);
  }, [open, i, loc.pathname]);

  // Keep the light on the button when the window is resized or the page scrolls.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      setView({ w: window.innerWidth, h: window.innerHeight });
      const el = s?.target ? findTarget(s.target) : null;
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, i]);

  /** Skip, ✕, Escape or Finish: close and remember that it was seen. */
  const done = useCallback(async () => {
    setOpen(false);
    if (me && !me.user.onboarded) { await api("/me/onboarded", { method: "POST" }).catch(() => {}); refresh(); }
  }, [me, refresh]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") done();
      if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, list.length - 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, done, list.length]);

  useLayoutEffect(() => { const hh = boxRef.current?.offsetHeight ?? 0; if (hh && hh !== boxH) setBoxH(hh); });
  if (!open || !me || !s) return null;
  const last = i === list.length - 1;
  const waiting = Boolean(s.target) && !rect; // the button isn't on screen yet

  // Where the box goes. It's measured (boxH) and always kept fully on screen:
  //  1. beside the lit-up element (right, then left) when there's room, e.g. menu links or tall cards;
  //  2. otherwise below it, or above it; 3. if neither fits (a very tall element), over its top edge.
  const w = Math.min(W, view.w - 32);
  const h = boxH || 260;
  const clampX = (x: number) => Math.max(16, Math.min(x, view.w - w - 16));
  const clampY = (y: number) => Math.max(16, Math.min(y, view.h - h - 16));
  let box: React.CSSProperties = { width: w, left: (view.w - w) / 2, top: Math.max(16, (view.h - h) / 2) };
  let arrow: React.CSSProperties | null = null;
  if (rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const besideRight = view.w - rect.right - PAD - GAP >= w + 16;
    const besideLeft = rect.left - PAD - GAP >= w + 16;
    const below = view.h - rect.bottom - PAD - GAP >= h + 16;
    const above = rect.top - PAD - GAP >= h + 16;
    const arrowY = (top: number) => Math.max(14, Math.min(cy - top - 6, h - 26));
    const arrowX = (left: number) => Math.max(16, Math.min(cx - left - 6, w - 28));
    if (view.w >= 768 && (besideRight || besideLeft) && (rect.width < view.w / 3 || rect.height > view.h / 2)) {
      const top = clampY(cy - h / 2);
      if (besideRight) { box = { width: w, left: rect.right + PAD + GAP, top }; arrow = { left: -6, top: arrowY(top) }; }
      else { box = { width: w, left: rect.left - PAD - GAP - w, top }; arrow = { right: -6, top: arrowY(top) }; }
    } else if (below && (cy < view.h / 2 || !above)) {
      const left = clampX(cx - w / 2);
      box = { width: w, left, top: rect.bottom + PAD + GAP };
      arrow = { top: -6, left: arrowX(left) };
    } else if (above) {
      const left = clampX(cx - w / 2);
      box = { width: w, left, top: rect.top - PAD - GAP - h };
      arrow = { bottom: -6, left: arrowX(left) };
    } else {
      box = { width: w, left: clampX(cx - w / 2), top: clampY(rect.top + 16) };
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[55]" aria-live="polite">
      {/* Dim everything; the lit-up element shows through a hole made with a huge shadow. Clicks are blocked. */}
      {rect ? (
        <div className="pointer-events-none fixed rounded-2xl ring-2 ring-white/90 transition-all duration-300"
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: "0 0 0 9999px rgba(12, 20, 17, 0.62)" }} />
      ) : <div className="fixed inset-0 bg-[rgba(12,20,17,0.62)]" />}
      <div className="fixed inset-0" />

      {/* The explanation box */}
      {!waiting && (
        <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby="tour-title" className="fixed rounded-2xl bg-white p-5 shadow-2xl transition-all duration-300" style={box}>
          {arrow && <span className="absolute h-3 w-3 rotate-45 bg-white" style={arrow} aria-hidden="true" />}
          <button onClick={() => done()} aria-label="Close the tour" className="absolute right-2.5 top-2.5 rounded-full p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"><Icon name="x" size={16} /></button>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Step {i + 1} of {list.length}</p>
          <h2 id="tour-title" className="mt-1 pr-6 text-lg font-extrabold tracking-tight text-stone-900">{s.title}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{s.text}</p>
          {/* Progress */}
          <div className="mt-4 flex gap-1" aria-hidden="true">
            {list.map((_, n) => <span key={n} className={`h-1 flex-1 rounded-full ${n <= i ? "bg-brand-600" : "bg-stone-200"}`} />)}
          </div>
          <div className="mt-4 flex items-center gap-2">
            {!last && <button onClick={() => done()} className="mr-auto text-sm font-semibold text-stone-500 hover:text-stone-800">Skip</button>}
            {i > 0 && <button onClick={() => setI(i - 1)} className={`${last ? "mr-auto" : ""} rounded-xl border border-stone-300 px-3.5 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50`}>Back</button>}
            <button autoFocus onClick={() => (last ? done() : setI(i + 1))} className="flex items-center gap-1.5 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800">
              {last ? "Finish" : <>Next<Icon name="arrow" size={15} /></>}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
