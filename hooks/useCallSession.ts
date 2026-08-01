// hooks/useCallSession.ts
// Thin subscription turning CallSession events into React state. No
// orchestration here — see lib/webrtc/session.ts.
"use client";

import { useEffect, useRef, useState } from "react";
import {
  CallSession,
  type CallStatus,
  type ChannelLifecycle,
  type ChannelName,
  type RemotePeer,
} from "@/lib/webrtc/session";

export interface XferPort {
  send(peerId: string, data: string | ArrayBuffer): boolean;
  bufferedAmount(peerId: string): number; // -1 unknown/linkless
  onMessage(fn: (peerId: string, data: string | ArrayBuffer) => void): () => void;
  onDrain(fn: (peerId: string) => void): () => void;
  onChannelState(fn: (peerId: string, channel: ChannelName, state: ChannelLifecycle) => void): () => void;
}

export interface CallBus {
  sendAll(text: string): void;
  sendTo(peerId: string, text: string): boolean;
  onMessage(fn: (peerId: string, text: string) => void): () => void;
  xfer: XferPort;
}

export interface CallState {
  status: CallStatus;
  peers: RemotePeer[];
  dcOpen: boolean;
  bus: CallBus;
}

export function useCallSession(
  roomId: string | null,
  stream: MediaStream | null,
  active: boolean,
  forceRelay = false,
): CallState {
  const [status, setStatus] = useState<CallStatus>("connecting");
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [dcOpen, setDcOpen] = useState(false);
  const sessionRef = useRef<CallSession | null>(null);
  const streamRef = useRef<MediaStream | null>(stream);
  streamRef.current = stream;

  // Message listeners registered against the bus, independent of whether a
  // session currently exists — the session-effect below fans its "message"
  // event out to whatever is in this set at the time, and a listener
  // registered before the session (re)builds still gets wired up once it
  // does.
  const listenersRef = useRef<Set<(peerId: string, text: string) => void>>(new Set());
  // Same independent-of-session-existence idiom as listenersRef above, one
  // Set per xfer sub-event so each fans out only its own listeners.
  const xferMessageListenersRef = useRef<Set<(peerId: string, data: string | ArrayBuffer) => void>>(new Set());
  const xferDrainListenersRef = useRef<Set<(peerId: string) => void>>(new Set());
  const xferChannelStateListenersRef =
    useRef<Set<(peerId: string, channel: ChannelName, state: ChannelLifecycle) => void>>(new Set());
  const busRef = useRef<CallBus | undefined>(undefined);
  if (!busRef.current) {
    const xfer: XferPort = {
      send: (peerId, data) => sessionRef.current?.sendXferTo(peerId, data) ?? false,
      bufferedAmount: (peerId) => sessionRef.current?.xferBufferedAmount(peerId) ?? -1,
      onMessage: (fn) => {
        xferMessageListenersRef.current.add(fn);
        return () => xferMessageListenersRef.current.delete(fn);
      },
      onDrain: (fn) => {
        xferDrainListenersRef.current.add(fn);
        return () => xferDrainListenersRef.current.delete(fn);
      },
      onChannelState: (fn) => {
        xferChannelStateListenersRef.current.add(fn);
        return () => xferChannelStateListenersRef.current.delete(fn);
      },
    };
    busRef.current = {
      sendAll: (text) => sessionRef.current?.sendAll(text),
      sendTo: (peerId, text) => sessionRef.current?.sendTo(peerId, text) ?? false,
      onMessage: (fn) => {
        listenersRef.current.add(fn);
        return () => listenersRef.current.delete(fn);
      },
      xfer,
    };
  }

  useEffect(() => {
    const local = streamRef.current;
    if (!active || !roomId || !local) return;
    const session = new CallSession(roomId, local, undefined, { forceRelay });
    sessionRef.current = session;
    const offs = [
      session.events.on("status", setStatus),
      session.events.on("roster", setPeers),
      session.events.on("channelOpen", () => setDcOpen(true)),
      session.events.on("channelClosed", () => setDcOpen(false)),
      session.events.on("message", (peerId, text) => {
        for (const fn of listenersRef.current) fn(peerId, text);
      }),
      session.events.on("xferMessage", (peerId, data) => {
        for (const fn of xferMessageListenersRef.current) fn(peerId, data);
      }),
      session.events.on("xferDrain", (peerId) => {
        for (const fn of xferDrainListenersRef.current) fn(peerId);
      }),
      // Ordering vs. "channelClosed" above is deliberately unspecified (see
      // session.ts) — fanned out standalone, with no assumption either way.
      session.events.on("channelState", (peerId, channel, state) => {
        for (const fn of xferChannelStateListenersRef.current) fn(peerId, channel, state);
      }),
    ];
    session.start();
    return () => {
      offs.forEach((off) => off());
      session.leave();
      sessionRef.current = null;
      setStatus("connecting");
      setPeers([]);
      setDcOpen(false);
    };
    // `stream` is deliberately absent: device switches flow through
    // setLocalStream below instead of rebuilding the whole session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roomId, forceRelay]);

  useEffect(() => {
    // replaceTrack rejects if a link tore down this tick — harmless race
    if (stream) sessionRef.current?.setLocalStream(stream).catch(() => {});
  }, [stream]);

  return { status, peers, dcOpen, bus: busRef.current };
}
