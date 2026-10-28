/** Join page + entry to the call. */
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { io, type Socket } from "socket.io-client";
import { Logo } from "../components/Layout";
import { Icon } from "../components/Icon";
import { Button, Field, Input, Select, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { loadPrefs } from "../lib/devices";
import { keyFromHash, loadKey, saveKey } from "../lib/e2ee";
import { fmtWhen, LANGS, relative } from "../lib/format";
import RoomView from "../room/Room";
import type { DataSaver, JoinPayload } from "../room/useCall";

/** Public meeting info for the join screen (no private data): title, host, live status, rules, languages. */
interface Info {
  slug: string; title: string; host: string; kind: string; startAt: string; live: boolean; people: number; needsPasscode: boolean;
  waitingRoom: boolean; verifyGuests: boolean; e2ee: boolean; languages: string[]; captions: boolean;
  dialIn: { number: string; pin: string } | null; invitee: { name: string | null; email: string | null; phone: string | null; language: string | null } | null;
}

// Guests' name/contact/language are remembered in this browser so the next join is one tap.
const GUEST_KEY = "gather.guest";
const loadGuest = () => { try { return JSON.parse(localStorage.getItem(GUEST_KEY) ?? "{}"); } catch { return {}; } };

/**
 * The join screen ("/j/:slug"), then the call itself.
 *  - Guests: name, WhatsApp number or email, caption language, consent (+ passcode / email code if the host asked).
 *  - Signed-in hosts and their team join with their account (host or co-host).
 *  - Waiting room: the guest waits on a socket until the host admits them.
 *  - Encrypted meetings need the secret key from the link's #k= part.
 */
export default function Join() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  // Personal invite token (?i=...) prefills the guest's details and marks them as attending.
  const invite = params.get("i") ?? undefined;
  const { me, loading: authLoading } = useAuth();
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const saved = loadGuest();
  const [name, setName] = useState<string>(saved.name ?? "");
  const [phone, setPhone] = useState<string>(saved.phone ?? "");
  const [email, setEmail] = useState<string>(saved.email ?? "");
  const [lang, setLang] = useState<string>(saved.lang ?? "en");
  const [consent, setConsent] = useState(true);
  const [passcode, setPasscode] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [asGuest, setAsGuest] = useState(false);
  const [cam, setCam] = useState(false);
  // Data use: the default from Settings → Voice & video, else data saver on phones.
  const [saver, setSaver] = useState<DataSaver>(loadPrefs().saver ?? (window.matchMedia?.("(pointer: coarse)").matches ? "on" : "off"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [joined, setJoined] = useState<(JoinPayload & { meetingId?: string }) | null>(null);
  const [e2eeKey, setE2eeKey] = useState<string | null>(keyFromHash() ?? loadKey(slug));
  const [keyInput, setKeyInput] = useState("");
  const waitSock = useRef<Socket | null>(null);

  // Load the meeting and prefill from the personal invite, if any.
  useEffect(() => {
    api<Info>(`/public/meetings/${slug}${invite ? `?i=${invite}` : ""}`, { token: null }).then((i) => {
      setInfo(i);
      if (i.invitee) {
        if (i.invitee.name) setName(i.invitee.name);
        if (i.invitee.phone) setPhone(i.invitee.phone);
        if (i.invitee.email) setEmail(i.invitee.email);
        if (i.invitee.language) setLang(i.invitee.language);
      }
      if (!saved.lang && i.languages[0]) setLang(i.languages[0]);
    }).catch((e) => setFatal((e as ApiError).message));
    return () => { waitSock.current?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  // Opening a secure link saves its key so a refresh still works.
  useEffect(() => { const k = keyFromHash(); if (k) saveKey(slug, k); }, [slug]);

  if (fatal) return <Shell><div className="text-center"><p className="text-4xl">🔗</p><p className="mt-3 text-lg font-bold">{fatal}</p><Link to="/" className="mt-4 inline-block font-semibold text-brand-700">Go to Gather</Link></div></Shell>;
  if (!info || authLoading) return <Shell><div className="py-10 text-center text-brand-700"><Spinner /></div></Shell>;
  if (joined) return <RoomView join={joined} title={info.title} e2eeKey={e2eeKey} lang={lang} startCamera={cam} saver={saver} meetingId={joined.meetingId} captionsAvailable={info.captions} autoPresent={params.get("present") === "1"} />;

  // Signed-in users join as host/co-host unless they choose guest (or the meeting is another workspace's).
  const hostMode = Boolean(me) && !asGuest;
  /** The server answers "joined" (tokens for the call) or "waiting" (a wait token for the waiting room socket). */
  const handleJoin = (r: any) => {
    if (r.status === "waiting") {
      setWaiting(true);
      const s = io({ path: "/socket.io", auth: { wait: r.wait } });
      waitSock.current = s;
      s.on("lobby.admitted", (j: JoinPayload) => { s.disconnect(); setWaiting(false); setJoined(j); });
      s.on("lobby.denied", (d: { reason?: string }) => { s.disconnect(); setWaiting(false); setError({ text: d.reason === "host" ? "The host didn't let you in." : d.reason === "ended" ? "The meeting ended." : d.reason || "You couldn't join." }); });
      return;
    }
    setJoined(r);
  };

  /** Submit the join form (host or guest path). */
  const join = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      if (hostMode) {
        handleJoin(await api(`/meetings/by-slug/${slug}/join`, { body: { language: lang } }));
      } else {
        try { localStorage.setItem(GUEST_KEY, JSON.stringify({ name, phone, email, lang })); } catch { /* ignore */ }
        handleJoin(await api(`/public/meetings/${slug}/join`, { token: null, body: { name, phone, email, language: lang, consent, passcode: passcode || undefined, invite, code: code || undefined } }));
      }
    } catch (err) {
      const ex = err as ApiError;
      if (hostMode && ex.status === 403) { setAsGuest(true); setError({ text: "This meeting is from another workspace. Join as a guest." }); }
      else setError({ text: ex.message, field: ex.data?.field });
    } finally { setBusy(false); }
  };

  /** Email check: send a 6-digit code to the guest's email (only when the host turned this on). */
  const sendCode = async () => {
    setError(null);
    try { await api(`/public/meetings/${slug}/verify`, { token: null, body: { email } }); setCodeSent(true); }
    catch (e) { setError({ text: (e as ApiError).message, field: "email" }); }
  };

  // Waiting room screen
  if (waiting) {
    return <Shell><div className="space-y-4 py-6 text-center"><Spinner size={32} className="mx-auto text-brand-700" /><p className="text-lg font-bold">Waiting for the host to let you in</p><p className="text-sm text-stone-500">{info.title} · hosted by {info.host}</p><p className="text-xs text-stone-400">Keep this page open.</p></div></Shell>;
  }

  // Encrypted meeting opened without the key: ask for the secure link
  if (info.e2ee && !e2eeKey) {
    return (
      <Shell>
        <div className="space-y-4">
          <p className="flex items-center gap-2 font-bold"><Icon name="shield" />This meeting is end-to-end encrypted</p>
          <p className="text-sm text-stone-600">Open the full secure link the host shared (it ends with <span className="font-mono">#k=…</span>), or paste it here.</p>
          <Input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="Paste the secure link" />
          <Button className="w-full" onClick={() => { const m = keyInput.match(/k=([\w-]+)/); if (m) { saveKey(slug, m[1]); setE2eeKey(m[1]); } else setError({ text: "That link has no key." }); }}>Continue</Button>
          {error && <p className="text-sm text-red-600">{error.text}</p>}
        </div>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <div className="grid gap-6 md:grid-cols-[1.1fr_1fr]">
        <div className="order-2 md:order-1">
          <Preview on={cam} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => setCam(!cam)} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${cam ? "bg-brand-700 text-white" : "border border-stone-300 bg-white"}`}><Icon name={cam ? "cam" : "camOff"} size={18} />Camera {cam ? "on" : "off"}</button>
            <span className="flex items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600"><Icon name={hostMode ? "mic" : "lockMic"} size={18} />{hostMode ? "Mic on" : "Mic: raise your hand to speak"}</span>
          </div>
          <div className="mt-3 rounded-xl border border-stone-200 bg-white p-3">
            <p className="mb-2 text-sm font-semibold">Data use</p>
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              {([["off", "Normal"], ["on", "Data saver"], ["audio", "Audio only"]] as const).map(([id, label]) => (
                <button key={id} onClick={() => setSaver(id)} className={`rounded-lg border px-2 py-2 font-semibold ${saver === id ? "border-brand-600 bg-brand-50 text-brand-800" : "border-stone-200"}`}>{label}</button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-stone-500">{saver === "off" ? "Best quality your network allows." : saver === "on" ? "About 50 MB an hour: only the speaker's video." : "About 20 MB an hour: voices and slides only."}</p>
          </div>
        </div>

        <form onSubmit={join} className="order-1 space-y-4 md:order-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">{info.live ? `● Live now · ${info.people} in the call` : info.kind === "scheduled" ? `${fmtWhen(info.startAt)} · ${relative(info.startAt)}` : "Meeting room"}</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{info.title}</h1>
            <p className="text-sm text-stone-500">Hosted by {info.host}{info.e2ee ? " · end-to-end encrypted" : ""}</p>
          </div>
          {hostMode ? (
            <div className="rounded-xl bg-brand-50 p-3 text-sm">Joining as <b>{me!.user.name}</b> ({me!.user.email}). <button type="button" className="font-semibold text-brand-700" onClick={() => setAsGuest(true)}>Join as a guest instead</button></div>
          ) : (
            <>
              <Field label="Your name" error={error?.field === "name" ? error.text : null}><Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Tolu Adeyemi" maxLength={60} autoComplete="name" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="WhatsApp number"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803 000 0000" autoComplete="tel" /></Field>
                <Field label="or Email" error={error?.field === "email" ? error.text : null}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@mail.com" autoComplete="email" /></Field>
              </div>
              <p className="-mt-2 text-xs text-stone-500">At least one, so we can send you the meeting summary.</p>
            </>
          )}
          <Field label="Captions language"><Select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          {!hostMode && info.needsPasscode && <Field label="Passcode" error={error?.field === "passcode" ? error.text : null}><Input required value={passcode} onChange={(e) => setPasscode(e.target.value)} /></Field>}
          {!hostMode && info.verifyGuests && (
            <Field label="Email check" hint="The host asks guests to confirm their email." error={error?.field === "code" ? error.text : null}>
              <div className="flex gap-2"><Input inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} /><Button type="button" variant="secondary" onClick={sendCode} disabled={!email}>{codeSent ? "Resend" : "Send code"}</Button></div>
            </Field>
          )}
          {!hostMode && (
            <label className="flex items-start gap-2 text-sm text-stone-600">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-600" />
              <span>Send me the meeting summary. <span className="text-stone-400">We use your contact only for this meeting's summary and reminders.</span></span>
            </label>
          )}
          {error && !["name", "email", "passcode", "code"].includes(error.field ?? "") && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error.text}</p>}
          <Button className="w-full py-3 text-base" loading={busy} icon="arrow">{info.waitingRoom && !hostMode ? "Ask to join" : "Join meeting"}</Button>
          {info.dialIn && <p className="text-center text-xs text-stone-500">No data? Call {info.dialIn.number} and enter PIN {info.dialIn.pin}</p>}
        </form>
      </div>
    </Shell>
  );
}

/** Page frame for the join flow: logo + white card. */
function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-full bg-stone-100 px-4 py-6">
      <div className="mx-auto mb-6 flex max-w-4xl items-center justify-between"><Link to="/"><Logo /></Link></div>
      <div className={`mx-auto rounded-3xl bg-white p-5 shadow-sm md:p-8 ${wide ? "max-w-4xl" : "max-w-md"}`}>{children}</div>
    </div>
  );
}

/** Camera preview before joining (camera is off by default). */
function Preview({ on }: { on: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let track: LocalVideoTrack | null = null;
    let cancelled = false;
    createLocalVideoTrack({ resolution: { width: 640, height: 360 }, deviceId: loadPrefs().cam }).then((t) => {
      if (cancelled) { t.stop(); return; }
      track = t; if (ref.current) t.attach(ref.current); setErr(null);
    }).catch((e) => setErr(e?.name === "NotAllowedError" ? "Camera blocked. Allow it in your browser settings." : "No camera found."));
    return () => { cancelled = true; track?.stop(); };
  }, [on]);
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-ink-800 text-white/70">
      {on && !err ? <video ref={ref} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" /> : <div className="text-center text-sm"><Icon name="camOff" size={32} className="mx-auto mb-2" />{err ?? "Your camera is off"}</div>}
    </div>
  );
}
