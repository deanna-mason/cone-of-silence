// components/VideoTile.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { EPISODE_PANE_H, EPISODE_PANE_W } from "@/lib/podcast/paneAspect";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  isSelf?: boolean;
  camOff?: boolean;
  fill?: boolean; // Phase 4B: size from the parent grid cell instead of aspect-video
  signalLost?: boolean;
  speaking?: boolean;
  /** Episode framing (design 2026-08-03): while the tape rolls, show exactly
   *  the mp4's visible region — a centered viewport at the darkroom pane
   *  aspect with the video cover-cropped inside it, letterbox around it.
   *  Replaces the old object-contain letterbox monitor: the composite now
   *  cover-crops, so the honest preview is the crop. */
  episodeFrame?: boolean;
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
  episodeFrame = false,
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
      video.play().catch((err: unknown) => {
        if ((err as DOMException)?.name !== "NotAllowedError") return;
        if (video.srcObject !== stream) return; // stale binding — a newer effect owns the element
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
        <div className={episodeFrame ? "flex h-full w-full items-center justify-center" : "h-full w-full"}>
          {/* aspect-ratio + max-width: whichever tile dimension binds,
              the box keeps the pane shape (CSS transferred-size rules). Structure is
              IDENTICAL in both modes so the <video> node survives the
              podcastLocked toggle (review round 1: remount dropped srcObject). */}
          <div
            data-testid={episodeFrame ? "episode-viewport" : undefined}
            className={episodeFrame ? "relative max-w-full overflow-hidden" : "h-full w-full"}
            style={episodeFrame ? { aspectRatio: `${EPISODE_PANE_W} / ${EPISODE_PANE_H}`, height: "100%" } : undefined}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""} ${covered ? "invisible" : ""} ${audio === "muted" ? "brightness-[.85] saturate-[.6]" : ""}`}
            />
          </div>
        </div>
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
      {!isSelf && stream && audio !== "blocked" && (
        <button
          type="button"
          onClick={() => setAudio(audio === "muted" ? "on" : "muted")}
          className={`kicker absolute right-2 top-2 border bg-field/80 px-3 py-1.5 transition hover:text-signal ${
            audio === "muted"
              ? "border-vermilion/60 text-vermilion"
              : "border-brass text-ink-soft"
          }`}
        >
          {audio === "muted" ? "◇ Muted — Unmute" : "Mute"}
        </button>
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
