/**
 * Host-side recording: records this meeting tab (what you see + everyone's audio + your mic) and uploads it.
 * Works without extra servers. For large deployments, swap in LiveKit Egress (server-side recording to S3).
 */
/** Records the meeting tab: tab video + tab audio (everyone else) + the host's own mic, mixed together. */
export class MeetingRecorder {
  private rec?: MediaRecorder;
  private parts: Blob[] = [];
  private display?: MediaStream;
  private ctx?: AudioContext;
  /** Called with the finished WebM file when recording stops (then Room.tsx uploads it). */
  onStopped?: (blob: Blob) => void;

  /** Ask the host to pick this tab, mix the audio, and start recording. Throws if the picker is cancelled. */
  async start(mic: MediaStreamTrack | undefined) {
    this.display = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 15 }, audio: true,
      // Chrome: offer "this tab" first and keep its sound playing.
      preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include",
    } as any);
    // Mix two audio sources into one track: the tab's sound (other people) and my microphone
    // (a tab capture does not include my own mic, because my browser doesn't play it back to me).
    this.ctx = new AudioContext();
    const dest = this.ctx.createMediaStreamDestination();
    if (this.display.getAudioTracks().length) this.ctx.createMediaStreamSource(new MediaStream(this.display.getAudioTracks())).connect(dest);
    if (mic) this.ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
    const stream = new MediaStream([...this.display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    // Best format this browser supports; ~1.2 Mbps keeps an hour around 500 MB.
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
    this.parts = [];
    this.rec.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.rec.onstop = () => {
      this.display?.getTracks().forEach((t) => t.stop());
      this.ctx?.close().catch(() => {});
      this.onStopped?.(new Blob(this.parts, { type: "video/webm" }));
    };
    // Stopping from the browser's "Stop sharing" bar also ends the recording.
    this.display.getVideoTracks()[0].addEventListener("ended", () => this.stop());
    this.rec.start(5000); // emit data every 5 s so a crash loses little
  }

  /** Stop recording (fires onStopped). */
  stop() { if (this.rec && this.rec.state !== "inactive") this.rec.stop(); }
  /** True while recording. */
  get active() { return this.rec?.state === "recording"; }
}

/** Upload a recording with progress (XMLHttpRequest, because fetch has no upload progress). Hosts only. */
export async function uploadRecording(blob: Blob, ticket: string, onProgress?: (pct: number) => void): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "recording.webm");
  await new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/rooms/recordings");
    x.setRequestHeader("authorization", `Bearer ${ticket}`);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error(JSON.parse(x.responseText || "{}").error ?? "Upload failed")));
    x.onerror = () => reject(new Error("Upload failed"));
    x.send(form);
  });
}
