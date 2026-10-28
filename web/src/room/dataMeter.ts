/**
 * Data meter: how many MB this call has used on this device, and the current rate per hour.
 * Sums bytes sent and received on every media track (from WebRTC stats).
 */
import type { Room } from "livekit-client";

/** Keeps running totals across samples; one instance per call. */
export class DataMeter {
  private seen = new Map<string, number>(); // last byte counter seen per track (counters only go up)
  private total = 0;
  private history: { t: number; total: number }[] = []; // last 30 s of totals, for the MB/hour rate

  /** Read stats for every track now; returns MB used so far and the current rate in MB per hour. */
  async sample(room: Room) {
    const reads: Promise<void>[] = [];
    const read = (key: string, getStats: (() => Promise<RTCStatsReport>) | undefined, type: "inbound-rtp" | "outbound-rtp") => {
      if (!getStats) return;
      reads.push(getStats().then((report) => {
        let bytes = 0;
        report.forEach((s: any) => { if (s.type === type) bytes += (type === "inbound-rtp" ? s.bytesReceived : s.bytesSent) ?? 0; });
        const prev = this.seen.get(key) ?? 0;
        // Add only the new bytes since last time (a reset counter, e.g. a re-published track, is skipped).
        if (bytes >= prev) this.total += bytes - prev;
        this.seen.set(key, bytes);
      }).catch(() => {}));
    };
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const r = (pub.track as any)?.receiver as RTCRtpReceiver | undefined;
        if (r) read(`r:${pub.trackSid}`, () => r.getStats(), "inbound-rtp");
      }
    }
    for (const pub of room.localParticipant.trackPublications.values()) {
      const s = (pub.track as any)?.sender as RTCRtpSender | undefined;
      if (s) read(`s:${pub.trackSid}`, () => s.getStats(), "outbound-rtp");
    }
    await Promise.all(reads);
    const now = Date.now();
    this.history.push({ t: now, total: this.total });
    this.history = this.history.filter((h) => now - h.t <= 30_000);
    const first = this.history[0];
    // Rate over the last 30 seconds, scaled to an hour (needs at least 3 s of history).
    const rate = first && now - first.t > 3000 ? ((this.total - first.total) / ((now - first.t) / 1000)) * 3600 : 0;
    return { usedMB: this.total / 1e6, mbPerHour: rate / 1e6 };
  }
}
