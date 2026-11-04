// lib/webrtc/screenShare.ts
// Cos-channel announce for a shared screen. A screen arrives as one more
// encrypted video track (plus, when the sharer ticked the browser's audio
// box, one more encrypted audio track on the same stream),
// indistinguishable from a second camera — the only
// durable label is the MediaStream id (it survives the SDP msid), so the
// sharer announces which stream id is a screen and the far side files that
// stream under the screen tile instead of a face tile. React-free, DOM-free.
// Wire frames are JSON with a "t" field prefixed "scr/", mirroring
// takeProtocol/xferProtocol; foreign `t` / unparseable JSON parse to null.
//
// Transport: these ride the PEER-TO-PEER `cos` data channel (DTLS, proof-
// gated in CallSession), never the signaling server — lib/webrtc/protocol.ts
// is the server-validated vocabulary, this file is not. Adding a field here
// needs no server change or deploy.

/** The tracks of one screen share. `audio` is the tab/system sound the
 *  sharer opted into in the browser's picker — null when none came back.
 *  Both ride the screen's one carrier stream (see CallSession.screenCarrier),
 *  so the far side files them together under the screen tile. */
export interface ScreenTracks {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
}

/** `audio` on scr/share: whether THIS share carries sound. Needed because a
 *  re-share re-arms parked senders in place — the far side's stream keeps
 *  the audio track from an earlier audible share even when this one is
 *  silent, so track presence there can't tell. Absent = a peer that
 *  predates the flag (the receiver falls back to track presence). */
export type ScreenMsg = { t: "scr/share"; streamId: string; audio?: boolean } | { t: "scr/stop" };

export function buildScreenShareMsg(streamId: string, audio?: boolean): string {
  return JSON.stringify({ t: "scr/share", v: 1, streamId, ...(audio !== undefined ? { audio } : {}) });
}

/** Whether a remote screen should be treated as audible: the sharer's
 *  announce when it gave one, track presence for a peer that predates it. */
export function screenHasAudio(stream: MediaStream | null, announced: boolean | undefined): boolean {
  if (!stream || stream.getAudioTracks().length === 0) return false;
  return announced ?? true;
}

export function buildScreenStopMsg(): string {
  return JSON.stringify({ t: "scr/stop", v: 1 });
}

export function parseScreenMsg(text: string): ScreenMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const t = m.t;
  if (typeof t !== "string" || !t.startsWith("scr/")) return null;
  switch (t) {
    case "scr/share":
      if (typeof m.streamId !== "string") return null;
      return typeof m.audio === "boolean"
        ? { t: "scr/share", streamId: m.streamId, audio: m.audio }
        : { t: "scr/share", streamId: m.streamId };
    case "scr/stop":
      return { t: "scr/stop" };
    default:
      return null;
  }
}
