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

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    const ctx = audioContext();
    if (!ctx) return;
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
      setSpeaking(false);
    };
  }, [stream]);

  return speaking;
}
