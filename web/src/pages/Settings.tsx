/**
 * Account and workspace settings ("/settings").
 * One white panel: a list of sections on the left (a dropdown on phones) and the chosen section on the right.
 * Sections: Profile, Workspace (admins), Voice & video, Calendar, Connections. The section is kept in ?tab=.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { PageTitle } from "../components/Layout";
import { openTour } from "../components/Onboarding";
import { PhoneInput } from "../components/PhoneInput";
import { SignOutButton } from "../components/SignOut";
import { Badge, Button, copy, Field, Input, Select, Toggle, reloadWithToast, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { canPickSpeaker, loadPrefs, savePrefs, type DevicePrefs } from "../lib/devices";
import { LANGS } from "../lib/format";
import { MAX_VOLUME, savedVolume, saveVolume, type DataSaver } from "../room/useCall";

type Tab = "profile" | "workspace" | "voice" | "calendar" | "connections";

export default function Settings() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  // After the Google/Microsoft consent screen the server redirects here with ?calendar=connected|error.
  useEffect(() => {
    if (params.get("calendar") === "connected") toast("Calendar connected. New meetings will appear in it.");
    if (params.get("calendar") === "error") toast(`Calendar: ${params.get("msg")}`, "error");
  }, []);
  if (!me) return null;
  const isAdmin = me.user.role !== "member";
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "profile", label: "Profile", icon: "users" },
    ...(isAdmin ? [{ id: "workspace" as const, label: "Workspace", icon: "team" }] : []),
    { id: "voice", label: "Voice & video", icon: "mic" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { id: "connections", label: "Connections", icon: "link" },
  ];
  const asked = (params.get("tab") ?? (params.get("calendar") ? "calendar" : "profile")) as Tab;
  const tab = tabs.some((t) => t.id === asked) ? asked : "profile";
  const go = (t: Tab) => setParams({ tab: t }, { replace: true });

  return (
    <div>
      <PageTitle title="Settings" sub="Your profile, workspace, devices and connected calendars." />
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm md:grid md:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Sections: a list on laptops, a dropdown on phones */}
        <nav className="hidden border-r border-stone-200 py-3 md:block" aria-label="Settings sections">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => go(t.id)} aria-current={tab === t.id ? "page" : undefined}
              className={`flex w-full items-center gap-3 border-r-2 px-5 py-2.5 text-left text-sm font-medium transition ${tab === t.id ? "border-brand-600 bg-brand-50 text-brand-800" : "border-transparent text-stone-600 hover:bg-stone-50"}`}>
              <Icon name={t.icon} size={16} />{t.label}
            </button>
          ))}
          <button onClick={openTour} className="mt-3 flex w-full items-center gap-3 border-t border-stone-100 px-5 pb-2.5 pt-4 text-left text-sm font-medium text-stone-600 hover:bg-stone-50"><Icon name="sparkle" size={16} />Take the tour</button>
          <SignOutButton className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50"><Icon name="logout" size={16} />Log out</SignOutButton>
        </nav>
        <div className="border-b border-stone-200 p-4 md:hidden">
          <Select value={tab} onChange={(e) => go(e.target.value as Tab)} aria-label="Settings section">{tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
        </div>
        <section className="min-w-0 p-5 md:p-8">
          {tab === "profile" && <ProfileSection />}
          {tab === "workspace" && isAdmin && <WorkspaceSection />}
          {tab === "voice" && <VoiceVideoSection />}
          {tab === "calendar" && <CalendarSection />}
          {tab === "connections" && <ConnectionsSection />}
        </section>
      </div>
      {/* Phones have no sidebar, so Log out lives here */}
      <div className="mt-4 grid grid-cols-2 gap-2 md:hidden">
        <button onClick={openTour} className="flex items-center justify-center gap-2 rounded-2xl border border-stone-200 bg-white py-3.5 text-sm font-semibold text-stone-700 shadow-sm hover:bg-stone-50"><Icon name="sparkle" size={16} />Take the tour</button>
        <SignOutButton className="flex items-center justify-center gap-2 rounded-2xl border border-stone-200 bg-white py-3.5 text-sm font-semibold text-red-600 shadow-sm hover:bg-red-50"><Icon name="logout" size={16} />Log out</SignOutButton>
      </div>
    </div>
  );
}

/** Section heading with a one-line explanation and a divider under it. */
function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6 border-b border-stone-100 pb-4">
      <h2 className="text-lg font-bold text-stone-900">{title}</h2>
      {sub && <p className="mt-0.5 text-sm text-stone-500">{sub}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Profile */
/**
 * Save a form: send it, then reload the page so it shows what the server stored, with a "saved" toast.
 * On an error the page stays as typed and a red toast says what went wrong.
 */
async function save(setBusy: (b: boolean) => void, send: () => Promise<unknown>, done: string) {
  setBusy(true);
  try { await send(); reloadWithToast(done); }
  catch (e) { toast((e as ApiError).message || "Couldn't save. Check your connection and try again.", "error"); setBusy(false); }
}

/** Saved details as a read-only list (label on the left, value on the right). */
function Summary({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="max-w-xl divide-y divide-stone-100 rounded-2xl border border-stone-200">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-4 py-3.5">
          <dt className="text-sm text-stone-500">{k}</dt>
          <dd className={`text-sm font-medium ${v ? "text-stone-900" : "text-stone-400"}`}>{v || "Not set"}</dd>
        </div>
      ))}
    </dl>
  );
}
/** Edit button under a summary; Save and Cancel under a form. */
const editBtn = "mt-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-stone-800 hover:bg-stone-50";

/**
 * Profile: shows the saved name, WhatsApp number and language; "Edit" opens the form.
 * Save stores it, then the page reloads back to the summary with a "Profile saved" toast.
 */
function ProfileSection() {
  const { me } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me?.user.name ?? "");
  const [phone, setPhone] = useState(me?.user.phone ?? "");
  const [language, setLanguage] = useState(me?.user.language ?? "en");
  const [busy, setBusy] = useState(false);
  /** Leave the form without saving: put the saved values back. */
  const cancel = () => { setName(me?.user.name ?? ""); setPhone(me?.user.phone ?? ""); setLanguage(me?.user.language ?? "en"); setEditing(false); };
  return (
    <>
      <Heading title="Profile" sub="How you appear in meetings, and where your reminders and summaries go." />
      {!editing ? (
        <>
          <Summary rows={[["Name", me?.user.name ?? ""], ["Email", me?.user.email ?? ""], ["WhatsApp number", me?.user.phone ?? ""], ["Language", LANGS.find((l) => l.id === me?.user.language)?.name ?? ""]]} />
          <button type="button" onClick={() => setEditing(true)} className={editBtn}><Icon name="edit" size={16} />Edit profile</button>
        </>
      ) : (
        <form className="grid max-w-xl gap-4" onSubmit={(e) => { e.preventDefault(); save(setBusy, () => api("/me", { method: "PATCH", body: { name, phone: phone || null, language } }), "Profile saved"); }}>
          <Field label="Name"><Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="WhatsApp number" hint="With your country code. Reminders and meeting summaries come here."><PhoneInput value={phone} onChange={setPhone} /></Field>
          <Field label="Language" hint="Your captions and summaries are in this language."><Select value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <div className="flex gap-2"><Button loading={busy}>{busy ? "Saving…" : "Save"}</Button><Button type="button" variant="secondary" disabled={busy} onClick={cancel}>Cancel</Button></div>
        </form>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Workspace (admins) */
const REGIONS: Record<string, string> = { "af-south-1": "South Africa (af-south-1)", lagos: "Lagos", nairobi: "Nairobi", accra: "Accra" };

/** Workspace (admins): shows the saved name and data region; "Edit" opens the form, Save reloads to the summary. */
function WorkspaceSection() {
  const { me } = useAuth();
  const [editing, setEditing] = useState(false);
  const [orgName, setOrgName] = useState(me?.org.name ?? "");
  const [region, setRegion] = useState(me?.org.dataRegion ?? "af-south-1");
  const [busy, setBusy] = useState(false);
  const cancel = () => { setOrgName(me?.org.name ?? ""); setRegion(me?.org.dataRegion ?? "af-south-1"); setEditing(false); };
  return (
    <>
      <Heading title="Workspace" sub="Settings for everyone in your team." />
      {!editing ? (
        <>
          <Summary rows={[["Name", me?.org.name ?? ""], ["Data home region", REGIONS[me?.org.dataRegion ?? ""] ?? me?.org.dataRegion ?? ""], ["Plan", `${me?.plan.name ?? ""}`]]} />
          <button type="button" onClick={() => setEditing(true)} className={editBtn}><Icon name="edit" size={16} />Edit workspace</button>
        </>
      ) : (
        <form className="grid max-w-xl gap-4" onSubmit={(e) => { e.preventDefault(); save(setBusy, () => api("/org", { method: "PATCH", body: { name: orgName, dataRegion: region } }), "Workspace saved"); }}>
          <Field label="Name"><Input required autoFocus value={orgName} onChange={(e) => setOrgName(e.target.value)} /></Field>
          <Field label="Data home region" hint="Where your meeting data is stored (NDPA, Kenya DPA)."><Select value={region} onChange={(e) => setRegion(e.target.value)}>{Object.entries(REGIONS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field>
          <div className="flex gap-2"><Button loading={busy}>{busy ? "Saving…" : "Save"}</Button><Button type="button" variant="secondary" disabled={busy} onClick={cancel}>Cancel</Button></div>
        </form>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Voice & video */
/**
 * Microphone, speaker and camera for calls on this device, with a live mic level, a 0–300% speaker volume,
 * a record-and-play-back mic test, voice clean-up and the default data use. Saved in this browser.
 */
function VoiceVideoSection() {
  const [prefs, setPrefs] = useState<DevicePrefs>(loadPrefs);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [volume, setVolume] = useState(savedVolume);
  const [level, setLevel] = useState(0);
  const [test, setTest] = useState<"idle" | "recording" | "playing">("idle");
  const [camOn, setCamOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const update = (p: Partial<DevicePrefs>) => setPrefs(savePrefs(p));

  // List devices. Browsers hide their names until the site may use the mic or camera.
  const list = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
  useEffect(() => {
    list();
    navigator.mediaDevices?.addEventListener("devicechange", list);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", list);
  }, []);
  const mics = devices.filter((d) => d.kind === "audioinput");
  const speakers = devices.filter((d) => d.kind === "audiooutput");
  const cams = devices.filter((d) => d.kind === "videoinput");
  const named = devices.some((d) => d.label);
  const allow = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); s.getTracks().forEach((t) => t.stop()); list(); }
    catch { toast("Your browser blocked the mic or camera. Allow them in the browser's site settings.", "error"); }
  };

  // Live mic level from the chosen microphone (only while this section is open).
  useEffect(() => {
    if (!named) return;
    let stream: MediaStream | null = null, ctx: AudioContext | null = null, raf = 0, stopped = false;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.mic ? { exact: prefs.mic } : undefined, noiseSuppression: prefs.cleanVoice, autoGainControl: prefs.cleanVoice } }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; ctx = new AudioContext();
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => {});
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); ctx?.close(); };
  }, [named, prefs.mic, prefs.cleanVoice]);

  // Camera preview from the chosen camera.
  useEffect(() => {
    if (!camOn) return;
    let stream: MediaStream | null = null, stopped = false;
    navigator.mediaDevices.getUserMedia({ video: { deviceId: prefs.cam ? { exact: prefs.cam } : undefined, width: 640, height: 360 } }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; if (videoRef.current) videoRef.current.srcObject = s;
    }).catch(() => { toast("Couldn't start that camera.", "error"); setCamOn(false); });
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camOn, prefs.cam]);

  /** Mic test: record 4 seconds, then play it back on the chosen speaker at the chosen volume. */
  const micTest = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.mic ? { exact: prefs.mic } : undefined, noiseSuppression: prefs.cleanVoice, autoGainControl: prefs.cleanVoice } });
      const rec = new MediaRecorder(s); const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        s.getTracks().forEach((t) => t.stop());
        setTest("playing");
        const ctx = new AudioContext();
        if (prefs.speaker && "setSinkId" in ctx) await (ctx as any).setSinkId(prefs.speaker).catch(() => {});
        const audio = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
        const src = ctx.createBufferSource(); src.buffer = audio;
        const gain = ctx.createGain(); gain.gain.value = volume;
        src.connect(gain).connect(ctx.destination);
        src.onended = () => { setTest("idle"); ctx.close(); };
        src.start();
      };
      setTest("recording"); rec.start();
      setTimeout(() => rec.state === "recording" && rec.stop(), 4000);
    } catch { setTest("idle"); toast("Couldn't use the microphone. Check that it's allowed and plugged in.", "error"); }
  };

  const deviceSelect = (label: string, items: MediaDeviceInfo[], value: string | undefined, key: "mic" | "speaker" | "cam") => (
    <Field label={label}>
      <Select value={value ?? ""} onChange={(e) => update({ [key]: e.target.value || undefined })}>
        <option value="">Default</option>
        {items.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
      </Select>
    </Field>
  );
  const savers: { id: DataSaver | ""; label: string }[] = [{ id: "", label: "Automatic" }, { id: "off", label: "Normal" }, { id: "on", label: "Data saver" }, { id: "audio", label: "Audio only" }];

  return (
    <>
      <Heading title="Voice & video" sub="Saved on this device. Used the next time you join a call." />
      {!named && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-sky-50 p-3 text-sm text-sky-900">
          <Icon name="mic" size={18} /><span className="flex-1">Allow the microphone and camera to see your devices by name.</span>
          <Button type="button" variant="secondary" onClick={allow}>Allow</Button>
        </div>
      )}
      <div className="max-w-xl space-y-6">
        <h3 className="font-semibold text-stone-900">Voice settings</h3>
        {deviceSelect("Microphone", mics, prefs.mic, "mic")}
        <div>
          <p className="mb-1.5 text-sm font-medium text-stone-700">Mic level</p>
          <div className="h-2 overflow-hidden rounded-full bg-stone-100" aria-label="Microphone level" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-brand-500 transition-[width] duration-75" style={{ width: `${named ? level * 100 : 0}%` }} />
          </div>
          <p className="mt-1 text-xs text-stone-500">{named ? "Speak: the bar should move. If it doesn't, pick another microphone." : "Shows once the microphone is allowed."}</p>
        </div>
        {canPickSpeaker()
          ? deviceSelect("Speaker", speakers, prefs.speaker, "speaker")
          : <p className="text-sm text-stone-500">Speaker: this browser plays sound on your device's default speaker.</p>}
        <div>
          <div className="mb-1.5 flex items-center justify-between"><span className="text-sm font-medium text-stone-700">Speaker volume</span>
            <button type="button" onClick={() => { setVolume(1); saveVolume(1); }} title="Back to 100%" className={`rounded px-1.5 text-sm font-semibold ${volume > 1 ? "text-amber-600" : "text-stone-700"} hover:bg-stone-100`}>{Math.round(volume * 100)}%</button></div>
          <input type="range" min={0} max={MAX_VOLUME * 100} step={10} value={Math.round(volume * 100)} aria-label="Speaker volume"
            onChange={(e) => { const v = Number(e.target.value) / 100; setVolume(v); saveVolume(v); }} className="w-full accent-emerald-600" />
          <p className="mt-1 text-xs text-stone-500">Up to 300% for quiet voices and weak speakers. You can also change it during a call.</p>
        </div>
        <div>
          <p className="text-sm font-medium text-stone-700">Mic test</p>
          <p className="mb-2 text-xs text-stone-500">Records 4 seconds and plays it back. If you hear nothing, change your microphone or speaker.</p>
          <Button type="button" icon={test === "idle" ? "mic" : undefined} loading={test !== "idle"} onClick={micTest}>
            {test === "recording" ? "Recording… speak now" : test === "playing" ? "Playing back…" : "Record voice"}
          </Button>
        </div>
        <div className="rounded-xl border border-stone-200 px-3">
          <Toggle checked={prefs.cleanVoice} onChange={(v) => update({ cleanVoice: v })} label="Clean up my voice automatically" hint="Cuts background noise and evens out your mic level. Turn off for music." />
        </div>

        <h3 className="border-t border-stone-100 pt-6 font-semibold text-stone-900">Video settings</h3>
        {deviceSelect("Camera", cams, prefs.cam, "cam")}
        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-ink-800 text-white/70">
          {camOn ? <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
            : <div className="text-center text-sm"><Icon name="camOff" size={28} className="mx-auto mb-2" />Camera preview is off</div>}
          <button type="button" onClick={() => setCamOn(!camOn)} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-stone-800 shadow">{camOn ? "Stop preview" : "Preview camera"}</button>
        </div>
        <Field label="Data use when joining" hint="Automatic uses data saver on phones and normal quality on laptops. You can still change it on the join screen.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {savers.map((s) => (
              <button key={s.id} type="button" onClick={() => update({ saver: s.id || undefined })}
                className={`rounded-lg border px-2 py-2 text-sm font-semibold ${(prefs.saver ?? "") === s.id ? "border-brand-600 bg-brand-50 text-brand-800" : "border-stone-200 text-stone-700"}`}>{s.label}</button>
            ))}
          </div>
        </Field>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Calendar */
function CalendarSection() {
  const { me, refresh } = useAuth();
  if (!me) return null;
  /** Ask the server for the provider's consent URL, then go there. */
  const connect = async (p: "google") => {
    try { const r = await api(`/calendar/${p}/connect`); window.location.href = r.url; } catch (e) { toast((e as ApiError).message, "error"); }
  };
  return (
    <>
      <Heading title="Calendar" sub="Invites already include a calendar file. You can also put all your Gather meetings in your own calendar." />
      <div className="max-w-xl space-y-5">
        <div className="rounded-xl bg-stone-50 p-3">
          <p className="text-sm font-medium">Subscribe link (works with Google, Outlook and Apple)</p>
          <div className="mt-2 flex gap-2"><Input readOnly value={me.calendar.feedUrl} className="font-mono text-xs" /><Button variant="secondary" icon="copy" onClick={() => copy(me.calendar.feedUrl)}>Copy</Button></div>
          <p className="mt-1 text-xs text-stone-500">Google Calendar → Other calendars → From URL. Keep this link private.</p>
        </div>
        {(["google"] as const).map((p) => (
          <div key={p} className="flex items-center justify-between gap-3 border-t border-stone-100 pt-4">
            <span className="flex items-center gap-2 font-medium"><Icon name="calendar" size={18} />Google Calendar</span>
            {me.calendar[p].connected ? <span className="flex items-center gap-2"><Badge tone="green">Connected</Badge><button className="text-sm text-stone-500 hover:text-red-600" onClick={async () => { await api(`/calendar/${p}`, { method: "DELETE" }); refresh(); }}>Disconnect</button></span>
              : me.calendar[p].available ? <Button variant="secondary" onClick={() => connect(p)}>Connect</Button> : <span className="text-xs text-stone-400">Not set up on this server</span>}
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Connections */
function ConnectionsSection() {
  const { me } = useAuth();
  if (!me) return null;
  const rows: { label: string; hint: string; on: boolean; off: string }[] = [
    { label: "WhatsApp sending", hint: "Invites, reminders and summaries go out on WhatsApp automatically.", on: me.integrations.whatsapp, off: "Share links only" },
    { label: "SMS", hint: "Invites by SMS for people without WhatsApp.", on: me.integrations.sms, off: "Off" },
    { label: "Phone dial-in", hint: "People without data can join by phone call.", on: me.integrations.dialIn, off: "Off" },
  ];
  return (
    <>
      <Heading title="Connections on this server" sub="Optional services. They switch on when the server has their keys." />
      <ul className="max-w-xl divide-y divide-stone-100">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-4 py-3">
            <span><span className="block text-sm font-medium text-stone-800">{r.label}</span><span className="block text-xs text-stone-500">{r.hint}</span></span>
            {r.on ? <Badge tone="green">On</Badge> : <Badge>{r.off}</Badge>}
          </li>
        ))}
      </ul>
    </>
  );
}
