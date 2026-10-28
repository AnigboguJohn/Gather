/**
 * Room.tsx: the meeting screen everyone sees once they are in a call (host or guest, laptop or phone).
 *
 * Layout (speaker view), top to bottom:
 *  - left (signed-in, wide screens): Schoola's app menu with this call highlighted (pages open in a new tab)
 *  - header: status chips (Live, breakout, encrypted, locked, REC, call timer, data meter), the meeting title,
 *    then "Hosted by", who's here (avatar stack) and Add people
 *  - stage (Schoola style): one person big (whoever spoke last, or the person you tapped), with live captions on top;
 *    the next 3 people (2 on phones) in a row of 16:9 tiles underneath at the same width, the last one with "+N".
 *    A shared screen takes the big view. "Gallery view" in More shows everyone in equal tiles (Zoom / Meet style).
 *  - overlays: presenter bar, host request cards ("wants to speak/present", waiting room)
 *  - right column: me and my role, the "Live chat" bar (tap to close), then the panel with tabs (chat, transcript,
 *    people, polls, breakouts, settings) and a "before close" card; a bottom sheet on phones
 *  - control bar with labelled buttons (Schoola's set): volume and record on the left; mic, camera, share screen and
 *    react in the middle; share link, chat, more (hand, captions, people, polls...) and leave on the right
 *
 * All call logic (LiveKit media + Socket.IO signal) lives in useCall.ts; this file is only the UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Track, type Participant } from "livekit-client";
import { Icon } from "../components/Icon";
import { Logo, NAV } from "../components/Layout";
import { api, getToken } from "../lib/api";
import { RatingForm, type ReviewInput, type ReviewTags } from "../components/Reviews";
import { confirmToast, copy, Spinner, toast } from "../components/ui";
import { fmtDuration, fmtTime } from "../lib/format";
import { DataMeter } from "./dataMeter";
import { AudioRenderer, Avatar, Gallery, sharePub, Tile, VideoView } from "./media";
import { BreakoutPanel, ChatPanel, PeoplePanel, PollsPanel, SettingsPanel, TranscriptPanel, VolumeSlider } from "./Panels";
import { MeetingRecorder, uploadRecording } from "./recorder";
import { useCall, type DataSaver, type JoinPayload } from "./useCall";

/** The 7 reactions (the server only accepts these). */
const REACTIONS = ["👍", "👏", "❤️", "😂", "🎉", "🙏", "😮"];
/** Which side panel is open (null = none). */
type PanelName = "chat" | "transcript" | "people" | "polls" | "breakouts" | "settings" | null;
/** The call screen's theme: dark (default) or light, remembered on this device (Schoola's sun/moon switch). */
const THEME_KEY = "gather.callTheme";
type CallTheme = "dark" | "light";
function useCallTheme() {
  const [theme, setTheme] = useState<CallTheme>(() => { try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; } });
  const choose = (t: CallTheme) => { setTheme(t); try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode: just this visit */ } };
  return [theme, choose] as const;
}
/** Sun / moon switch, like the one at the bottom of Schoola's sidebar. */
function ThemeSwitch({ theme, onChange }: { theme: CallTheme; onChange: (t: CallTheme) => void }) {
  return (
    <div role="radiogroup" aria-label="Screen theme" className="flex w-fit gap-1 rounded-full bg-white/10 p-1">
      {(["light", "dark"] as const).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} aria-label={t === "light" ? "Light mode" : "Dark mode"} title={t === "light" ? "Light mode" : "Dark mode"} onClick={() => onChange(t)}
          className={`flex h-8 w-12 items-center justify-center rounded-full transition ${theme === t ? "bg-white text-ink-900 shadow" : "text-white/60 hover:text-white"}`}>
          <Icon name={t === "light" ? "sun" : "moon"} size={16} />
        </button>
      ))}
    </div>
  );
}
/** Laptops and desktops: the side panel is a column next to the stage, open on chat when the call starts. */
const isWide = () => window.matchMedia?.("(min-width: 1024px)").matches ?? false;

/**
 * The meeting screen. Props come from the join page: tokens, title, chosen caption language,
 * camera on/off, data-saver choice and the E2EE key (if the meeting is encrypted).
 * `autoPresent`: the host came from the dashboard's Share screen tile, so offer "Start sharing" straight away.
 */
export default function RoomView({ join, title, e2eeKey, lang, startCamera, saver, meetingId, captionsAvailable, autoPresent }: {
  join: JoinPayload; title: string; e2eeKey: string | null; lang: string; startCamera: boolean; saver: DataSaver; meetingId?: string; captionsAvailable: boolean; autoPresent?: boolean;
}) {
  const call = useCall(join, { e2eeKey, lang, startCamera, startMic: join.role !== "guest", saver, captionsAvailable });
  const { room, state, role } = call;
  const host = role === "host" || role === "cohost";
  const [theme, setTheme] = useCallTheme();
  const themeCls = theme === "light" ? "call-light" : "";
  const [panel, setPanel] = useState<PanelName>(() => (isWide() ? "chat" : null));
  const [showReactions, setShowReactions] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [meter, setMeter] = useState({ usedMB: 0, mbPerHour: 0 });
  const [zoom, setZoom] = useState(1);
  const [recUpload, setRecUpload] = useState<number | null>(null);
  // Share screen tile: show the "Start sharing" card until the person shares or closes it.
  const [offerShare, setOfferShare] = useState(Boolean(autoPresent));
  // "The host approved your share" card: hidden with its ✕ (it comes back if the host approves again).
  const [hideApproved, setHideApproved] = useState(false);
  useEffect(() => { if (call.shareApproved) setHideApproved(false); }, [call.shareApproved]);
  // The person someone tapped to keep in the big view (null = follow whoever is speaking).
  const [pinned, setPinned] = useState<string | null>(null);
  // Speaker view (one big, the rest in the row underneath) or gallery view (everyone in equal tiles).
  const [view, setView] = useState<"speaker" | "gallery">("speaker");
  // The last person (other than me) who spoke: stays in the big view until someone else talks.
  const lastSpeaker = useRef<string | null>(null);
  // Size of the stage, to fit the big view and the row underneath to the same width.
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  const stageObserver = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    stageObserver.current?.disconnect();
    if (!el) return;
    stageObserver.current = new ResizeObserver(([e]) => setStageBox({ w: e.contentRect.width, h: e.contentRect.height }));
    stageObserver.current.observe(el);
  }, []);
  const stageRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef(new DataMeter()); // counts MB used on this device
  // recRef: the host's browser recording, if one is running (Pro plan).
  const recRef = useRef<MeetingRecorder | null>(null);
  const startedAt = useRef(Date.now());

  // Tick every second for the call timer and the time-limit countdown.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // Sample WebRTC stats every 2 seconds for the data meter.
  useEffect(() => {
    if (!room) return;
    const t = setInterval(() => meterRef.current.sample(room).then(setMeter), 2000);
    return () => clearInterval(t);
  }, [room]);
  // Warn before closing the tab while recording.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (recRef.current?.active) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  // Server-side info per person (display name, role, raised hand), keyed by LiveKit identity.
  const names = useMemo(() => new Map((state?.people ?? []).map((p) => [p.identity, p])), [state]);
  // Reactions currently floating over one person's tile.
  const reactionsFor = (id: string) => call.reactions.filter((r) => r.identity === id).map((r) => r.emoji);

  // Meeting over (or we left / were removed): show the end screen.
  if (call.ended) return <Ended reason={call.ended} host={host} meetingId={meetingId} themeCls={themeCls} ticket={join.ticket} />;
  // Still connecting to the media server.
  if (!room) {
    return <div className={`${themeCls} flex h-full flex-col items-center justify-center gap-3 bg-ink-900 text-white`}><Spinner size={32} /><p>Connecting to the call…</p>
      {call.conn === "disconnected" && <p className="max-w-sm text-center text-sm text-white/60">Can't reach the media server. Check your connection and reload.</p>}</div>;
  }

  // Me first, then everyone else in the LiveKit room.
  const participants: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  // Whoever is sharing a screen right now (the server allows only one presenter at a time).
  const presenter = participants.find((p) => sharePub(p)?.track);
  const myShare = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const me = call.me;
  const micOn = room.localParticipant.isMicrophoneEnabled;
  const camOn = room.localParticipant.isCameraEnabled;
  // The server decides: hosts can always speak; guests only after their raised hand was allowed (or Open mic).
  const canSpeak = me?.canSpeak ?? host;
  // Phone browsers can't share a screen (no getDisplayMedia); sharing from phones comes with native apps.
  const canPresent = Boolean(navigator.mediaDevices?.getDisplayMedia) && !call.isPhone;
  // Time left before the plan limit (Free: 2 hours). The panel card shows it in the last 6 hours;
  // the header chip turns amber/red in the last 15 minutes.
  const left = (state?.endsAt ?? join.endsAt) - now;
  const showClock = left < 15 * 60_000;
  // Hosts see a badge on People: raised hands + people waiting + share requests.
  const badge = host ? (state?.hands.length ?? 0) + (state?.lobby.length ?? 0) + (state?.shareRequests.length ?? 0) : 0;
  // Captions on screen: the last two lines spoken in the past 8 seconds.
  const lastCaption = call.captionsOn ? call.captions.filter((c) => now - new Date(c.at).getTime() < 8000).slice(-2) : [];
  const recording = Boolean(recRef.current?.active);

  // Big view: the pinned person, else whoever spoke last, else the first other person, else me.
  // While someone presents, the screen is big and every camera is in the row.
  const speaking = room.activeSpeakers.find((p) => p !== room.localParticipant);
  if (speaking) lastSpeaker.current = speaking.identity;
  const find = (id: string | null) => (id ? participants.find((p) => p.identity === id) : undefined);
  const others = participants.filter((p) => p !== room.localParticipant);
  const featured = find(pinned) ?? find(lastSpeaker.current) ?? others[0] ?? room.localParticipant;
  const gallery = view === "gallery" && !presenter;
  const strip = gallery ? [] : presenter ? [presenter, ...participants.filter((p) => p !== presenter)] : participants.filter((p) => p !== featured);
  // Schoola layout: the 16:9 big view and the row of `cols` 16:9 tiles underneath share one width, as wide as the
  // stage allows (its height = width × 9/16 for the big view + one tile's height + the gap). Extra people → "+N".
  // On narrow (phone) stages the big view is 3:4 instead, which suits a tall screen.
  const GAP = 12;
  const narrow = stageBox.w < 640;
  const cols = narrow ? 2 : 3;
  const bigRatio = narrow ? 4 / 3 : 9 / 16; // height ÷ width
  const k = bigRatio + (strip.length ? 9 / 16 / cols : 0);
  const c = strip.length ? GAP - ((GAP * (cols - 1)) / cols) * (9 / 16) : 0;
  const frameW = Math.max(0, Math.floor(Math.min(stageBox.w, (stageBox.h - c) / k)));
  const tileW = Math.floor((frameW - GAP * (cols - 1)) / cols);
  const shown = strip.slice(0, cols);
  const moreN = Math.max(0, strip.length - cols);
  // Tap a tile to pin that person big; tap them again to go back to following the speaker.
  const tile = (p: Participant, big?: boolean) => (
    <Tile key={p.identity} p={p} name={names.get(p.identity)?.name ?? p.name ?? "Guest"} isLocal={p === room.localParticipant} hand={names.get(p.identity)?.hand}
      role={names.get(p.identity)?.role} reactions={reactionsFor(p.identity)} featured={big} pinned={pinned === p.identity} saverHidden={call.saver !== "off"}
      onClick={presenter ? undefined : () => setPinned(pinned === p.identity ? null : p.identity)} />
  );

  // Header: who's hosting, and a few faces from the people list; top right: me and my role.
  const hostName = state?.people.find((p) => p.role === "host")?.name;
  const people = state?.people ?? [];
  const myName = names.get(room.localParticipant.identity)?.name ?? room.localParticipant.name ?? "You";
  const roleLabel = role === "host" ? "Host" : role === "cohost" ? "Co-host" : "Guest";
  // The app menu on the left (signed-in people only); its pages open in a new tab so the call keeps going.
  const signedIn = Boolean(getToken());

  /** Share link: the phone's share sheet (WhatsApp...) where there is one, otherwise copy. Keeps the #k= key of encrypted meetings. */
  const shareLink = async () => {
    setShowMore(false);
    const url = window.location.href;
    if (navigator.share && call.isPhone) { navigator.share({ title, url }).catch(() => {}); return; }
    await copy(url);
  };
  /** Full screen for the stage (the big view and the strip). */
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stageRef.current?.requestFullscreen?.().catch(() => {});
  };
  /** Open a side panel tab, or close it if it's already showing. */
  const togglePanel = (name: Exclude<PanelName, null>) => setPanel(panel === name ? null : name);

  /**
   * Host recording (Pro): tell the server first (it checks the plan and shows a REC notice to everyone),
   * then record this tab in the browser and upload the file when it stops.
   */
  const toggleRecord = async () => {
    setShowMore(false);
    if (recRef.current?.active) { recRef.current.stop(); return; }
    const r = await call.actions.emit("record.started");
    if (!r.ok) return;
    const rec = new MeetingRecorder();
    rec.onStopped = async (blob) => {
      call.actions.emit("record.stopped");
      recRef.current = null;
      setRecUpload(0);
      try { await uploadRecording(blob, join.ticket, setRecUpload); toast("Recording saved to the meeting's history"); }
      catch (e: any) { toast(e.message, "error"); }
      finally { setRecUpload(null); }
    };
    try {
      const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      await rec.start(mic);
      recRef.current = rec;
      toast("Recording. Everyone sees a recording notice.", "info");
    } catch {
      call.actions.emit("record.stopped");
      toast("Recording needs you to pick this tab when asked.", "error");
    }
  };

  /**
   * One control: a round button with its label underneath. `on={false}` = red (mic/camera off, recording),
   * `active` = green (hand up, captions on, panel open). `wideOnly` buttons hide on phones (they move into More).
   * `badgePhoneOnly` shows the badge only on phones (on laptops the same count is on the People button).
   * `aria` is what the button does, for screen readers and the tooltip ("Mute"), when the short label is just a name ("Mic").
   */
  const Control = ({ icon, label, aria = label, on, danger, onClick, badgeN, badgePhoneOnly, active, wideOnly }: { icon: string; label: string; aria?: string; on?: boolean; danger?: boolean; onClick: () => void; badgeN?: number; badgePhoneOnly?: boolean; active?: boolean; wideOnly?: boolean }) => (
    <button onClick={onClick} title={aria} aria-label={aria}
      className={`group relative ${wideOnly ? "hidden md:flex" : "flex"} w-[3.25rem] shrink-0 flex-col items-center gap-1 text-[10px] font-medium text-white/70 hover:text-white sm:w-16 sm:text-[11px]`}>
      <span className={`flex h-11 w-11 items-center justify-center rounded-full transition sm:h-12 sm:w-12 ${danger ? "bg-red-600 text-white group-hover:bg-red-700" : on === false ? "bg-red-500/90 text-white" : active ? "bg-brand-600 text-white" : "bg-white/10 text-white group-hover:bg-white/20"}`}>
        <Icon name={icon} size={21} />
      </span>
      <span className="line-clamp-2 max-w-full text-center leading-tight">{label}</span>
      {badgeN ? <span className={`absolute right-0 top-0 min-w-[18px] rounded-full bg-amber-400 px-1 text-[11px] font-bold text-stone-900 sm:right-1 ${badgePhoneOnly ? "md:hidden" : ""}`}>{badgeN}</span> : null}
    </button>
  );
  /** A small status chip in the header. */
  const Chip = ({ children, className = "bg-white/10 text-white/80" }: { children: React.ReactNode; className?: string }) => (
    <span className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>{children}</span>
  );

  // Side panel tabs (breakouts are for hosts only).
  const tabs: { id: Exclude<PanelName, null>; label: string; n?: number }[] = [
    { id: "chat", label: "Chat", n: panel === "chat" ? 0 : call.unread },
    { id: "transcript", label: "Transcript" },
    { id: "people", label: "People", n: badge },
    { id: "polls", label: "Polls" },
    ...(host ? [{ id: "breakouts" as const, label: "Rooms" }] : []),
  ];
  const panelTitle = panel === "chat" ? "Live chat" : panel === "breakouts" ? "Breakout rooms" : tabs.find((t) => t.id === panel)?.label;

  /** Captions, full screen, presenter bar, host requests and share cards, drawn over the big view (or the gallery). */
  const overlays = (
    <>
      {/* Live captions on the big view, shown in MY language (translated by the server) */}
      {lastCaption.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-1 px-12 sm:bottom-4">
          {lastCaption.map((c) => (
            <p key={c.id} className="keep-dark max-w-3xl rounded-lg bg-black/65 px-3 py-1.5 text-center text-[15px] leading-snug backdrop-blur-sm sm:text-lg">
              <span className="font-semibold text-brand-300">{c.name}: </span>{c.translations[call.lang] ?? c.text}
            </p>
          ))}
        </div>
      )}
      {/* Bottom corners of the big view: captions on/off and full screen */}
      <button onClick={() => call.actions.setCaptionsOn(!call.captionsOn)} className={`keep-dark absolute bottom-3 left-3 z-10 rounded-lg p-1.5 ${call.captionsOn ? "bg-brand-600" : "bg-black/55"}`} aria-label={call.captionsOn ? "Hide captions" : "Show captions"} title="Captions">
        <Icon name="captions" size={16} />
      </button>
      {document.fullscreenEnabled && (
        <button onClick={toggleFullscreen} className="keep-dark absolute bottom-3 right-3 z-10 rounded-lg bg-black/55 p-1.5" aria-label="Full screen" title="Full screen">
          <Icon name="expand" size={16} />
        </button>
      )}

      {/* Presenter bar, only when I'm sharing: pause/resume, switch window, stop */}
      {myShare?.track && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full bg-sky-600 px-2 py-1.5 text-xs font-semibold shadow-lg">
          <span className="px-2">You're presenting{myShare.isMuted ? " (paused)" : ""}</span>
          <button onClick={call.actions.pauseShare} className="flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 hover:bg-white/30"><Icon name={myShare.isMuted ? "play" : "pause"} size={14} />{myShare.isMuted ? "Resume" : "Pause"}</button>
          <button onClick={() => call.actions.switchShare()} className="flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 hover:bg-white/30"><Icon name="swap" size={14} />Switch window</button>
          <button onClick={call.actions.stopShare} className="flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 hover:bg-red-700"><Icon name="x" size={14} />Stop</button>
        </div>
      )}
      {/* Host request cards: someone waiting, a raised hand, or a guest asking to present */}
      {host && <HostRequests call={call} onOpen={() => setPanel("people")} />}
      {/* Came from the Share screen tile: one tap opens the screen picker (browsers need the tap). */}
      {offerShare && canPresent && !myShare?.track && (
        <div className="absolute bottom-14 left-1/2 z-20 w-72 -translate-x-1/2 rounded-2xl bg-sky-600 p-4 text-center shadow-xl">
          <button onClick={() => setOfferShare(false)} aria-label="Close" className="absolute right-2 top-2 rounded-full p-1 text-white/80 hover:bg-white/15 hover:text-white"><Icon name="x" size={16} /></button>
          <p className="text-sm font-semibold">Ready to share your screen</p>
          <p className="mt-1 text-xs text-white/80">Pick a screen, window or tab. Send the link so people can watch.</p>
          <button onClick={() => { setOfferShare(false); call.actions.startShare(); }} className="mt-3 w-full rounded-xl bg-white px-3 py-2 text-sm font-bold text-sky-700">Start sharing</button>
          <button onClick={() => setOfferShare(false)} className="mt-1 w-full py-1 text-xs text-white/80 hover:text-white">Not now</button>
        </div>
      )}
      {/* Guest side: the host approved my request to present. The click is needed to open the screen picker. */}
      {call.shareApproved && !myShare?.track && !hideApproved && (
        <div className="absolute bottom-14 right-4 z-20 rounded-2xl bg-sky-600 p-3 pr-9 shadow-xl">
          <button onClick={() => setHideApproved(true)} aria-label="Close" className="absolute right-1.5 top-1.5 rounded-full p-1 text-white/80 hover:bg-white/15 hover:text-white"><Icon name="x" size={16} /></button>
          <p className="mb-2 text-sm font-semibold">The host approved your share</p>
          <button onClick={() => call.actions.startShare()} className="w-full rounded-xl bg-white px-3 py-2 text-sm font-bold text-sky-700">Present now</button>
        </div>
      )}
    </>
  );

  return (
    <div className={`${themeCls} flex h-full overflow-hidden bg-ink-900 text-white`}>
      {/* Plays everyone's audio (hidden <audio> elements). */}
      <AudioRenderer room={room} gainFor={call.gainFor} />

      {/* App menu (Schoola's sidebar): Gather, the plan, the main pages (new tab) with this call highlighted */}
      {signedIn && (
        <nav className="hidden w-60 shrink-0 flex-col border-r border-white/10 px-4 py-5 xl:flex">
          <div className="px-2">
            <Logo light />
            <p className="mt-1 pl-1 text-xs text-white/50">{state?.plan === "free" ? "Free plan" : state?.plan ? `${state.plan[0].toUpperCase()}${state.plan.slice(1)} plan` : ""}</p>
          </div>
          <div className="my-5 border-t border-white/10" />
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-3 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-medium"><Icon name="cam" size={18} />Online meeting<span className="ml-auto h-3 w-1 rounded-full bg-white" /></span>
            {NAV.map((n, i) => (
              <div key={n.to}>
                {(i === 3 || i === 5) && <div className="my-3 border-t border-white/10" />}
                <a href={n.to} target="_blank" rel="noreferrer" title="Opens in a new tab; the call keeps going here" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/70 hover:bg-white/5 hover:text-white">
                  <Icon name={n.icon} size={18} />{n.label}
                </a>
              </div>
            ))}
          </div>
          <div className="mt-auto space-y-4">
            {state?.plan === "free" && host && (
              <a href="/billing" target="_blank" rel="noreferrer" className="block rounded-xl bg-white/5 p-3 text-xs text-white/70 hover:bg-white/10">
                <b className="block text-sm text-white">Free plan: 2 hours</b>Upgrade for longer meetings →
              </a>
            )}
            <div className="px-1"><ThemeSwitch theme={theme} onChange={setTheme} /></div>
          </div>
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header: status chips, title, then host / people / add people */}
        <header className="px-3 pb-2 pt-3 sm:px-5 lg:pt-4">
          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto">
            <Chip className="bg-red-600/90 text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />Live</Chip>
            {call.breakout && <Chip className="bg-sky-500/30 text-sky-100">{call.breakout}</Chip>}
            <Chip><Icon name="clock" size={12} />{fmtDuration((now - startedAt.current) / 1000)}</Chip>
            <button onClick={() => setPanel("settings")} className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 hover:bg-white/20">
              <Icon name="data" size={12} />{meter.usedMB.toFixed(1)} MB{call.saver !== "off" && <span className="text-brand-300">· {call.saver === "audio" ? "audio only" : "data saver"}</span>}
            </button>
            {state?.e2ee && <Chip className="bg-sky-500/20 text-sky-200"><Icon name="shield" size={12} />Encrypted</Chip>}
            {state?.locked && <Chip className="bg-amber-400/20 text-amber-200"><Icon name="lock" size={12} />Locked</Chip>}
            {state?.recording && <Chip className="bg-red-600/90 text-white"><span className="h-2 w-2 animate-pulse rounded-full bg-white" />REC</Chip>}
            {call.conn === "reconnecting" && <Chip className="bg-amber-400/20 text-amber-200">Reconnecting…</Chip>}
            {showClock && <Chip className={left < 5 * 60_000 ? "bg-red-600 text-white" : "bg-amber-500 text-stone-900"}>Ends in {fmtDuration(left / 1000)}</Chip>}
          </div>
          <h1 className="mt-2 truncate text-lg font-semibold sm:text-[1.75rem] sm:leading-tight">{title}</h1>
          <div className="mt-2.5 flex items-center gap-2">
            {hostName && (
              <span className="hidden min-w-0 items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 text-xs text-white/60 sm:flex">
                <Avatar name={hostName} size={26} /><span className="truncate">Hosted by <b className="font-medium text-white">{hostName}</b></span>
              </span>
            )}
            <div className="flex-1" />
            {/* Who's here: up to 3 faces and a +N; opens People */}
            <button onClick={() => togglePanel("people")} className="flex items-center rounded-full bg-white/10 py-1 pl-1 pr-3 text-xs font-semibold hover:bg-white/20" aria-label="Who's here">
              {people.slice(0, 3).map((p, i) => <span key={p.identity} className={`rounded-full ring-2 ring-ink-900 ${i ? "-ml-2" : ""}`}><Avatar name={p.name} size={26} /></span>)}
              <span className="ml-2">{people.length > 3 ? `+${people.length - 3}` : people.length}</span>
            </button>
            <button onClick={shareLink} className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20">
              <Icon name="plus" size={14} /><span className="hidden sm:inline">Add people to meeting</span><span className="sm:hidden">Add</span>
            </button>
          </div>
        </header>

      {/* Time-limit warning banner (15 and 5 minutes before the end); Free-plan hosts get an Upgrade link. */}
      {call.warning && (
        <div className="mx-3 mb-2 sm:mx-5 flex items-center gap-3 rounded-xl bg-amber-400 px-3 py-2 text-sm font-medium text-stone-900">
          <Icon name="clock" size={18} />
          <span className="flex-1">This meeting ends in {call.warning.minutesLeft} minutes ({state?.plan === "free" ? "Free plan limit: 2 hours" : "plan limit"}).</span>
          {host && state?.plan === "free" && <a href="/billing" target="_blank" className="rounded-lg bg-stone-900 px-2.5 py-1 text-xs text-white">Upgrade</a>}
          <button onClick={() => call.setWarning(null)} aria-label="Dismiss"><Icon name="x" size={16} /></button>
        </div>
      )}
      {/* Recording upload progress (host only). */}
      {recUpload !== null && <div className="mx-3 mb-2 sm:mx-5 rounded-xl bg-white/10 px-3 py-2 text-sm">Uploading recording… {recUpload}%</div>}

        {/* Stage: the big view and the row underneath at one width (or the gallery) */}
        <main ref={stageRef} className="flex min-h-0 flex-1 flex-col bg-ink-900 px-2 sm:px-5">
          <div ref={measureRef} className="relative min-h-0 flex-1">
            {gallery ? (
              <div className="relative h-full">
                <Gallery>{participants.map((p) => tile(p, participants.length <= 4))}</Gallery>
                {overlays}
              </div>
            ) : (
              <div className="mx-auto flex h-full flex-col justify-center gap-3" style={{ width: frameW }}>
                <div className="relative shrink-0 rounded-2xl ring-1 ring-brand-500/60" style={{ height: Math.floor(frameW * bigRatio) }}>
                  {presenter ? (
                    // Presenter view: the shared screen is the big view; pinch or the +/- buttons zoom into slides.
                    <div className="keep-dark relative h-full overflow-auto rounded-2xl bg-black" style={{ touchAction: "pinch-zoom" }}>
                      <div style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }} className="min-h-full">
                        <VideoView track={sharePub(presenter)!.track!} contain />
                      </div>
                      <div className="keep-dark absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-black/60 px-3 py-1 text-xs font-semibold">
                        <Icon name="present" size={14} />{names.get(presenter.identity)?.name ?? presenter.name} is presenting{sharePub(presenter)?.isMuted && " (paused)"}
                      </div>
                      <div className="absolute right-3 top-3 flex gap-1">
                        <button onClick={() => setZoom((z) => Math.max(1, z - 0.5))} className="keep-dark rounded-full bg-black/60 p-1.5" aria-label="Zoom out"><Icon name="zoomOut" size={16} /></button>
                        <button onClick={() => setZoom((z) => Math.min(3, z + 0.5))} className="keep-dark rounded-full bg-black/60 p-1.5" aria-label="Zoom in"><Icon name="zoomIn" size={16} /></button>
                      </div>
                    </div>
                  ) : tile(featured, true)}
                  {overlays}
                </div>
                {/* Row: the next people in 16:9 tiles; "+N" on the last one when there are more (opens People) */}
                {shown.length > 0 && (
                  <div className="flex shrink-0 justify-center" style={{ gap: GAP, height: Math.floor((tileW * 9) / 16) }}>
                    {shown.map((p, i) => (
                      <div key={p.identity} className="relative h-full shrink-0" style={{ width: tileW }}>
                        {tile(p)}
                        {moreN > 0 && i === shown.length - 1 && (
                          <button onClick={() => setPanel("people")} aria-label={`${moreN} more people`}
                            className="keep-dark absolute bottom-2 right-2 flex h-10 min-w-[3rem] items-center justify-center rounded-xl bg-black/55 px-2 text-base font-semibold backdrop-blur-sm sm:h-14 sm:min-w-[4rem] sm:text-2xl">+{moreN}</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </main>

        {/* Control bar: left (volume, record), middle (talking and presenting), right (share, panels, more, leave) */}
        <footer className="flex items-start justify-center gap-0.5 px-1.5 pb-[max(env(safe-area-inset-bottom),10px)] pt-3 sm:gap-2 sm:px-5 md:justify-between">
          <div className="hidden flex-1 gap-2 md:flex">
            {/* Volume: speaker volume up to 300% (per person: the speaker button in People) */}
            <div className="relative">
              <Control icon="volume" label={call.volume === 1 ? "Volume" : `${Math.round(call.volume * 100)}%`} active={call.volume > 1} onClick={() => setShowVolume(!showVolume)} />
              {showVolume && (
                <div className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-2xl bg-ink-700 p-3 shadow-xl">
                  <VolumeSlider label="Speaker volume" value={call.volume} onChange={call.actions.setVolume} />
                  <p className="mt-1 text-[11px] text-white/50">Above 100% helps with quiet voices and weak speakers.</p>
                </div>
              )}
            </div>
            {host && canPresent && <Control icon="record" label={recording ? "Stop rec" : "Record"} on={recording ? false : undefined} onClick={toggleRecord} />}
          </div>

          <div className="flex gap-0.5 sm:gap-2">
            {/* Mic: guests without permission see a locked mic that raises their hand */}
            {canSpeak || micOn
              ? <Control icon={micOn ? "mic" : "micOff"} label="Mic" aria={micOn ? "Mute" : "Unmute"} on={micOn} onClick={call.actions.toggleMic} />
              : <Control icon="lockMic" label={me?.hand ? "Waiting…" : "Ask to speak"} active={me?.hand} onClick={call.actions.toggleMic} />}
            <Control icon={camOn ? "cam" : "camOff"} label="Cam" aria={camOn ? "Stop video" : "Start video"} on={camOn} active={camOn} onClick={call.actions.toggleCam} />
            {/* Present: hosts share at once; guests "Ask to present" and share after the host allows */}
            {canPresent && <Control wideOnly icon="present" label={myShare?.track ? "Presenting" : me?.canShare || host ? "Share screen" : "Ask to present"} aria={myShare?.track ? "Stop presenting" : me?.canShare || host ? "Present" : "Ask to present"} active={Boolean(myShare?.track)} onClick={() => (myShare?.track ? call.actions.stopShare() : call.actions.startShare())} />}
            {/* Reactions picker */}
            <div className="relative">
              <Control icon="smile" label="React" onClick={() => setShowReactions(!showReactions)} />
              {showReactions && (
                <div className="absolute bottom-full left-1/2 z-30 mb-2 flex -translate-x-1/2 gap-1 rounded-full bg-ink-700 p-1.5 shadow-xl">
                  {REACTIONS.map((e) => <button key={e} onClick={() => { call.actions.react(e); setShowReactions(false); }} className="rounded-full p-1.5 text-2xl transition hover:scale-125 hover:bg-white/10">{e}</button>)}
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-0.5 sm:gap-2 md:flex-1 md:justify-end">
            <Control wideOnly icon="link" label="Share link" onClick={shareLink} />
            <Control icon="chat" label="Chat" badgeN={panel === "chat" ? 0 : call.unread} active={panel === "chat"} onClick={() => togglePanel("chat")} />
            {/* More menu: phone-only shortcuts, polls, video mode, host tools */}
            <div className="relative">
              <Control icon="more" label="More" badgeN={badge} onClick={() => setShowMore(!showMore)} />
              {showMore && (
                <div className="absolute bottom-full right-0 z-30 mb-2 w-64 overflow-hidden rounded-2xl bg-ink-700 py-1 text-sm shadow-xl">
                  {/* Phones: the buttons that don't fit in the bar */}
                  <MenuItem icon="users" onClick={() => { setPanel("people"); setShowMore(false); }}>People{badge ? ` (${badge} waiting)` : ""}</MenuItem>
                  <MenuItem icon="hand" onClick={() => { call.actions.toggleHand(); setShowMore(false); }}>{me?.hand ? "Lower hand" : "Raise hand"}</MenuItem>
                  <MenuItem icon="captions" onClick={() => { call.actions.setCaptionsOn(!call.captionsOn); setShowMore(false); }}>{call.captionsOn ? "Hide captions" : "Show captions"}</MenuItem>
                  <MenuItem icon="link" className="flex md:hidden" onClick={shareLink}>Share link</MenuItem>
                  <MenuItem icon="volume" className="flex md:hidden" onClick={() => { setPanel("settings"); setShowMore(false); }}>Volume, data and language</MenuItem>
                  <MenuItem icon="data" className="hidden md:flex" onClick={() => { setPanel("settings"); setShowMore(false); }}>Data saver and language</MenuItem>
                  {/* Phone browsers can't capture a screen: explain instead of hiding presenting silently. */}
                  {!canPresent && <MenuItem icon="present" onClick={() => { setShowMore(false); toast("To present, join from a laptop or desktop browser. On a phone you can watch presentations.", "info"); }}>Present (laptop or desktop)</MenuItem>}
                  {canPresent && <MenuItem icon="present" className="flex md:hidden" onClick={() => { setShowMore(false); myShare?.track ? call.actions.stopShare() : call.actions.startShare(); }}>{myShare?.track ? "Stop presenting" : "Present"}</MenuItem>}
                  <MenuItem icon={theme === "dark" ? "sun" : "moon"} onClick={() => { setTheme(theme === "dark" ? "light" : "dark"); setShowMore(false); }}>{theme === "dark" ? "Light mode" : "Dark mode"}</MenuItem>
                <MenuItem icon="poll" onClick={() => { setPanel("polls"); setShowMore(false); }}>Polls</MenuItem>
                  {canPresent && <MenuItem icon="present" className="hidden md:flex" onClick={() => { setShowMore(false); call.actions.startShare(true); }}>Present a video (smoother motion)</MenuItem>}
                  {!presenter && <MenuItem icon="grid" onClick={() => { setView(gallery ? "speaker" : "gallery"); setPinned(null); setShowMore(false); }}>{gallery ? "Speaker view" : "Gallery view (everyone the same size)"}</MenuItem>}
                  {pinned && !gallery && <MenuItem icon="x" onClick={() => { setPinned(null); setShowMore(false); }}>Unpin (follow the speaker)</MenuItem>}
                  <MenuItem icon="captions" onClick={() => { setPanel("transcript"); setShowMore(false); }}>Transcript</MenuItem>
                  {host && <MenuItem icon="grid" onClick={() => { setPanel("breakouts"); setShowMore(false); }}>Breakout rooms</MenuItem>}
                  {host && canPresent && <MenuItem icon="record" className="flex md:hidden" onClick={toggleRecord}>{recording ? "Stop recording" : "Record (Pro)"}</MenuItem>}
                  {host && <MenuItem icon={state?.locked ? "unlock" : "lock"} onClick={() => { call.actions.emit("mod.lock", { locked: !state?.locked }); setShowMore(false); }}>{state?.locked ? "Unlock meeting" : "Lock meeting"}</MenuItem>}
                  {role === "host" && <MenuItem icon="leave" danger onClick={async () => { setShowMore(false); if (await confirmToast("End the meeting for everyone?", { confirm: "End for all", danger: true })) call.actions.emit("meeting.end"); }}>End meeting for all</MenuItem>}
                </div>
              )}
            </div>
            <Control icon="leave" label="Leave" danger onClick={() => { if (recRef.current?.active) recRef.current.stop(); call.actions.leave(); }} />
          </div>
        </footer>
      </div>

      {/* Right column (Schoola's Live Chat): me, the panel bar (tap to close) and the panel; a bottom sheet on phones */}
      {panel && (
        <aside className="fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col rounded-t-3xl bg-ink-800 p-4 shadow-2xl lg:static lg:z-auto lg:max-h-none lg:w-[22rem] lg:shrink-0 lg:rounded-none lg:border-l lg:border-white/10 lg:bg-ink-900 lg:px-4 lg:pb-4 lg:pt-4 lg:shadow-none xl:w-[24rem]">
          <div className="mb-3 hidden items-center gap-3 px-1 lg:flex">
            <Avatar name={myName} size={40} />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{myName}</p><p className="text-xs text-white/50">{roleLabel}</p></div>
          </div>
          <div className="mb-3 flex items-center gap-1 rounded-full bg-white/10 py-1 pl-4 pr-1 text-sm font-medium lg:mt-[2.15rem]">
            <Icon name={panel === "settings" ? "settings" : "chat"} size={16} /><span className="ml-1 flex-1 truncate">{panel === "settings" ? "Call settings" : panelTitle}</span>
            <button onClick={() => togglePanel("settings")} className={`rounded-full p-2 ${panel === "settings" ? "bg-brand-600" : "text-white/70 hover:bg-white/10"}`} aria-label="Call settings" title="Volume, data saver and caption language"><Icon name="settings" size={16} /></button>
            <button onClick={() => setPanel(null)} className="rounded-full p-2 text-white/70 hover:bg-white/10" aria-label="Close panel"><Icon name="x" size={16} /></button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl lg:bg-ink-800 lg:p-3">
            <div role="tablist" className="no-scrollbar mb-3 flex gap-1 overflow-x-auto rounded-full bg-ink-900 p-1">
              {tabs.map((t) => (
                <button key={t.id} role="tab" aria-selected={panel === t.id} onClick={() => setPanel(t.id)} className={`relative flex-1 shrink-0 whitespace-nowrap rounded-full px-2 py-1.5 text-xs font-semibold transition ${panel === t.id ? "bg-ink-600 text-white" : "text-white/60 hover:text-white"}`}>
                  {t.label}{t.n ? <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-stone-900">{t.n}</span> : null}
                </button>
              ))}
            </div>
            {/* "Before close" card: time left on the plan's meeting limit */}
            {left < 6 * 3600_000 && (
              <div className={`mb-3 flex items-center gap-3 rounded-xl px-3 py-2 ${showClock ? "bg-amber-500/20 ring-1 ring-amber-400/30" : "bg-brand-600/25 ring-1 ring-brand-500/40"}`}>
                <div className="text-center leading-tight"><b className="block font-mono text-base">{fmtDuration(Math.max(0, left) / 1000)}</b><span className="text-[10px] text-white/60">Before close</span></div>
                <div className="h-8 w-px bg-white/15" />
                <p className="flex-1 text-xs text-white/70">Ends at {fmtTime(new Date(state?.endsAt ?? join.endsAt))}{state?.plan === "free" && " · Free plan: 2 hours"}</p>
                {host && state?.plan === "free" && <a href="/billing" target="_blank" className="text-xs font-semibold text-brand-300 hover:underline">Upgrade</a>}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panel === "people" && <PeoplePanel call={call} />}
              {panel === "chat" && <ChatPanel call={call} />}
              {panel === "transcript" && <TranscriptPanel call={call} />}
              {panel === "polls" && <PollsPanel call={call} />}
              {panel === "breakouts" && host && <BreakoutPanel call={call} />}
              {panel === "settings" && <SettingsPanel call={call} meter={meter} />}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

/** One row in the More menu. */
function MenuItem({ icon, children, onClick, danger, className = "flex" }: { icon: string; children: React.ReactNode; onClick: () => void; danger?: boolean; className?: string }) {
  return <button onClick={onClick} className={`${className} w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/10 ${danger ? "text-red-400" : ""}`}><Icon name={icon} size={18} />{children}</button>;
}


/**
 * Pop-up cards for hosts: someone waiting, a raised hand, a share request.
 * At most two of each are shown; "See all requests" opens the People panel.
 */
function HostRequests({ call, onOpen }: { call: ReturnType<typeof useCall>; onOpen: () => void }) {
  const s = call.state;
  if (!s) return null;
  const name = (id: string) => s.people.find((p) => p.identity === id)?.name ?? "Someone";
  const cards = [
    ...s.lobby.slice(0, 2).map((l) => ({ key: `l${l.waitId}`, text: `${l.name} is waiting to join`, yes: () => call.actions.emit("lobby.admit", { waitId: l.waitId }), no: () => call.actions.emit("lobby.deny", { waitId: l.waitId }), yesLabel: "Admit" })),
    ...s.hands.slice(0, 2).map((id) => ({ key: `h${id}`, text: `✋ ${name(id)} wants to speak`, yes: () => call.actions.emit("hand.allow", { identity: id }), no: () => call.actions.emit("hand.deny", { identity: id }), yesLabel: "Allow" })),
    ...s.shareRequests.slice(0, 2).map((id) => ({ key: `s${id}`, text: `${name(id)} wants to present`, yes: () => call.actions.emit("share.allow", { identity: id }), no: () => call.actions.emit("share.deny", { identity: id }), yesLabel: "Allow" })),
  ];
  if (!cards.length) return null;
  return (
    <div className="absolute right-3 top-3 z-20 w-72 space-y-2">
      {cards.map((c) => (
        <div key={c.key} className="rounded-2xl bg-ink-700/95 p-3 shadow-xl ring-1 ring-white/10">
          <p className="text-sm font-semibold">{c.text}</p>
          <div className="mt-2 flex gap-2">
            <button onClick={c.yes} className="flex-1 rounded-lg bg-brand-600 py-1.5 text-xs font-bold">{c.yesLabel}</button>
            <button onClick={c.no} className="flex-1 rounded-lg bg-white/10 py-1.5 text-xs font-semibold">Not now</button>
          </div>
        </div>
      ))}
      {s.lobby.length + s.hands.length + s.shareRequests.length > cards.length && <button onClick={onOpen} className="w-full text-xs text-white/60 underline">See all requests</button>}
    </div>
  );
}

/**
 * End screen: why the meeting ended and where the summary will arrive. On someone's first meeting it also asks
 * them to rate Gather (host or guest); "Not now" sends them the review link on WhatsApp/email instead.
 */
function Ended({ reason, host, meetingId, themeCls, ticket }: { reason: string; host: boolean; meetingId?: string; themeCls: string; ticket: string }) {
  const text: Record<string, string> = {
    left: "You left the meeting.",
    host_ended: "The host ended the meeting.",
    time_limit: "The meeting reached its time limit (Free plan: 2 hours).",
    empty: "The meeting ended.",
    removed: "The host removed you from this meeting.",
    gone: "This meeting has ended.",
  };
  // Review: "loading" until we know, then "ask" (first meeting), "skipped" (link sent) or "no".
  const [review, setReview] = useState<{ step: "loading" | "ask" | "skipped" | "no"; tags?: ReviewTags; name?: string; sentTo?: string }>({ step: reason === "removed" ? "no" : "loading" });
  useEffect(() => {
    if (reason === "removed") return;
    api<{ ask: boolean; tags?: ReviewTags; name?: string }>("/rooms/review", { token: ticket })
      .then((r) => setReview(r.ask && r.tags ? { step: "ask", tags: r.tags, name: r.name } : { step: "no" }))
      .catch(() => setReview({ step: "no" }));
  }, [reason, ticket]);
  const skip = async () => {
    setReview((r) => ({ ...r, step: "skipped" }));
    const r = await api<{ sent: string | null; email?: boolean; phone?: boolean }>("/rooms/review/skip", { method: "POST", token: ticket }).catch(() => null);
    setReview((x) => ({ ...x, sentTo: r?.sent === "sent" ? [r.phone && "WhatsApp", r.email && "email"].filter(Boolean).join(" and ") || "you" : undefined }));
  };
  const asking = review.step === "ask" && review.tags;
  return (
    <div className={`${themeCls} flex h-full flex-col items-center justify-center gap-4 overflow-y-auto bg-ink-900 px-4 py-8 text-center text-white`}>
      <p className={asking ? "text-3xl" : "text-5xl"}>👋</p>
      <h1 className={`${asking ? "text-xl" : "text-2xl"} font-bold`}>{text[reason] ?? "The meeting ended."}</h1>
      {asking ? (
        <RatingForm variant="call" tags={review.tags!}
          title={`How was it${review.name ? `, ${review.name.split(/\s+/)[0]}` : ""}?`}
          subtitle="This was your first meeting on Gather. Rate it, good or bad: it takes 30 seconds."
          onSubmit={(r: ReviewInput) => api("/rooms/review", { method: "POST", token: ticket, body: r })} onSkip={skip} />
      ) : (
        reason !== "removed" && <p className="max-w-md text-white/60">If you left a WhatsApp number or email, the summary and action items will arrive there shortly, in your language.</p>
      )}
      {review.step === "skipped" && <p className="max-w-md rounded-xl bg-white/10 px-4 py-2.5 text-sm text-white/80">No problem. {review.sentTo ? `We've sent the review link to your ${review.sentTo}, ` : "You can rate Gather later from the link we send you, "}whenever you have a minute.</p>}
      <div className="flex gap-2">
        {reason === "left" && <button onClick={() => window.location.reload()} className="rounded-xl bg-white/10 px-4 py-2.5 font-semibold">Rejoin</button>}
        {host && meetingId ? <Link to={`/meetings/${meetingId}`} className="rounded-xl bg-brand-600 px-4 py-2.5 font-semibold">Meeting page</Link>
          : <Link to="/" className="rounded-xl bg-brand-600 px-4 py-2.5 font-semibold">Gather home</Link>}
      </div>
    </div>
  );
}
