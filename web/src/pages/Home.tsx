/**
 * Dashboard ("/home") for signed-in hosts, on the same light layout as the other pages.
 *  - top: greeting and plan line, with "Search by keywords" (asks your meetings)
 *  - left: four big tiles (New meeting, Join meeting, Schedule, Share screen)
 *  - right: a clock card (local time and date), then the upcoming meetings as cards with faces, "id" and Start
 * The list refreshes every 20 s so "Live" badges stay current.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Initials, PageTitle } from "../components/Layout";
import { ShareSheet, type MeetingDto } from "../components/ShareSheet";
import { Button, copy, Input, Modal, Spinner, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { newKey, saveKey } from "../lib/e2ee";
import { fmtTime, hoursLabel } from "../lib/format";
import { joinPath } from "./Landing";

/** Phone browsers can't share a screen (no getDisplayMedia). */
const canShareScreen = () => Boolean(navigator.mediaDevices?.getDisplayMedia) && !window.matchMedia?.("(pointer: coarse)").matches;

export default function Home() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [list, setList] = useState<MeetingDto[] | null>(null);
  const [instant, setInstant] = useState<MeetingDto | null>(null);
  const [busy, setBusy] = useState<"meet" | "share" | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [q, setQ] = useState("");

  const load = () => api<MeetingDto[]>("/meetings?scope=upcoming").then(setList).catch(() => setList([]));
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);

  /** New meeting: create an instant room, then show the share sheet so the host can send the link at once. */
  const meetNow = async () => {
    setBusy("meet");
    try { setInstant(await api<MeetingDto>("/meetings/instant", { body: {} })); load(); }
    catch (e) { toast((e as ApiError).message, "error"); } finally { setBusy(null); }
  };
  /** Share screen: open an instant room and go straight in, ready to present (the call screen offers "Start sharing"). */
  const shareScreen = async () => {
    if (!canShareScreen()) { toast("Screen sharing works from a laptop or desktop browser.", "info"); return; }
    setBusy("share");
    try { const m = await api<MeetingDto>("/meetings/instant", { body: { title: `${me?.user.name.split(" ")[0]}'s presentation` } }); nav(`/j/${m.slug}?present=1`); }
    catch (e) { toast((e as ApiError).message, "error"); setBusy(null); }
  };

  return (
    <div>
      <PageTitle title={`Hello, ${me?.user.name.split(" ")[0]}`}
        sub={`${me?.plan.name} plan · meetings up to ${hoursLabel(me?.plan.meetingLimitMinutes ?? 120)}`}
        action={
          <form data-tour="search" onSubmit={(e) => { e.preventDefault(); nav(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : "/search"); }}
            className="flex w-full items-center gap-2 rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm shadow-sm focus-within:border-ocean-500 sm:w-72">
            <Icon name="search" size={16} className="shrink-0 text-stone-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by keywords" aria-label="Search your meetings" className="w-full bg-transparent outline-none placeholder:text-stone-400" />
          </form>
        } />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-8">
        {/* Left: the four actions */}
        <section>
          <div className="grid max-w-sm grid-cols-2 gap-4 sm:gap-5">
            <Tile tour="new-meeting" tone="flame" icon="cam" title="New meeting" sub="set up new meeting" busy={busy === "meet"} onClick={meetNow} />
            <Tile tour="join" icon="plus" title="Join meeting" sub="via invitation link" onClick={() => setJoinOpen(true)} />
            <Tile tour="schedule" icon="calendar" title="Schedule" sub="plan your meetings" onClick={() => nav("/schedule")} />
            <Tile tour="share-screen" icon="screen" title="Share screen" sub="show your work" busy={busy === "share"} onClick={shareScreen} />
          </div>
          {me?.plan.name === "Free" && (
            <p className="mt-5 max-w-sm text-xs text-stone-500">Need longer calls or recordings? <Link to="/billing" className="font-semibold text-ocean-600 hover:underline">Upgrade</Link></p>
          )}
        </section>

        {/* Right: clock, then upcoming meetings */}
        <section data-tour="meetings" className="space-y-4">
          <ClockCard />
          {!list ? <div className="py-10 text-center text-stone-500"><Spinner /></div>
            : !list.length ? (
              <div className="rounded-2xl border border-dashed border-stone-300 px-6 py-10 text-center">
                <p className="font-semibold text-stone-800">No upcoming meetings</p>
                <p className="mt-1 text-sm text-stone-500">Start a new meeting for an urgent call, or schedule one for another day.</p>
              </div>
            )
            : list.map((m) => <MeetingCard key={m.id} m={m} />)}
        </section>
      </div>

      <Modal open={Boolean(instant)} onClose={() => setInstant(null)} title="Your meeting is ready">
        {instant && <InstantReady m={instant} onSecure={(m) => setInstant(m)} />}
      </Modal>
      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Join a meeting">
        <JoinForm />
      </Modal>
    </div>
  );
}

/** One big square action tile (orange for New meeting, blue for the rest), like the design's 2×2 grid. */
function Tile({ tour, tone = "ocean", icon, title, sub, onClick, busy }: { tour?: string; tone?: "flame" | "ocean"; icon: string; title: string; sub: string; onClick: () => void; busy?: boolean }) {
  const bg = tone === "flame" ? "bg-flame-500 hover:bg-flame-600 shadow-flame-500/20" : "bg-ocean-500 hover:bg-ocean-600 shadow-ocean-500/20";
  return (
    <button data-tour={tour} onClick={onClick} disabled={busy} className={`flex aspect-square flex-col justify-between rounded-2xl p-4 text-left text-white shadow-lg transition sm:p-5 ${bg}`}>
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 ring-1 ring-white/25">{busy ? <Spinner size={20} /> : <Icon name={icon} size={20} />}</span>
      <span><b className="block text-sm font-semibold">{title}</b><span className="text-[11px] text-white/75">{sub}</span></span>
    </button>
  );
}

/** Slate card with the local time (updates every few seconds), today's date and a potted plant. */
function ClockCard() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 5000); return () => clearInterval(t); }, []);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  return (
    <div className="relative h-32 overflow-hidden rounded-2xl bg-[#4a5f6b] text-white shadow-sm sm:h-36">
      {/* Lighter diagonal band, as in the design */}
      <div className="absolute inset-y-0 right-0 w-3/5 bg-[#56707c]" style={{ clipPath: "polygon(22% 0, 100% 0, 100% 100%, 48% 100%)" }} />
      <div className="relative flex h-full flex-col justify-center px-6">
        <p className="text-4xl font-light tracking-tight sm:text-5xl">{time}</p>
        <p className="mt-1 text-xs text-white/80">{date}</p>
      </div>
      <Plant className="absolute -bottom-1 right-3 h-[92%] sm:right-6" />
    </div>
  );
}

/** A green plant in a white pot (inline SVG, so there's no image to download). */
function Plant({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 140" className={className} aria-hidden="true">
      <path d="M58 92C40 70 28 46 30 18c14 14 26 38 28 74z" fill="#1fb57d" />
      <path d="M62 92C70 60 84 36 104 22c0 28-16 54-42 70z" fill="#27c98c" />
      <path d="M60 94C50 72 52 46 66 26c8 22 6 46-6 68z" fill="#3ddc9e" />
      <path d="M58 96C42 84 22 80 6 84c12 12 30 16 52 12z" fill="#159a68" />
      <path d="M62 96c16-10 36-14 52-8-12 12-30 14-52 8z" fill="#1fb57d" />
      <path d="M86 4c10 0 16 4 18 10v44c-10-8-18-24-18-54z" fill="#2fd291" opacity=".9" />
      <rect x="30" y="94" width="62" height="46" rx="4" fill="#e9edf0" />
      <rect x="30" y="94" width="62" height="8" fill="#d3d9de" />
    </svg>
  );
}

/** "starts in 18 hours" / "starts in 12 min" / "started 5 min ago" / "starts in 3 days". */
function startsIn(iso: string) {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins < 0) return `started ${-mins < 60 ? `${-mins} min` : `${Math.round(-mins / 60)} h`} ago`;
  if (mins < 1) return "starts now";
  if (mins < 60) return `starts in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `starts in ${hrs} hour${hrs === 1 ? "" : "s"}`;
  return `starts in ${Math.round(hrs / 24)} days`;
}

/**
 * One upcoming meeting: title and ⋯ menu, time range and "starts in…", invitee faces (+N),
 * an "id" button that copies the meeting code, and Start (Join while it's live).
 */
function MeetingCard({ m }: { m: MeetingDto }) {
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [menu]);
  // Weekly meetings show their next occurrence, not the first one.
  const when = m.nextAt ?? m.startAt;
  const end = new Date(new Date(when).getTime() + m.durationMin * 60_000);
  // Faces: the first invitees, or the host when nobody is invited; "+N" for the rest.
  const faces = m.people?.length ? m.people : [m.host.name];
  const more = Math.max(0, (m.invited ?? 0) - faces.length);
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/meetings/${m.id}`} className="truncate font-semibold text-stone-900 hover:text-ocean-600">{m.title}</Link>
            {m.live && <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">● Live · {m.live.people}</span>}
            {m.repeat === "weekly" && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-600">Weekly</span>}
            {m.e2ee && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800">Encrypted</span>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
            <Icon name="clock" size={12} />
            {m.kind === "instant" ? <span>Open now</span> : <><span>{fmtTime(when)} - {fmtTime(end)}</span><span className="text-stone-300">|</span><span>{startsIn(when)}</span></>}
            {m.invited ? <><span className="text-stone-300">|</span><span>{m.confirmed}/{m.invited} confirmed</span></> : null}
          </p>
        </div>
        <div ref={menuRef} className="relative">
          <button onClick={() => setMenu(!menu)} className="flex h-7 w-9 items-center justify-center rounded-lg bg-stone-100 text-stone-500 hover:text-stone-900" aria-label={`More for ${m.title}`}><Icon name="more" size={16} /></button>
          {menu && (
            <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-xl bg-white py-1 text-sm shadow-xl ring-1 ring-stone-200">
              <MenuLink icon="whatsapp" onClick={() => { setMenu(false); setShare(true); }}>Share invite</MenuLink>
              <MenuLink icon="copy" onClick={() => { setMenu(false); copy(m.url); }}>Copy link</MenuLink>
              <MenuLink icon="arrow" onClick={() => nav(`/meetings/${m.id}`)}>Meeting details</MenuLink>
              {m.kind === "scheduled" && <MenuLink icon="edit" onClick={() => nav(`/meetings/${m.id}/edit`)}>Edit</MenuLink>}
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {faces.map((n, i) => <span key={i} title={n}><Initials name={n} size={34} /></span>)}
          {more > 0 && <span className="flex h-[34px] min-w-[34px] items-center justify-center rounded-xl bg-ocean-500 px-1.5 text-[11px] font-bold">+{more}</span>}
        </div>
        <button onClick={() => copy(m.slug, "Meeting ID copied")} title={`Meeting ID: ${m.slug}`} aria-label={`Copy meeting ID ${m.slug}`}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-[11px] font-semibold text-stone-500 hover:text-stone-900">id</button>
        <Link to={`/j/${m.slug}`} className="flex h-9 shrink-0 items-center rounded-lg bg-ocean-500 px-7 text-xs font-semibold text-white hover:bg-ocean-600">{m.live ? "Join" : "Start"}</Link>
      </div>
      <Modal open={share} onClose={() => setShare(false)} title={`Share "${m.title}"`}><ShareSheet m={m} /></Modal>
    </div>
  );
}

/** One row in a meeting card's ⋯ menu. */
function MenuLink({ icon, onClick, children }: { icon: string; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-stone-700 hover:bg-stone-100"><Icon name={icon} size={15} />{children}</button>;
}

/**
 * Join meeting: paste an invitation link (any /j/… link, with its #k= key for encrypted meetings) or a meeting ID.
 */
function JoinForm() {
  const nav = useNavigate();
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    const path = joinPath(v);
    if (!path) { setErr("Paste the invitation link, or a meeting ID like xsk-yweq-evb."); return; }
    nav(path);
  };

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <p className="text-sm text-stone-600">Paste the link from your invitation (WhatsApp, email or SMS), or type the meeting ID.</p>
      <Input autoFocus value={v} onChange={(e) => { setV(e.target.value); setErr(null); }} placeholder="https://…/j/xsk-yweq-evb or xsk-yweq-evb" />
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button className="w-full rounded-xl bg-ocean-500 py-2.5 text-sm font-semibold text-white hover:bg-ocean-600">Join</button>
    </form>
  );
}

/** Contents of the "Your meeting is ready" dialog after New meeting: share buttons, Join now, and an encryption option. */
function InstantReady({ m, onSecure }: { m: MeetingDto; onSecure: (m: MeetingDto) => void }) {
  const nav = useNavigate();
  return (
    <div className="space-y-5">
      <p className="text-sm text-stone-600">Share the link. Guests join from any phone browser, no account needed.</p>
      <ShareSheet m={m} onChange={onSecure} />
      <Button className="w-full !bg-ocean-500 hover:!bg-ocean-600" icon="arrow" onClick={() => nav(`/j/${m.slug}`)}>Join now</Button>
      {!m.e2ee && (
        <button className="w-full text-xs text-stone-500 hover:text-stone-800" onClick={async () => {
          // Turning on E2EE for a fresh instant room: make a key in this browser only.
          const key = newKey(); saveKey(m.slug, key);
          const u = await api<MeetingDto>(`/meetings/${m.id}`, { method: "PATCH", body: { e2ee: true } });
          onSecure(u);
        }}>Make it end-to-end encrypted (turns off captions and summaries)</button>
      )}
    </div>
  );
}
