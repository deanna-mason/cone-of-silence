// hooks/useScreenShare.ts
// The capture half of screen sharing. Owns the getDisplayMedia lifecycle the
// way useLocalMedia owns getUserMedia — components never touch
// navigator.mediaDevices, and the session (reached through ScreenPort) never
// stops tracks. The browser's own floating "Stop sharing" bar can end the
// track with no click in our UI: the `ended` listener routes that through the
// same stop path so the far side's tile and the scr/stop announce stay honest.
"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScreenPort } from "@/hooks/useCallSession";
import { getScreenStream, screenAudioLoopbackRisk, screenShareSupported } from "@/lib/webrtc/media";

export interface ScreenShareState {
  /** getDisplayMedia exists on this browser (it doesn't on phones). */
  supported: boolean;
  sharing: boolean;
  /** Whether the live capture carries tab/system audio (the browser picker's
   *  checkbox, where the platform offers one). False while not sharing. The
   *  room page uses it to tell the sharer why nobody can hear the share. */
  audioShared: boolean;
  /** The capture DID come back with audio, but it was dropped before
   *  reaching anyone: whole-screen/window system audio without a confirmed
   *  restrictOwnAudio would loop the call's own voices back to the room
   *  (screenAudioLoopbackRisk). The room page explains it to the sharer. */
  audioDropped: boolean;
  /** The live capture, for the local preview tile. */
  stream: MediaStream | null;
  start(): Promise<void>;
  stop(): void;
}

function noopSubscribe() {
  return () => {};
}

export function useScreenShare(screen: ScreenPort, active: boolean): ScreenShareState {
  // Same server-snapshot idiom as the room page's `authed`: the server render
  // must never touch `navigator`; hydration resyncs to the real value.
  const supported = useSyncExternalStore(noopSubscribe, screenShareSupported, () => false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [audioDropped, setAudioDropped] = useState(false);

  const stop = useCallback(() => {
    const s = streamRef.current;
    if (!s) return;
    streamRef.current = null;
    // Every track — the picture AND any tab/system audio — so a stop never
    // leaves the browser capturing sound nobody is sending.
    for (const track of s.getTracks()) track.stop(); // no-op on an already-ended track
    screen.stop();
    setStream(null);
    setAudioDropped(false);
  }, [screen]);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    const s = await getScreenStream();
    if (!s) return; // cancelled picker or unsupported — nothing to change
    // Loopback guard: drop (stop + remove) system audio that could carry the
    // call itself, BEFORE the session ever sees the stream — the picture
    // still goes. Tab-audio captures are never at risk and pass untouched.
    const dropAudio = screenAudioLoopbackRisk(s);
    if (dropAudio) {
      for (const track of s.getAudioTracks()) {
        s.removeTrack(track);
        track.stop();
      }
    }
    setAudioDropped(dropAudio);
    streamRef.current = s;
    s.getVideoTracks()[0]?.addEventListener("ended", stop, { once: true });
    setStream(s);
    screen.share(s);
  }, [screen, stop]);

  // Leaving the room ends the capture — the tally light must match reality —
  // and the cleanup return covers unmount (a live capture never outlives the
  // page). stop() with nothing live is a no-op, so re-runs are harmless.
  useEffect(() => {
    if (!active) stop();
    return stop;
  }, [active, stop]);

  const audioShared = stream !== null && stream.getAudioTracks().length > 0;
  return { supported, sharing: stream !== null, audioShared, audioDropped, stream, start, stop };
}
