/**
 * Panels.tsx: the side panels of the meeting screen (opened from the control bar).
 *  - PeoplePanel: everyone in the call; for hosts also the waiting room, raised hands, share requests
 *    and per-person controls (let speak, lock mic, stop share, co-host, remove, volume / boost for everyone).
 *  - ChatPanel, PollsPanel, BreakoutPanel (hosts) and SettingsPanel (speaker volume, data saver, caption language, read aloud).
 * Every action is a socket event; the server checks permissions and broadcasts the new state.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { confirmToast, toast } from "../components/ui";
import { fmtTime, LANGS, langName } from "../lib/format";
import { Avatar } from "./media";
import { MAX_VOLUME, type Call, type DataSaver } from "./useCall";

/** Hosts and co-hosts share the same controls. */
const isHostRole = (r: string) => r === "host" || r === "cohost";
// Shared Tailwind classes: small buttons and dark inputs.
const btn = "rounded-lg px-2.5 py-1.5 text-xs font-semibold transition";
const dark = "rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-brand-400";
/** The chat's emoji picker. */
const EMOJI = ["🤔", "🙂", "😡", "😁", "🙁", "😊", "😢", "😍", "🌟", "🔥", "👏", "👍"];
/** Volume as a percentage label ("150%"). */
const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Levels a host can boost one person to, for everyone. */
const BOOSTS = [1, 1.5, 2, 2.5, 3];

/** A 0–300% volume slider with its value; tapping the value puts it back to 100%. */
export function VolumeSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs"><span className="text-white/70">{label}</span>
        <button onClick={() => onChange(1)} title="Back to 100%" className={`rounded px-1.5 font-semibold ${value > 1 ? "text-amber-300" : "text-white/80"} hover:bg-white/10`}>{pct(value)}</button></div>
      <input type="range" min={0} max={MAX_VOLUME * 100} step={10} value={Math.round(value * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={label} className="w-full accent-emerald-500" />
    </div>
  );
}

/* ------------------------------------------------------------------ People + host controls */
/** People in the call, plus the host's queues (waiting room, hands, share requests) and room-wide switches. */
export function PeoplePanel({ call }: { call: Call }) {
  const s = call.state;
  if (!s) return null;
  const host = isHostRole(call.role);
  const byId = new Map(s.people.map((p) => [p.identity, p]));
  // Is this person's mic live right now? (from LiveKit, the real media state)
  const lkMic = (id: string) => {
    const r = call.room;
    if (!r) return false;
    if (id === r.localParticipant.identity) return r.localParticipant.isMicrophoneEnabled;
    return r.remoteParticipants.get(id)?.isMicrophoneEnabled ?? false;
  };
  // Send a host action; optionally confirm it with a toast.
  const act = async (ev: string, data: object, done?: string) => { const r = await call.actions.emit(ev, data); if (r.ok && done) toast(done, "info"); };
  return (
    <div className="space-y-5">
      {/* Waiting room (hosts): admit one, admit all, or deny */}
      {host && s.lobby.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-wide text-amber-300">Waiting room ({s.lobby.length})</h3>
            <button className={`${btn} bg-brand-600 text-white`} onClick={() => act("lobby.admit", { all: true })}>Admit all</button></div>
          {s.lobby.map((l) => (
            <div key={l.waitId} className="mb-1.5 flex items-center gap-2 rounded-xl bg-white/5 p-2">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{l.name}</p><p className="truncate text-xs text-white/50">{l.contact}{l.verified ? " · verified" : ""}</p></div>
              <button className={`${btn} bg-brand-600 text-white`} onClick={() => act("lobby.admit", { waitId: l.waitId })}>Admit</button>
              <button className={`${btn} bg-white/10`} onClick={() => act("lobby.deny", { waitId: l.waitId })}>Deny</button>
            </div>
          ))}
        </section>
      )}
      {/* Raised hands, in the order they were raised; hosts can allow (unlocks the mic) or lower */}
      {s.hands.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-amber-300">Raised hands ({s.hands.length})</h3>
          {s.hands.map((id, i) => {
            const p = byId.get(id);
            return p ? (
              <div key={id} className="mb-1.5 flex items-center gap-2 rounded-xl bg-amber-400/10 p-2">
                <span className="w-5 text-center text-xs text-white/50">{i + 1}</span><span>✋</span>
                <span className="flex-1 truncate text-sm font-semibold">{p.name}</span>
                {host && <><button className={`${btn} bg-brand-600 text-white`} onClick={() => act("hand.allow", { identity: id })}>Allow to speak</button>
                  <button className={`${btn} bg-white/10`} onClick={() => act("hand.deny", { identity: id })}>Lower</button></>}
              </div>
            ) : null;
          })}
        </section>
      )}
      {/* Guests asking to present their screen */}
      {host && s.shareRequests.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-sky-300">Want to present</h3>
          {s.shareRequests.map((id) => (
            <div key={id} className="mb-1.5 flex items-center gap-2 rounded-xl bg-sky-400/10 p-2">
              <Icon name="present" size={16} /><span className="flex-1 truncate text-sm font-semibold">{byId.get(id)?.name}</span>
              <button className={`${btn} bg-brand-600 text-white`} onClick={() => act("share.allow", { identity: id })}>Allow</button>
              <button className={`${btn} bg-white/10`} onClick={() => act("share.deny", { identity: id })}>Deny</button>
            </div>
          ))}
        </section>
      )}
      {/* Room-wide switches: allow/mute all, open mic, anyone can present, lock */}
      {host && (
        <section className="grid grid-cols-2 gap-2">
          <button className={`${btn} bg-white/10 py-2`} onClick={() => act("mic.allowAll", {})}>Allow all to speak</button>
          <button className={`${btn} bg-white/10 py-2`} onClick={() => act("mic.muteAll", {})}>Mute all</button>
          <button className={`${btn} py-2 ${s.openMic ? "bg-brand-600 text-white" : "bg-white/10"}`} onClick={() => act("settings.openMic", { on: !s.openMic })}>Open mic: {s.openMic ? "on" : "off"}</button>
          <button className={`${btn} py-2 ${s.anyoneCanShare ? "bg-brand-600 text-white" : "bg-white/10"}`} onClick={() => act("settings.anyoneCanShare", { on: !s.anyoneCanShare })}>Anyone can present: {s.anyoneCanShare ? "on" : "off"}</button>
          <button className={`${btn} col-span-2 py-2 ${s.locked ? "bg-red-600 text-white" : "bg-white/10"}`} onClick={() => act("mod.lock", { locked: !s.locked }, s.locked ? "Meeting unlocked" : "Meeting locked: nobody new can join")}>
            <Icon name={s.locked ? "lock" : "unlock"} size={14} className="mr-1 inline" />{s.locked ? "Locked (tap to unlock)" : "Lock meeting"}</button>
        </section>
      )}
      {/* Everyone in the call */}
      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-white/50">In the call ({s.people.length})</h3>
        <ul className="space-y-1">
          {s.people.map((p) => (
            <PersonRow key={p.identity} call={call} p={p} me={p.identity === call.room?.localParticipant.identity} host={host} mic={lkMic(p.identity)} sharer={s.sharer === p.identity} act={act} />
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * One person: name, role, language, presenting/hand/mic icons; hosts get an actions menu.
 * Everyone gets a volume control for other people (just for them); hosts can also boost a person for everyone.
 */
function PersonRow({ call, p, me, host, mic, sharer, act }: { call: Call; p: any; me: boolean; host: boolean; mic: boolean; sharer: boolean; act: (ev: string, d: object, done?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [vol, setVol] = useState(false);
  return (
    <li className="rounded-xl hover:bg-white/5">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="flex-1 truncate text-sm">{p.name}{me && <span className="text-white/40"> (you)</span>}
          {p.role !== "guest" && <span className="ml-1 rounded bg-brand-500/30 px-1 text-[10px] uppercase text-brand-200">{p.role === "cohost" ? "co-host" : "host"}</span>}
          {p.via === "phone" && <span className="ml-1 text-[10px] text-white/50">phone</span>}
          <span className="ml-1 text-[10px] text-white/40">{langName(p.lang)}</span></span>
        {sharer && <Icon name="present" size={15} className="text-sky-300" />}
        {p.hand && <span>✋</span>}
        {/* Mic icon: live / allowed but muted / locked (guest without permission) */}
        {mic ? <Icon name="mic" size={15} className="text-brand-300" /> : p.canSpeak ? <Icon name="micOff" size={15} className="text-white/40" /> : <Icon name="lockMic" size={15} className="text-white/30" />}
        {p.boost > 1 && <span title="The host boosted this person's volume for everyone" className="text-[10px] font-semibold text-amber-300">{pct(p.boost)}</span>}
        {!me && <button onClick={() => setVol(!vol)} className={`rounded p-1 hover:bg-white/10 ${(call.personVolume[p.identity] ?? 1) !== 1 ? "text-amber-300" : ""}`} aria-label={`Volume for ${p.name}`}><Icon name="volume" size={16} /></button>}
        {host && !me && p.role !== "host" && <button onClick={() => setOpen(!open)} className="rounded p-1 hover:bg-white/10" aria-label="Actions"><Icon name="more" size={16} /></button>}
      </div>
      {vol && (
        <div className="space-y-2 px-2 pb-2">
          <VolumeSlider label="Volume for you" value={call.personVolume[p.identity] ?? 1} onChange={(v) => call.actions.setPersonVolume(p.identity, v)} />
          {host && (
            <div>
              <p className="mb-1 text-xs text-white/70">Boost for everyone</p>
              <div className="flex gap-1">
                {BOOSTS.map((b) => (
                  <button key={b} onClick={() => call.actions.boostVolume(p.identity, b)} className={`${btn} flex-1 px-1 ${p.boost === b ? "bg-brand-600 text-white" : "bg-white/10"}`}>{pct(b)}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {open && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-2">
          {p.role === "guest" && (p.canSpeak
            ? <button className={`${btn} bg-white/10`} onClick={() => act("mic.revoke", { identity: p.identity }, "Mic locked")}>Lock mic</button>
            : <button className={`${btn} bg-brand-600 text-white`} onClick={() => act("hand.allow", { identity: p.identity })}>Let speak</button>)}
          {p.role !== "guest" && mic && <button className={`${btn} bg-white/10`} onClick={() => act("mic.revoke", { identity: p.identity }, "Muted")}>Mute</button>}
          {sharer && <button className={`${btn} bg-white/10`} onClick={() => act("share.stop", { identity: p.identity })}>Stop share</button>}
          <button className={`${btn} bg-white/10`} onClick={() => act("mod.promote", { identity: p.identity, role: p.role === "cohost" ? "guest" : "cohost" })}>{p.role === "cohost" ? "Remove co-host" : "Make co-host"}</button>
          <button className={`${btn} bg-red-600/80 text-white`} onClick={async () => { if (await confirmToast(`Remove ${p.name} from the meeting?`, { confirm: "Remove", danger: true })) act("mod.remove", { identity: p.identity }, `${p.name} removed`); }}>Remove</button>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ Chat */
/** In-call chat. Messages are saved and included in the meeting summary. */
export function ChatPanel({ call }: { call: Call }) {
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const me = call.room?.localParticipant.identity;
  const myName = call.state?.people.find((p) => p.identity === me)?.name ?? "You";
  // Messages that arrived while the chat was closed get an "Unread messages (n)" line above them.
  const [unread] = useState(() => ({ from: call.chat.length - call.unread, n: call.unread }));
  // While open, new messages don't count as unread.
  useEffect(() => { call.actions.setChatOpen(true); return () => call.actions.setChatOpen(false); }, []);
  // Keep the newest message in view.
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [call.chat.length]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto pb-2">
        {!call.chat.length && <p className="text-sm text-white/50">Messages are seen by everyone and included in the summary.</p>}
        {/* Schoola style: avatar, name and time above each bubble; mine on the right in green */}
        {call.chat.map((m, i) => {
          const mine = m.identity === me;
          return (
            <div key={m.id}>
            {unread.n > 0 && i === unread.from && <p className="my-3 border-t border-white/10 pt-3 text-center text-xs text-white/50">Unread messages ({unread.n})</p>}
            <div className={`flex gap-2.5 ${mine ? "flex-row-reverse" : ""}`}>
              <span className="shrink-0 pt-0.5"><Avatar name={m.name} size={30} /></span>
              <div className={`min-w-0 max-w-[80%] ${mine ? "text-right" : ""}`}>
                <p className="text-xs"><b className="font-semibold text-white">{mine ? "You" : m.name}</b> <span className="text-[10px] text-white/40">{fmtTime(m.at)}</span></p>
                <p className={`mt-1 inline-block whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-left text-sm ${mine ? "rounded-tr-md bg-brand-600 text-white" : "rounded-tl-md bg-white/10 text-white/90"}`}>{m.text}</p>
              </div>
            </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <form className="relative flex items-center gap-2 border-t border-white/10 pt-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { call.actions.sendChat(text); setText(""); setEmoji(false); } }}>
        <Avatar name={myName} size={30} />
        <input className={`${dark} min-w-0 flex-1`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write message here…" maxLength={1000} />
        <button type="button" onClick={() => setEmoji(!emoji)} className={`rounded-lg p-2 ${emoji ? "bg-white/15" : "hover:bg-white/10"}`} aria-label="Emoji"><Icon name="smile" size={18} /></button>
        <button className="rounded-lg bg-brand-600 p-2 text-white hover:bg-brand-700" aria-label="Send"><Icon name="arrow" size={18} /></button>
        {/* Emoji picker: tap to add to the message */}
        {emoji && (
          <div className="absolute bottom-full right-0 mb-2 grid grid-cols-6 gap-1 rounded-2xl bg-ink-700 p-2 shadow-xl ring-1 ring-white/10">
            {EMOJI.map((e) => <button type="button" key={e} onClick={() => setText((t) => t + e)} className="rounded-lg p-1.5 text-xl hover:bg-white/10">{e}</button>)}
          </div>
        )}
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ Polls */
/** Polls: hosts create and close them; everyone votes and sees live counts (one vote per person, changeable). */
export function PollsPanel({ call }: { call: Call }) {
  const host = isHostRole(call.role);
  const [q, setQ] = useState(""); const [opts, setOpts] = useState(["Yes", "No"]);
  // My choices, remembered locally so the chosen option shows a tick.
  const [voted, setVoted] = useState<Record<string, number>>({});
  const polls = call.state?.polls ?? [];
  return (
    <div className="space-y-5">
      {host && (
        <form className="space-y-2 rounded-xl bg-white/5 p-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await call.actions.emit("poll.create", { question: q, options: opts.filter((o) => o.trim()) });
          if (r.ok) { setQ(""); setOpts(["Yes", "No"]); }
        }}>
          <input className={`${dark} w-full`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question" required />
          {opts.map((o, i) => <input key={i} className={`${dark} w-full`} value={o} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} />)}
          <div className="flex gap-2">
            {opts.length < 6 && <button type="button" className={`${btn} bg-white/10`} onClick={() => setOpts([...opts, ""])}>+ Option</button>}
            <button className={`${btn} ml-auto bg-brand-600 text-white`}>Start poll</button>
          </div>
        </form>
      )}
      {!polls.length && <p className="text-sm text-white/50">No polls yet.</p>}
      {[...polls].reverse().map((p) => {
        const total = p.counts.reduce((a, b) => a + b, 0);
        return (
          <div key={p.id} className="rounded-xl bg-white/5 p-3">
            <div className="mb-2 flex items-start justify-between gap-2"><p className="font-semibold">{p.question}</p>{p.closed ? <span className="text-xs text-white/50">Closed</span> : host && <button className={`${btn} bg-white/10`} onClick={() => call.actions.emit("poll.close", { pollId: p.id })}>Close</button>}</div>
            {p.options.map((o, i) => (
              <button key={i} disabled={p.closed} onClick={async () => { const r = await call.actions.emit("poll.vote", { pollId: p.id, option: i }); if (r.ok) setVoted({ ...voted, [p.id]: i }); }}
                className={`relative mb-1.5 block w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm ${voted[p.id] === i ? "border-brand-400" : "border-white/10"}`}>
                <span className="absolute inset-y-0 left-0 bg-brand-500/25" style={{ width: `${total ? (p.counts[i] / total) * 100 : 0}%` }} />
                <span className="relative flex justify-between"><span>{voted[p.id] === i && "✓ "}{o}</span><span className="text-white/60">{p.counts[i]}</span></span>
              </button>
            ))}
            <p className="text-xs text-white/40">{total} vote{total === 1 ? "" : "s"}</p>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Breakout rooms (hosts) */
/**
 * Breakout rooms (hosts): split guests evenly into N rooms, optionally for a set time.
 * While open: see who is where, visit a room, or close all (everyone returns to the main room).
 */
export function BreakoutPanel({ call }: { call: Call }) {
  const s = call.state!;
  const [count, setCount] = useState(2); const [minutes, setMinutes] = useState(10);
  const guests = s.people.filter((p) => p.role === "guest");
  if (s.breakouts) {
    return (
      <div className="space-y-3">
        {s.breakouts.endsAt && <p className="text-sm text-white/60">Rooms close at {fmtTime(new Date(s.breakouts.endsAt))}</p>}
        {s.breakouts.rooms.map((r) => (
          <div key={r.id} className="rounded-xl bg-white/5 p-3">
            <div className="flex items-center justify-between"><b className="text-sm">{r.label}</b><button className={`${btn} bg-white/10`} onClick={() => call.actions.emit("breakout.visit", { id: r.id })}>Visit</button></div>
            <p className="mt-1 text-xs text-white/60">{r.members.map((id) => s.people.find((p) => p.identity === id)?.name).filter(Boolean).join(", ") || "Empty"}</p>
          </div>
        ))}
        <button className={`${btn} w-full bg-white/10 py-2`} onClick={() => call.actions.emit("breakout.visit", { id: null })}>Go back to main room</button>
        <button className={`${btn} w-full bg-red-600 py-2 text-white`} onClick={() => call.actions.emit("breakout.close")}>Close all rooms (everyone returns)</button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-white/60">Split guests into smaller rooms. Hosts stay in the main room and can visit.</p>
      <label className="block text-sm">Rooms <input type="number" min={2} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${dark} mt-1 w-full`} /></label>
      <label className="block text-sm">Minutes (0 = until you close them) <input type="number" min={0} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={`${dark} mt-1 w-full`} /></label>
      <p className="text-xs text-white/50">{guests.length} guests will be shared out evenly.</p>
      <button className={`${btn} w-full bg-brand-600 py-2 text-white`} disabled={!guests.length} onClick={() => {
        // Round-robin: guest 1 → room 1, guest 2 → room 2, ... Hosts stay in the main room.
        const rooms = Array.from({ length: count }, (_, i) => ({ label: `Room ${i + 1}`, members: [] as string[] }));
        guests.forEach((g, i) => rooms[i % count].members.push(g.identity));
        call.actions.emit("breakout.start", { rooms, minutes });
      }}>Open breakout rooms</button>
    </div>
  );
}

/* ------------------------------------------------------------------ Settings: language, captions, data */
/** Speaker volume (up to 300%), data use (meter + Normal / Data saver / Audio only) and captions (language, show, read aloud). */
export function SettingsPanel({ call, meter }: { call: Call; meter: { usedMB: number; mbPerHour: number } }) {
  const savers: { id: DataSaver; label: string; hint: string }[] = [
    { id: "off", label: "Normal", hint: "All videos (auto quality)" },
    { id: "on", label: "Data saver", hint: "Only the speaker's video, low quality · ~50 MB/h" },
    { id: "audio", label: "Audio only", hint: "No camera video; slides still show · ~20 MB/h" },
  ];
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-white/50">Sound</h3>
        <VolumeSlider label="Speaker volume" value={call.volume} onChange={call.actions.setVolume} />
        <p className="mt-1 text-xs text-white/50">Go above 100% for quiet voices or weak speakers. To turn up one person only, use the speaker button next to them in People.</p>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-white/50">Data</h3>
        <p className="mb-2 text-white/80">Used so far: <b>{meter.usedMB.toFixed(1)} MB</b> · now about <b>{Math.round(meter.mbPerHour)} MB/hour</b></p>
        {savers.map((s) => (
          <button key={s.id} onClick={() => call.actions.setSaver(s.id)} className={`mb-1.5 block w-full rounded-xl border px-3 py-2 text-left ${call.saver === s.id ? "border-brand-400 bg-brand-500/15" : "border-white/10"}`}>
            <b>{s.label}</b><span className="block text-xs text-white/50">{s.hint}</span>
          </button>
        ))}
      </section>
      <section>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-white/50">Captions</h3>
        <label className="mb-2 block">My language
          <select className={`${dark} mt-1 w-full`} value={call.lang} onChange={(e) => call.actions.setLang(e.target.value)}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label className="flex items-center justify-between py-1.5"><span>Show captions</span><input type="checkbox" checked={call.captionsOn} onChange={(e) => call.actions.setCaptionsOn(e.target.checked)} className="h-5 w-5 accent-emerald-500" /></label>
        <label className="flex items-center justify-between py-1.5"><span>Read translations aloud<span className="block text-xs text-white/50">Voice translation into {langName(call.lang)} (uses your device's voices)</span></span><input type="checkbox" checked={call.listen} onChange={(e) => call.actions.setListen(e.target.checked)} className="h-5 w-5 accent-emerald-500" /></label>
        {call.state?.e2ee && <p className="text-xs text-amber-300">Captions are off: this meeting is end-to-end encrypted.</p>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ Transcript */
/**
 * Everything said in the call so far (from live captions), in MY language, with who said it.
 * The newest line is highlighted; the list follows along unless the person scrolls up to read.
 */
export function TranscriptPanel({ call }: { call: Call }) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current) box.current?.scrollTo({ top: box.current.scrollHeight }); }, [call.captions.length]);
  if (call.state?.e2ee) return <p className="text-sm text-white/50">There's no transcript: this meeting is end-to-end encrypted, so nothing said is sent for captions.</p>;
  return (
    <div ref={box} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} className="h-full space-y-3 overflow-y-auto text-sm leading-relaxed">
      {!call.captionsOn && (
        <div className="rounded-xl bg-white/5 p-3 text-white/70">
          Captions are off, so new speech isn't written down.
          <button onClick={() => call.actions.setCaptionsOn(true)} className={`${btn} ml-2 bg-brand-600 text-white`}>Turn on</button>
        </div>
      )}
      {!call.captions.length && call.captionsOn && <p className="text-white/50">What people say appears here as they speak, in {langName(call.lang)}.</p>}
      {call.captions.map((c, i) => (
        <p key={c.id} className="text-white/70">
          <b className="font-semibold text-white">{c.name}:</b>{" "}
          <span className={i === call.captions.length - 1 ? "rounded bg-brand-500/25 box-decoration-clone px-0.5 text-white" : ""}>{c.translations[call.lang] ?? c.text}</span>
          <span className="ml-1.5 text-[10px] text-white/40">{fmtTime(c.at)}</span>
        </p>
      ))}
    </div>
  );
}
