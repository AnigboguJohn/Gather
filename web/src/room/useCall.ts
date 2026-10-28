/**
 * useCall: the call engine behind the meeting screen (Room.tsx).
 *
 * It keeps two connections open for one person in a meeting:
 *  - LiveKit (WebRTC) for media: microphone, camera and screen share, sent through the LiveKit SFU.
 *  - Socket.IO to the Gather server's "signal" module (server/src/modules/rooms.ts) for everything else:
 *    raised hands, who may speak or present, reactions, chat, captions, polls, breakouts and the plan's time limit.
 *
 * The server is the authority on permissions: it changes what LiveKit lets each person publish, and broadcasts
 * a full `state` snapshot that this hook stores. The UI reads everything from the object this hook returns.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalE2EEKeyProvider, LocalTrackPublication, Room, RoomEvent, Track, VideoPresets, type RoomOptions,
} from "livekit-client";
import { io, type Socket } from "socket.io-client";
import { toast } from "../components/ui";
import { loadPrefs } from "../lib/devices";
import { CaptionRecorder, CaptionVoice } from "./captions";

/** What the server returns when someone is admitted (see `admit()` in rooms.ts). */
export interface JoinPayload {
  identity: string; role: "host" | "cohost" | "guest"; livekitUrl: string; livekitRoom: string; livekitToken: string;
  ticket: string; endsAt: number; plan: string; e2ee: boolean;
}
/**
 * One person in the call, as the signal service describes them (canSpeak/canShare are server decisions).
 * `boost` is the host's volume boost for them (1 = normal, up to 3), which every listener applies.
 */
export interface Person { identity: string; name: string; role: "host" | "cohost" | "guest"; lang: string; hand: boolean; canSpeak: boolean; canShare: boolean; via: string; room: string; online: boolean; boost: number }
/** Full room snapshot broadcast by the server on every change (`state` event). `lobby` is only filled for hosts. */
export interface SignalState {
  slug: string; title: string; sessionId: string; endsAt: number; plan: string; locked: boolean; openMic: boolean; anyoneCanShare: boolean;
  waitingRoom: boolean; e2ee: boolean; sharer: string | null; shareRequests: string[]; recording: { by: string; name: string; at: number } | null;
  hands: string[]; people: Person[];
  polls: { id: string; question: string; options: string[]; closed: boolean; counts: number[] }[];
  breakouts: { endsAt: number | null; rooms: { id: string; label: string; members: string[] }[] } | null;
  lobby: { waitId: string; name: string; contact: string; verified: boolean; at: number }[];
}
/** One live caption line: the original text plus a translation for every language someone in the room follows. */
export interface Caption { id: number; identity: string; name: string; lang: string; text: string; translations: Record<string, string>; at: string }
/** One chat message (also saved on the server and used in the summary). */
export interface ChatMsg { id: number; identity: string; name: string; text: string; at: string }
/** Data use: "off" = all videos, "on" = only the active speaker's video (~50 MB/h), "audio" = no camera video at all. */
export type DataSaver = "off" | "on" | "audio";

/** Highest volume a listener can pick, for everyone or for one person (3 = 300%, like VLC's 200% and a bit more). */
export const MAX_VOLUME = 3;
/** My speaker volume is remembered on this device, so it's the same in the next meeting (Settings sets it too). */
const VOLUME_KEY = "gather.volume";
export function savedVolume() {
  try { const v = Number(localStorage.getItem(VOLUME_KEY)); return v > 0 && v <= MAX_VOLUME ? v : 1; } catch { return 1; }
}
export function saveVolume(v: number) {
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* private mode: just this meeting */ }
}

/** Touch-first devices (phones). Used to hide screen sharing, which phone browsers can't do. */
const isPhone = () => window.matchMedia?.("(pointer: coarse)").matches;

/**
 * LiveKit settings tuned for weak, expensive mobile data.
 * Capture is smaller in data-saver modes; simulcast sends two small layers so viewers can pick the cheapest.
 * Microphone, camera, speaker and voice clean-up come from Settings → Voice & video.
 */
function roomOptions(saver: DataSaver, e2ee?: { keyProvider: ExternalE2EEKeyProvider; worker: Worker }): RoomOptions {
  const dev = loadPrefs();
  return {
    adaptiveStream: true, // receive only the video size each tile actually shows
    dynacast: true, // stop sending video layers nobody is watching
    videoCaptureDefaults: { resolution: saver === "off" ? VideoPresets.h360.resolution : VideoPresets.h180.resolution, deviceId: dev.cam },
    audioCaptureDefaults: { deviceId: dev.mic, echoCancellation: true, noiseSuppression: dev.cleanVoice, autoGainControl: dev.cleanVoice },
    ...(dev.speaker ? { audioOutput: { deviceId: dev.speaker } } : {}),
    publishDefaults: {
      simulcast: true, // send several qualities; each viewer receives only the one it needs
      videoSimulcastLayers: [VideoPresets.h90, VideoPresets.h180],
      dtx: true, // send almost nothing during silence
      red: true, // redundant audio packets survive packet loss
      videoCodec: "vp8", // decodes in hardware on almost every phone
      screenShareEncoding: { maxBitrate: 900_000, maxFramerate: 5 }, // slides: sharp text at a low frame rate
    },
    // End-to-end encryption: frames are encrypted in a worker with a key the server never sees.
    ...(e2ee ? { encryption: e2ee } : {}),
  };
}

/**
 * Connects to the call and returns its live state plus actions (mic, camera, present, hand, chat...).
 * @param join  tokens from the join API (LiveKit token + room ticket for the socket)
 * @param opts  choices from the join screen (camera on?, mic on?, caption language, data saver, E2EE key)
 */
export function useCall(join: JoinPayload, opts: { e2eeKey: string | null; lang: string; startCamera: boolean; startMic: boolean; saver: DataSaver; captionsAvailable: boolean }) {
  const [room, setRoom] = useState<Room | null>(null);
  // LiveKit objects mutate in place, so we re-render by bumping a counter whenever a media event fires.
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [state, setState] = useState<SignalState | null>(null);
  const [role, setRole] = useState(join.role);
  const [conn, setConn] = useState<"connecting" | "connected" | "reconnecting" | "disconnected">("connecting");
  const [ended, setEnded] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [unread, setUnread] = useState(0);
  const [reactions, setReactions] = useState<{ key: number; identity: string; emoji: string }[]>([]);
  const [warning, setWarning] = useState<{ minutesLeft: number } | null>(null);
  const [breakout, setBreakout] = useState<string | null>(null);
  const [shareApproved, setShareApproved] = useState(false);
  const [lang, setLangState] = useState(opts.lang);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [listen, setListen] = useState(false);
  const [saver, setSaver] = useState<DataSaver>(opts.saver);
  // Volume (1 = 100%): my speaker volume for everyone, plus my own level for single people (by identity).
  const [volume, setVolumeState] = useState(savedVolume);
  const [personVolume, setPersonVolumeState] = useState<Record<string, number>>({});
  // Refs hold values that socket handlers (registered once) must read fresh, without re-registering.
  const socketRef = useRef<Socket | null>(null);
  const roomRef = useRef<Room | null>(null);
  const voiceRef = useRef(new CaptionVoice(opts.lang));
  const langRef = useRef(opts.lang);
  const listenRef = useRef(false);
  const chatOpenRef = useRef(false);

  /* ---------- LiveKit ---------- */
  /**
   * Opens a media connection with a LiveKit token and turns camera/mic back on if asked.
   * Used for the first join and again when moving to/from a breakout room (new token, new LiveKit room).
   */
  const connectMedia = useCallback(async (lkToken: string, restore: { cam: boolean; mic: boolean }) => {
    let e2ee: { keyProvider: ExternalE2EEKeyProvider; worker: Worker } | undefined;
    // E2EE: the shared key comes from the link's #k= fragment; the LiveKit worker encrypts/decrypts every frame.
    if (join.e2ee && opts.e2eeKey) {
      const keyProvider = new ExternalE2EEKeyProvider();
      await keyProvider.setKey(opts.e2eeKey);
      e2ee = { keyProvider, worker: new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" }) };
    }
    const r = new Room(roomOptions(saver, e2ee));
    // Any of these events can change what the screen shows (tiles, mic icons, speaking ring...): re-render.
    const events = [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ActiveSpeakersChanged, RoomEvent.ParticipantPermissionsChanged,
      RoomEvent.ConnectionQualityChanged, RoomEvent.ParticipantNameChanged,
    ];
    for (const ev of events) r.on(ev as any, bump);
    r.on(RoomEvent.Reconnecting, () => setConn("reconnecting"));
    r.on(RoomEvent.Reconnected, () => setConn("connected"));
    r.on(RoomEvent.Disconnected, () => { if (roomRef.current === r) setConn("disconnected"); });
    r.on(RoomEvent.MediaDevicesError, (e: Error) => toast(`Camera/mic: ${e.message}`, "error"));
    // Screen share started/stopped by this browser → tell the signal service (one presenter at a time).
    r.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => { if (pub.source === Track.Source.ScreenShare) socketRef.current?.emit("share.started"); });
    r.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => { if (pub.source === Track.Source.ScreenShare) socketRef.current?.emit("share.ended"); });
    // autoSubscribe: receive everyone's tracks; the data-saver effect below then unsubscribes cameras we don't need.
    await r.connect(join.livekitUrl, lkToken, { autoSubscribe: true });
    if (e2ee) await r.setE2EEEnabled(true);
    roomRef.current = r;
    setRoom(r);
    setConn("connected");
    if (restore.cam) await r.localParticipant.setCameraEnabled(true).catch(() => toast("Couldn't start your camera", "error"));
    if (restore.mic) await r.localParticipant.setMicrophoneEnabled(true).catch(() => {});
    bump();
    return r;
  }, [join, opts.e2eeKey, saver, bump]);

  // Connect once when the meeting screen mounts; disconnect when it unmounts.
  useEffect(() => {
    let cancelled = false;
    connectMedia(join.livekitToken, { cam: opts.startCamera, mic: opts.startMic }).catch((e) => {
      if (!cancelled) { setConn("disconnected"); toast(`Couldn't connect to the call: ${e?.message ?? e}`, "error"); }
    });
    return () => { cancelled = true; roomRef.current?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Signal ---------- */
  useEffect(() => {
    // The room ticket (signed by the server) proves who we are in this meeting.
    const s = io({ path: "/socket.io", auth: { ticket: join.ticket }, transports: ["websocket", "polling"] });
    socketRef.current = s;
    // Full room snapshot: people, hands, share requests, polls, lobby... (sent on every change).
    s.on("state", (st: SignalState) => setState(st));
    // The host made us a co-host (or back to guest).
    s.on("role", (d: { role: any }) => { setRole(d.role); toast(d.role === "cohost" ? "You're now a co-host" : "You're a guest again", "info"); });
    // Short messages from the server. When the host approves our raised hand, switch the mic on straight away.
    s.on("notice", (n: { kind: string; text: string }) => {
      toast(n.text, n.kind === "error" ? "error" : "info");
      if (n.kind === "mic" && /let you speak/.test(n.text)) roomRef.current?.localParticipant.setMicrophoneEnabled(true).then(bump).catch(() => {});
    });
    // A reaction floats on the sender's tile for 3 seconds, then disappears.
    s.on("reaction", (r: { identity: string; emoji: string }) => {
      const key = Date.now() + Math.random();
      setReactions((x) => [...x.slice(-20), { key, ...r }]);
      setTimeout(() => setReactions((x) => x.filter((i) => i.key !== key)), 3000);
    });
    // Chat message; count it as unread unless the chat panel is open.
    s.on("chat", (m: ChatMsg) => { setChat((x) => [...x.slice(-300), m]); if (!chatOpenRef.current) setUnread((n) => n + 1); });
    // Live caption; if "read aloud" is on, speak other people's lines in my language (voice translation).
    s.on("caption", (c: Caption) => {
      // Up to 500 lines are kept for the Transcript panel (the screen only shows the last two).
      setCaptions((x) => [...x.slice(-500), c]);
      const mine = c.translations[langRef.current] ?? c.text;
      if (listenRef.current && c.identity !== join.identity && c.lang !== langRef.current) voiceRef.current.say(mine);
    });
    // Plan time limit is close (15 and 5 minutes before the end on Free).
    s.on("time.warning", (w: { minutesLeft: number }) => setWarning(w));
    // The meeting is over (host ended it, time limit, or everyone left): drop media and show the end screen.
    s.on("meeting.ended", (d: { reason: string }) => { setEnded(d.reason); roomRef.current?.disconnect(); });
    // The host removed us.
    s.on("removed", () => { setEnded("removed"); roomRef.current?.disconnect(); });
    // Our ticket is no longer valid (e.g. the session already ended).
    s.on("fatal", () => setEnded("gone"));
    // The host approved our request to present. Browsers only open the screen picker from a click,
    // so we show a "Present now" button instead of starting the share automatically.
    s.on("share.allowed", () => { setShareApproved(true); toast("The host approved. Tap Present to start sharing.", "info"); });
    // The host stopped our share, or someone else started presenting (one presenter at a time).
    s.on("share.stop", (d: { reason: string }) => { roomRef.current?.localParticipant.setScreenShareEnabled(false).then(bump); toast(d.reason, "info"); });
    // Someone else started presenting.
    s.on("share.presenting", (d: { identity: string; name: string }) => { if (d.identity !== join.identity) toast(`${d.name} is presenting`, "info"); });
    // The host opened a poll.
    s.on("poll.opened", (p: { question: string }) => toast(`New poll: ${p.question}`, "info"));
    // Move to a breakout room (or back to the main room): reconnect media with the new token,
    // keeping camera/mic as they were. The socket stays the same (breakouts belong to one meeting).
    s.on("breakout.move", async (d: { livekitRoom: string; livekitToken: string; label: string }) => {
      const old = roomRef.current;
      const restore = { cam: Boolean(old?.localParticipant.isCameraEnabled), mic: Boolean(old?.localParticipant.isMicrophoneEnabled) };
      setConn("connecting");
      await old?.disconnect();
      await connectMedia(d.livekitToken, restore);
      setBreakout(d.livekitRoom.includes("~") ? d.label : null);
      toast(d.livekitRoom.includes("~") ? `You moved to ${d.label}` : "Back in the main room", "info");
    });
    return () => { s.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Captions (my mic → server) ----------
   * While my mic is live and captions are on, record it in short chunks and upload them for speech-to-text.
   * Off in E2EE meetings (the server must never hear the audio) and when the server has no speech-to-text. */
  const micPub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const micTrack = micPub && !micPub.isMuted ? micPub.track?.mediaStreamTrack : undefined;
  useEffect(() => {
    if (!micTrack || !captionsOn || join.e2ee || !opts.captionsAvailable) return;
    const rec = new CaptionRecorder(micTrack, join.ticket, (msg) => console.warn("captions:", msg));
    rec.start();
    return () => rec.stop();
  }, [micTrack, captionsOn, join.e2ee, join.ticket, opts.captionsAvailable]);

  /* ---------- Data saver: which camera videos to receive ----------
   * "off": receive every camera. "on": only the current speaker's camera (or the only other person's).
   * "audio": no cameras. Screen shares and audio are never cut, so slides always reach phones. */
  // Runs after every render (cheap): reacts to new tracks, speaker changes and the saver setting.
  useEffect(() => {
    if (!room) return;
    const active = room.activeSpeakers.find((p) => p.identity !== room.localParticipant.identity)?.identity;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.source !== Track.Source.Camera) continue; // screen share and audio are always received
        const want = saver === "off" || (saver === "on" && (p.identity === active || room.remoteParticipants.size <= 1));
        if (pub.isSubscribed !== want) pub.setSubscribed(want);
      }
    }
  });

  /* ---------- Actions ---------- */
  /** Send a socket event and wait for the server's reply ({ ok, error }); gives up after 8 s. */
  const emit = useCallback((ev: string, data: unknown = {}) => new Promise<{ ok: boolean; error?: string; allowed?: boolean }>((resolve) => {
    socketRef.current?.timeout(8000).emit(ev, data, (err: any, r: any) => resolve(err ? { ok: false, error: "No response" } : r));
  }), []);
  /** My LiveKit participant (always the current room, even after a breakout move). */
  const lp = () => roomRef.current!.localParticipant;

  // My own entry in the server's state: tells the UI whether I may speak or present.
  const me = state?.people.find((p) => p.identity === join.identity);
  /** How loud to play one person: my speaker volume × my level for them × the host's boost (capped at 400%). */
  const gainFor = (identity: string) =>
    Math.min(4, volume * (personVolume[identity] ?? 1) * (state?.people.find((p) => p.identity === identity)?.boost ?? 1));
  const actions = {
    emit,
    /** Mic button. Guests without permission raise (or lower) their hand instead of unmuting. */
    toggleMic: async () => {
      if (!roomRef.current) return;
      if (!me?.canSpeak && !lp().isMicrophoneEnabled) {
        const r = await emit(me?.hand ? "hand.lower" : "hand.raise");
        if (r.ok) toast(me?.hand ? "Hand lowered" : "Hand raised. The host will let you speak.", "info");
        return;
      }
      await lp().setMicrophoneEnabled(!lp().isMicrophoneEnabled).catch((e) => toast(e.message, "error"));
      bump();
    },
    /** Camera button: guests may always turn their camera on (smaller capture in data-saver modes). */
    toggleCam: async () => {
      if (!roomRef.current) return;
      await lp().setCameraEnabled(!lp().isCameraEnabled, { resolution: saver === "off" ? VideoPresets.h360.resolution : VideoPresets.h180.resolution, deviceId: loadPrefs().cam }).catch((e) => toast(e.message, "error"));
      bump();
    },
    /** Raise or lower my hand (the host sees a queue and can allow me to speak). */
    toggleHand: () => emit(me?.hand ? "hand.lower" : "hand.raise"),
    /** Present: share a screen, a window or a tab (with its sound). Video mode raises the frame rate. */
    startShare: async (video = false) => {
      if (!roomRef.current) return;
      // Guests without permission ask the host first; they present after approval (see "share.allowed").
      if (!me?.canShare) {
        const r = await emit("share.request");
        if (!r.allowed) { toast("Asked the host to let you present", "info"); return; }
      }
      try {
        // contentHint "detail" keeps text sharp (drops frames, not resolution); "motion" favours smooth video.
        await lp().setScreenShareEnabled(true,
          { audio: true, contentHint: video ? "motion" : "detail", resolution: { width: 1920, height: 1080, frameRate: video ? 15 : 5 }, selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include" } as any,
          { screenShareEncoding: { maxBitrate: video ? 1_500_000 : 900_000, maxFramerate: video ? 15 : 5 } });
        setShareApproved(false);
      } catch (e: any) {
        // NotAllowedError = the person closed the screen picker: not an error worth showing.
        if (e?.name !== "NotAllowedError") toast(`Couldn't share: ${e?.message ?? e}`, "error");
      }
      bump();
    },
    /** Stop presenting. The server is told via the LocalTrackUnpublished event above. */
    stopShare: async () => { await lp().setScreenShareEnabled(false); bump(); },
    /** Pause/resume the share without ending it (viewers keep the last frame and see "paused"). */
    pauseShare: async () => {
      const pub = lp().getTrackPublication(Track.Source.ScreenShare);
      if (!pub?.track) return;
      pub.isMuted ? await pub.unmute() : await pub.mute();
      bump();
    },
    /** Pick a different screen/window/tab: stop, then open the picker again. */
    switchShare: async (video = false) => {
      await lp().setScreenShareEnabled(false);
      await actions.startShare(video);
    },
    /** Send one of the 7 reactions. */
    react: (emoji: string) => emit("reaction", { emoji }),
    /** Send a chat message to everyone. */
    sendChat: (text: string) => emit("chat.send", { text }),
    /** Change my caption language; the server starts translating into it. */
    setLang: (l: string) => { setLangState(l); langRef.current = l; voiceRef.current.setLang(l); emit("lang.set", { lang: l }); },
    /** Turn "read translations aloud" on/off. */
    setListen: (on: boolean) => { setListen(on); listenRef.current = on; if (!on) voiceRef.current.stop(); },
    /** Show/hide captions (also stops sending my audio for captions). */
    setCaptionsOn,
    /** Change data-saver mode; audio-only also turns my own camera off. */
    setSaver: (s: DataSaver) => {
      setSaver(s);
      if (s === "audio" && roomRef.current?.localParticipant.isCameraEnabled) lp().setCameraEnabled(false).then(bump);
    },
    /** My speaker volume for everyone (0 to MAX_VOLUME); remembered on this device. */
    setVolume: (v: number) => { setVolumeState(v); saveVolume(v); },
    /** My own volume for one person (only I hear the change). */
    setPersonVolume: (identity: string, v: number) => setPersonVolumeState((x) => ({ ...x, [identity]: v })),
    /** Hosts: make one person louder for everyone (1 = normal, up to 3). */
    boostVolume: (identity: string, level: number) => emit("volume.boost", { identity, level }),
    /** Called by the chat panel so unread counts reset while it's open. */
    setChatOpen: (open: boolean) => { chatOpenRef.current = open; if (open) setUnread(0); },
    /** Leave the call (others stay). */
    leave: async () => { await roomRef.current?.disconnect(); socketRef.current?.disconnect(); setEnded("left"); },
  };

  return {
    room, state, role, conn, ended, captions, chat, unread, reactions, warning, setWarning, breakout, shareApproved,
    lang, captionsOn, listen, saver, volume, personVolume, gainFor, me, actions, isPhone: isPhone(),
  };
}

/** Everything useCall returns; passed to the panels. */
export type Call = ReturnType<typeof useCall>;
