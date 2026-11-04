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

/** The tracks of one screen share. `audio` is the tab/system sound the
 *  sharer opted into in the browser's picker — null when none came back.
 *  Both ride the screen's one carrier stream (see CallSession.screenCarrier),
 *  so the far side files them together under the screen tile; the scr/*
 *  announce below needs no audio field. */
export interface ScreenTracks {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
}

export type ScreenMsg = { t: "scr/share"; streamId: string } | { t: "scr/stop" };

export function buildScreenShareMsg(streamId: string): string {
  return JSON.stringify({ t: "scr/share", v: 1, streamId });
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
      return typeof m.streamId === "string" ? { t: "scr/share", streamId: m.streamId } : null;
    case "scr/stop":
      return { t: "scr/stop" };
    default:
      return null;
  }
}
