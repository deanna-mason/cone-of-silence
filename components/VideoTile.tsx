// components/VideoTile.tsx
"use client";

import { useEffect, useRef, useState } from "react";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  isSelf?: boolean;
  camOff?: boolean;
  fill?: boolean; // Phase 4B: size from the parent grid cell instead of aspect-video
  signalLost?: boolean;
  speaking?: boolean;
  /** Honest framing (spec §5A): letterbox instead of crop, so the monitor
   *  shows exactly the frame the tape is recording. Self tile, while rolling. */
  fullFrame?: boolean;
}

export default function VideoTile({
  stream,
  label,
  mirrored = false,
  isSelf = false,
  camOff = false,
  fill = false,
  signalLost = false,
  speaking = false,
  fullFrame = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [, setTrackEpoch] = useState(0);
  // Remote audio is on from the first frame: by the time a remote tile
  // exists the user has clicked "Enter the Cone", which is the activation
  // browsers require for unmuted playback. "blocked" is the rare fallback
  // when a browser still refuses — muted playback + a Restore Audio gesture.
  const [audio, setAudio] = useState<"on" | "muted" | "blocked">("on");

  // Remote streams gain/lose tracks via ontrack/removetrack without any React
  // render — re-render on stream mutations so `covered` stays truthful.
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

  // Bind the stream once per identity change. Muted play() always starts the
  // picture; the audio effect below immediately upgrades to unmuted. A
  // replaced stream is a fresh join and resets to audible (spec: reconnects
  // never inherit a stale mute).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    setAudio("on");
    if (stream) {
      video.muted = true;
      video.play().catch(() => {});
    }
  }, [stream]);

  // `muted` is a DOM property React doesn't reliably manage — set it via ref.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isSelf || audio !== "on";
    if (stream && !video.muted) {
      video.play().catch(() => {
        // unmuted playback refused — keep the picture rolling muted and
        // surface the Restore Audio gesture.
        video.muted = true;
        video.play().catch(() => {});
        setAudio("blocked");
      });
    }
  }, [stream, isSelf, audio]);

  const hasVideoTrack = stream !== null && stream.getVideoTracks().length > 0;
  const covered = !hasVideoTrack || camOff;

  return (
    <figure
      className={`hairline relative overflow-hidden border bg-inset ${
        fill ? "h-full min-h-0 w-full" : "aspect-video"
      } ${speaking ? "ring-2 ring-brass/70" : ""}`}
    >
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`h-full w-full ${fullFrame ? "object-contain" : "object-cover"} ${
            mirrored ? "-scale-x-100" : ""
          } ${covered ? "invisible" : ""}`}
        />
      )}
      {covered && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <svg aria-hidden viewBox="0 0 200 200" className="h-20 w-20 text-ink-faint/50">
            <circle cx="100" cy="100" r="94" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="100" cy="100" r="46" fill="none" stroke="currentColor" strokeWidth="8" />
            <line x1="100" y1="0" x2="100" y2="200" stroke="currentColor" strokeWidth="1.5" />
            <line x1="0" y1="100" x2="200" y2="100" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <p className="kicker text-ink-soft">
            {stream ? (camOff ? "Lens capped" : "Audio only") : "Awaiting agent"}
          </p>
        </div>
      )}
      {signalLost && (
        <p className="kicker absolute left-2 top-2 border border-vermilion/60 bg-field/80 px-2 py-1 text-vermilion">
          ◈ Signal Lost
        </p>
      )}
      {!isSelf && stream && audio === "blocked" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-reveal/30 p-3 text-center">
          <p className="kicker text-vermilion">◈ Audio Blocked by Browser</p>
          <button
            type="button"
            onClick={() => setAudio("on")}
            className="cta-glow bg-vermilion px-6 py-3 font-display text-2xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright"
          >
            Restore Audio
          </button>
        </div>
      )}
      <figcaption className="kicker absolute bottom-2 left-2 bg-field/80 px-2 py-1 text-ink-soft">
        {label}
      </figcaption>
    </figure>
  );
}
