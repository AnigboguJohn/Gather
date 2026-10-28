/**
 * Sends the speaker's own microphone audio for live captions, in short chunks.
 * - Only while the mic is on and captions are enabled.
 * - Silent chunks are skipped (saves data and free-tier quota).
 * Each chunk is a complete small file (the recorder restarts every few seconds), which speech-to-text needs.
 */
/** Length of each audio chunk sent for captions (shorter = faster captions, more requests). */
const CHUNK_MS = 4000;
/** Loudness (RMS, 0..1) below which a chunk is treated as silence and not sent. */
const SILENCE_RMS = 0.012;

/** The first audio format this browser can record (Chrome/Firefox: WebM/Ogg Opus, Safari: MP4). */
function pickMime(): { mime: string; ext: string } {
  const opts = [
    { mime: "audio/webm;codecs=opus", ext: "webm" }, { mime: "audio/ogg;codecs=opus", ext: "ogg" }, { mime: "audio/mp4", ext: "mp4" },
  ];
  return opts.find((o) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(o.mime)) ?? { mime: "", ext: "webm" };
}

/** Records one microphone track in short chunks and uploads loud chunks to /api/rooms/captions. */
export class CaptionRecorder {
  private stopped = false;
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private rec?: MediaRecorder;
  private peak = 0;
  private timer?: number;
  private meterTimer?: number;

  /**
   * @param track   my live microphone track
   * @param ticket  room ticket (proves who is speaking; the server checks I'm allowed to speak)
   * @param onError called with a message when captions fail (other than rate limits)
   */
  constructor(private track: MediaStreamTrack, private ticket: string, private onError: (msg: string) => void) {}

  /** Start measuring loudness and recording chunks. */
  start() {
    const stream = new MediaStream([this.track]);
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const buf = new Float32Array(this.analyser.fftSize);
      // Every 100 ms remember the loudest level heard in the current chunk.
      this.meterTimer = window.setInterval(() => {
        this.analyser!.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        this.peak = Math.max(this.peak, Math.sqrt(sum / buf.length));
      }, 100);
    } catch { this.peak = 1; /* no Web Audio: send everything */ }
    this.loop(stream);
  }

  /**
   * Record one chunk, then start the next. A fresh MediaRecorder per chunk means every upload is a
   * complete file with its own header, which speech-to-text needs (timeslice pieces are not playable alone).
   */
  private loop(stream: MediaStream) {
    if (this.stopped || this.track.readyState === "ended") return;
    const { mime, ext } = pickMime();
    // 24 kbps Opus is plenty for speech and keeps uploads tiny on mobile data.
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined);
    this.rec = rec;
    const parts: Blob[] = [];
    this.peak = 0;
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => {
      const loud = this.peak > SILENCE_RMS;
      if (loud && parts.length && !this.stopped) this.send(new Blob(parts, { type: mime || "audio/webm" }), ext);
      if (!this.stopped) this.loop(stream);
    };
    rec.start();
    this.timer = window.setTimeout(() => rec.state !== "inactive" && rec.stop(), CHUNK_MS);
  }

  /** Upload one chunk. 403/410 mean my mic was locked or the meeting ended: stop recording. */
  private async send(blob: Blob, ext: string) {
    const form = new FormData();
    form.append("audio", blob, `chunk.${ext}`);
    try {
      const r = await fetch("/api/rooms/captions", { method: "POST", body: form, headers: { authorization: `Bearer ${this.ticket}` } });
      if (r.status === 403 || r.status === 410) this.stop();
      else if (!r.ok && r.status !== 429) this.onError((await r.json().catch(() => ({}))).error ?? "Captions unavailable");
    } catch { /* offline for a moment: skip this chunk */ }
  }

  /** Stop for good (mic muted, captions off, or leaving). */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.meterTimer);
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    this.ctx?.close().catch(() => {});
  }
}

/** Reads captions aloud in the listener's language ("voice translation"). */
export class CaptionVoice {
  private queue: string[] = [];
  /** @param lang caption language of the listener (picks the voice) */
  constructor(private lang: string) {}
  /** Change the listener's language. */
  setLang(l: string) { this.lang = l; }
  /** Queue a line to be spoken; keeps at most 3 waiting so speech stays close to real time. */
  say(text: string) {
    if (!("speechSynthesis" in window)) return;
    this.queue.push(text);
    if (this.queue.length > 3) this.queue.shift(); // don't fall behind the conversation
    if (!speechSynthesis.speaking) this.next();
  }
  /** Speak the next queued line with the best matching device voice (exact locale, then same language). */
  private next() {
    const t = this.queue.shift();
    if (!t) return;
    const u = new SpeechSynthesisUtterance(t);
    const voices = speechSynthesis.getVoices();
    const code = TTS[this.lang] ?? "en-NG";
    u.voice = voices.find((v) => v.lang === code) ?? voices.find((v) => v.lang.startsWith(code.split("-")[0])) ?? null;
    u.lang = code; u.rate = 1.05;
    u.onend = () => this.next();
    speechSynthesis.speak(u);
  }
  /** Stop speaking and clear the queue. */
  stop() { this.queue = []; if ("speechSynthesis" in window) speechSynthesis.cancel(); }
}
/** Caption language → text-to-speech locale (Pidgin uses Nigerian English voices). */
const TTS: Record<string, string> = { en: "en-NG", yo: "yo-NG", ha: "ha-NG", ig: "ig-NG", pcm: "en-NG", sw: "sw-KE", fr: "fr-FR" };
