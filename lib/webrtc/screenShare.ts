// lib/webrtc/screenShare.ts
// Cos-channel announce for a shared screen. A screen arrives as one more
// encrypted video track, indistinguishable from a second camera — the only
// durable label is the MediaStream id (it survives the SDP msid), so the
// sharer announces which stream id is a screen and the far side files that
// stream under the screen tile instead of a face tile. React-free, DOM-free.
// Wire frames are JSON with a "t" field prefixed "scr/", mirroring
// takeProtocol/xferProtocol; foreign `t` / unparseable JSON parse to null.

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
