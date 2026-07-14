// hooks/useCallSession.ts
// Thin subscription turning CallSession events into React state. No
// orchestration here — see lib/webrtc/session.ts.
"use client";

import { useEffect, useRef, useState } from "react";
import { CallSession, type CallStatus } from "@/lib/webrtc/session";

export interface CallState {
  status: CallStatus;
  remoteStream: MediaStream | null;
  dcOpen: boolean;
}

export function useCallSession(
  roomId: string | null,
  stream: MediaStream | null,
  active: boolean,
): CallState {
  const [status, setStatus] = useState<CallStatus>("connecting");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [dcOpen, setDcOpen] = useState(false);
  const sessionRef = useRef<CallSession | null>(null);
  const streamRef = useRef<MediaStream | null>(stream);
  streamRef.current = stream;

  useEffect(() => {
    const local = streamRef.current;
    if (!active || !roomId || !local) return;
    const session = new CallSession(roomId, local);
    sessionRef.current = session;
    const offs = [
      session.events.on("status", setStatus),
      session.events.on("remoteStream", setRemoteStream),
      session.events.on("channelOpen", () => setDcOpen(true)),
      session.events.on("channelClosed", () => setDcOpen(false)),
    ];
    session.start();
    return () => {
      offs.forEach((off) => off());
      session.leave();
      sessionRef.current = null;
      setStatus("connecting");
      setRemoteStream(null);
      setDcOpen(false);
    };
    // `stream` is deliberately absent: device switches flow through
    // setLocalStream below instead of rebuilding the whole session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roomId]);

  useEffect(() => {
    // replaceTrack rejects if the link tore down this tick — harmless race
    if (stream) sessionRef.current?.setLocalStream(stream).catch(() => {});
  }, [stream]);

  return { status, remoteStream, dcOpen };
}
