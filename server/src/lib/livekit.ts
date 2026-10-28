/**
 * LiveKit (the SFU media server): access tokens and server-side permission changes.
 * The server, not the browser, decides who may publish a microphone or a screen share:
 * a guest's token allows camera only, and the server widens it when the host approves.
 */
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { config } from "../config.js";
import { log } from "../log.js";

/** Server-side LiveKit API client (permissions, mute, remove, close room). */
export const roomService = new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);

/** What a person may publish besides their camera (everyone may publish a camera). */
export interface Perms { mic: boolean; share: boolean }

/** Turn our Perms into LiveKit's list of allowed track sources. Camera is always allowed. */
export function sourcesFor(p: Perms): TrackSource[] {
  const s = [TrackSource.CAMERA];
  if (p.mic) s.push(TrackSource.MICROPHONE);
  if (p.share) s.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return s;
}

/**
 * Access token a browser uses to join a LiveKit room.
 * The allowed sources are baked in, so a guest's browser physically cannot publish a mic or a screen
 * until the host approves (then setPerms widens them live).
 */
export async function mediaToken(o: { room: string; identity: string; name: string; perms: Perms; metadata?: string }) {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: o.identity, name: o.name, ttl: "26h", metadata: o.metadata,
  });
  at.addGrant({
    room: o.room, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true,
    canPublishSources: sourcesFor(o.perms), canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

/** Change what a connected participant may publish. Revoking removes their live tracks too. */
export async function setPerms(room: string, identity: string, p: Perms) {
  try {
    await roomService.updateParticipant(room, identity, {
      permission: { canSubscribe: true, canPublish: true, canPublishData: true, canPublishSources: sourcesFor(p) },
    });
  } catch (e: any) {
    // The participant may not have connected to the media room yet; their next token carries the new perms.
    log.debug({ err: e?.message, room, identity }, "setPerms skipped");
  }
}

/** Server-side mute of a person's published track of one kind (e.g. a host muting a co-host's mic). */
export async function muteTrack(room: string, identity: string, source: TrackSource) {
  const list = await roomService.listParticipants(room).catch(() => []);
  const p = list.find((x) => x.identity === identity);
  for (const t of p?.tracks ?? []) {
    if (t.source === source && !t.muted) await roomService.mutePublishedTrack(room, identity, t.sid, true).catch(() => {});
  }
}

/** Disconnect someone from the media room (used when the host removes them). */
export async function kick(room: string, identity: string) {
  await roomService.removeParticipant(room, identity).catch(() => {});
}

/** Close a media room for everyone (meeting ended, or a breakout room closed). */
export async function closeRoom(room: string) {
  await roomService.deleteRoom(room).catch(() => {});
}
