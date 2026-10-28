/**
 * media.tsx: small building blocks that put LiveKit tracks on screen.
 * VideoView (one video track), AudioRenderer (everyone's sound, up to 400% loud), Avatar (initials when there's no video)
 * and Tile (one person in the grid or strip, with mic state, raised hand and floating reactions).
 */
import { useEffect, useRef, useState } from "react";
import { Track, type Participant, type RemoteTrack, type Room, type TrackPublication } from "livekit-client";
import { Icon } from "../components/Icon";
import { loadPrefs } from "../lib/devices";
import { colorFor, initials } from "../lib/format";

/** Attaches a LiveKit video track to a <video> element. */
export function VideoView({ track, className = "", contain, mirror }: { track: Track; className?: string; contain?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={`h-full w-full ${contain ? "object-contain" : "object-cover"} ${mirror ? "-scale-x-100" : ""} ${className}`} />;
}

/**
 * Plays every remote audio track (microphones and shared-tab sound).
 * @param gainFor  how loud to play one person (1 = 100%, up to 4): my speaker volume × my volume for them × the host's boost
 */
export function AudioRenderer({ room, gainFor }: { room: Room; gainFor: (identity: string) => number }) {
  const tracks: { track: RemoteTrack; identity: string }[] = [];
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) if (pub.kind === Track.Kind.Audio && pub.track) tracks.push({ track: pub.track as RemoteTrack, identity: p.identity });
  }
  return <div className="hidden">{tracks.map(({ track, identity }) => <AudioEl key={track.sid} track={track} gain={gainFor(identity)} />)}</div>;
}

/*
 * An <audio> element stops at 100%. Louder than that, the sound goes through Web Audio instead:
 * track → gain (up to 400%) → limiter → speakers. The limiter keeps boosted voices from crackling on small
 * phone and laptop speakers. One AudioContext (and one limiter) is shared by every track in the call.
 */
let out: { ctx: AudioContext; limiter: DynamicsCompressorNode } | null = null;
function audioOut() {
  if (!out) {
    const ctx = new AudioContext();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; // start squashing just below full scale
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    // Boosted sound plays from the AudioContext, so send it to the speaker chosen in Settings too (Chrome/Edge).
    const speaker = loadPrefs().speaker;
    if (speaker && "setSinkId" in ctx) (ctx as any).setSinkId(speaker).catch(() => {});
    out = { ctx, limiter };
  }
  // Browsers start an AudioContext only after the person has clicked something; joining the call counts.
  if (out.ctx.state === "suspended") out.ctx.resume().catch(() => {});
  return out;
}

/** One hidden <audio> element bound to one remote audio track, played at `gain` (1 = 100%). */
function AudioEl({ track, gain }: { track: RemoteTrack; gain: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const boost = useRef<{ source: MediaStreamAudioSourceNode; gain: GainNode } | null>(null);
  // Bumped when the shared AudioContext starts running, so a waiting boost gets applied.
  const [, setReady] = useState(0);
  useEffect(() => {
    const el = ref.current!;
    track.attach(el);
    return () => {
      track.detach(el);
      boost.current?.source.disconnect();
      boost.current?.gain.disconnect();
      boost.current = null;
    };
  }, [track]);
  useEffect(() => {
    const el = ref.current!;
    if (gain <= 1) {
      // Up to 100%: the plain <audio> element is enough (and works everywhere).
      boost.current?.source.disconnect();
      boost.current?.gain.disconnect();
      boost.current = null;
      el.muted = false;
      el.volume = Math.max(0, gain);
      return;
    }
    let o: ReturnType<typeof audioOut>;
    try { o = audioOut(); } catch { el.muted = false; el.volume = 1; return; } // no Web Audio: best we can do is 100%
    if (o.ctx.state !== "running") {
      // Keep playing at 100% until the AudioContext is allowed to start, then switch to the boosted path.
      el.muted = false; el.volume = 1;
      const onState = () => setReady((n) => n + 1);
      o.ctx.addEventListener("statechange", onState);
      window.addEventListener("pointerdown", audioOut, { once: true });
      return () => { o.ctx.removeEventListener("statechange", onState); window.removeEventListener("pointerdown", audioOut); };
    }
    if (!boost.current) {
      const source = o.ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const g = o.ctx.createGain();
      source.connect(g).connect(o.limiter);
      boost.current = { source, gain: g };
    }
    boost.current.gain.gain.value = Math.min(4, gain);
    // The element must keep playing (muted): Chrome only delivers remote WebRTC audio to Web Audio while it does.
    el.muted = true;
  });
  return <audio ref={ref} autoPlay />;
}

/** A participant's camera publication (may exist without a received track in data-saver mode). */
export const camPub = (p: Participant): TrackPublication | undefined => p.getTrackPublication(Track.Source.Camera);
/** A participant's screen-share publication, if they are presenting. */
export const sharePub = (p: Participant): TrackPublication | undefined => p.getTrackPublication(Track.Source.ScreenShare);

/** Coloured circle with initials (colour is stable per name). */
export function Avatar({ name, size = 64 }: { name: string; size?: number }) {
  return (
    <div className="flex items-center justify-center rounded-full font-bold text-white" style={{ width: size, height: size, background: colorFor(name), fontSize: size * 0.38 }}>
      {initials(name)}
    </div>
  );
}

/**
 * One person: camera video or initials, a name pill, a mic badge, raised hand, speaking ring and floating reactions.
 * `featured` is the big speaker view (name card at the top); otherwise it's a small tile beside it (name at the bottom).
 * `pinned` marks the person someone tapped to keep in the big view.
 */
export function Tile({ p, name, isLocal, hand, role, reactions, featured, pinned, saverHidden, onClick }: {
  p: Participant; name: string; isLocal: boolean; hand?: boolean; role?: string; reactions: string[]; featured?: boolean; pinned?: boolean; saverHidden?: boolean; onClick?: () => void;
}) {
  const cam = camPub(p);
  // Show video only if the camera is on and we actually receive it (data saver may have unsubscribed it).
  const showVideo = cam?.track && !cam.isMuted && (isLocal || cam.isSubscribed);
  const micOn = p.isMicrophoneEnabled;
  const quality = p.connectionQuality; // LiveKit's estimate: excellent / good / poor
  return (
    <div onClick={onClick} className={`keep-dark relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br from-ink-600 to-ink-800 ${featured ? "rounded-2xl" : "rounded-xl"} ${onClick ? "cursor-pointer" : ""} ${p.isSpeaking ? "ring-2 ring-brand-400" : ""}`}>
      {/* The video covers its tile (like Zoom and Meet); tiles have the camera's own 16:9 shape, so faces aren't squeezed. */}
      {showVideo ? <VideoView track={cam!.track!} mirror={isLocal} /> : <span className="rounded-full ring-4 ring-white/10"><Avatar name={name} size={featured ? 104 : 44} /></span>}
      {saverHidden && cam?.track === undefined && cam && !isLocal && (
        <span className={`absolute rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/80 ${featured ? "bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap" : "left-2 top-2"}`}>{featured ? "video paused (data saver)" : "paused"}</span>
      )}
      {/* Name tag (Schoola style): a dark pill with a person icon, top-left on the big view, bottom-left on small tiles */}
      <div className={`absolute left-2 flex max-w-[80%] items-center gap-1.5 rounded-lg bg-black/45 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm ${featured ? "top-2 sm:left-3 sm:top-3 sm:px-2.5 sm:text-sm" : "bottom-2"}`}>
        <Icon name="user" size={featured ? 14 : 12} className="shrink-0 text-white/80" />
        {hand && <span title="Hand raised">✋</span>}
        {pinned && <span title="Pinned">📌</span>}
        <span className="truncate">{isLocal ? "You" : name}</span>
        {role && role !== "guest" && <span className="rounded bg-white/20 px-1 text-[10px] uppercase">{role === "cohost" ? "co-host" : "host"}</span>}
        {quality === "poor" && <span title="Weak connection" className="text-amber-300"><Icon name="data" size={13} /></span>}
      </div>
      {/* Mic badge (top-right): green while unmuted, dark with a slash while muted */}
      <span className={`absolute right-2 top-2 flex items-center justify-center rounded-md ${featured ? "h-7 w-7 sm:right-3 sm:top-3" : "h-6 w-6"} ${micOn ? "bg-brand-600 text-white" : "bg-black/45 text-white/80"}`}
        title={micOn ? "Mic on" : "Muted"}>
        <Icon name={micOn ? "mic" : "micOff"} size={featured ? 15 : 13} />
      </span>
      <div className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2">
        {reactions.map((e, i) => <span key={i} className="reaction-float absolute text-4xl" style={{ left: (i % 3) * 18 - 18 }}>{e}</span>)}
      </div>
    </div>
  );
}

/**
 * Zoom / Google Meet style gallery: every child gets an equal tile with the same shape (16:9 on wide screens,
 * 3:4 on tall phone screens), and the grid picks the number of columns that makes the tiles as big as possible
 * for the space it has. Tiles are centred, so 1 person fills the stage and 5 people sit as 3 + 2.
 */
export function Gallery({ children, gap = 10 }: { children: React.ReactNode[]; gap?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = Math.max(1, children.length);
  const ratio = size.w >= size.h * 0.9 ? 16 / 9 : 3 / 4;
  // Try every column count; keep the one with the widest tile that still fits the height.
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((size.w - gap * (cols - 1)) / cols, ((size.h - gap * (rows - 1)) / rows) * ratio);
    if (w > best.w) best = { w, cols };
  }
  const tileW = Math.floor(Math.max(0, best.w));
  return (
    <div ref={ref} className="flex h-full w-full flex-wrap content-center items-center justify-center overflow-hidden" style={{ gap }}>
      {size.w > 0 && children.map((c, i) => <div key={(c as any)?.key ?? i} style={{ width: tileW, height: Math.floor(tileW / ratio) }}>{c}</div>)}
    </div>
  );
}
