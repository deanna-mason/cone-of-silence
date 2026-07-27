// hooks/useSpeaking.ts
// True while a stream's audio is above the speaking threshold. One shared
// AudioContext (calls begin with a click, so it starts un-suspended); one
// AnalyserNode per stream; throttled polling per spec — no per-frame work.
"use client";

import { useEffect, useState } from "react";
import { SPEAKING_POLL_MS, isSpeaking } from "@/lib/audioLevel";

let sharedCtx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null; // jsdom / unsupported
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}

export function useSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState(false);
  const [trackEpoch, setTrackEpoch] = useState(0);

  // Re-evaluate when the stream's track set changes (video-first arrival race).
  // VideoTile uses the same pattern: stream identity is stable, tracks mutate.
  useEffect(() => {
    if (!stream) return;
    const bump = () => setTrackEpoch((n) => n + 1);
    stream.addEventListener("addtrack", bump);
    stream.addEventListener("removetrack", bump);
    return () => {
      stream.removeEventListener("addtrack", bump);
      stream.removeEventListener("removetrack", bump);
    };
  }, [stream]);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    const ctx = audioContext();
    if (!ctx) return;
    void ctx.resume(); // autoplay-policy insurance; ignore rejection
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      const now = isSpeaking(buf);
      setSpeaking((prev) => (prev === now ? prev : now));
    }, SPEAKING_POLL_MS);
    return () => {
      clearInterval(timer);
      source.disconnect();
      // analyser.disconnect() not needed; it has no downstream connections.
      setSpeaking(false);
    };
  }, [stream, trackEpoch]);

  return speaking;
}
