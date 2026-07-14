// components/VideoTile.tsx
"use client";

import { useEffect, useRef, useState } from "react";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  isSelf?: boolean;
  camOff?: boolean;
}

export default function VideoTile({
  stream,
  label,
  mirrored = false,
  isSelf = false,
  camOff = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [, setTrackEpoch] = useState(0);
  // Remote audio starts muted: unmuted autoplay is blocked by browsers, and
  // muted playback always starts. The overlay button is the user gesture
  // that lawfully unmutes.
  const [audioOn, setAudioOn] = useState(false);

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

  // Bind the stream once per identity change; muted play() always starts.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    setAudioOn(false); // a new stream must start muted again
    if (stream) {
      video.play().catch(() => {
        // autoplay refused — the Restore Audio gesture retries below
      });
    }
  }, [stream]);

  // `muted` is a DOM property React doesn't reliably manage — set it via ref.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isSelf || !audioOn;
    if (stream && !video.muted) {
      video.play().catch(() => setAudioOn(false)); // gesture failed — reshow the button
    }
  }, [stream, isSelf, audioOn]);

  const hasVideoTrack = stream !== null && stream.getVideoTracks().length > 0;
  const covered = !hasVideoTrack || camOff;

  return (
    <figure className="hairline relative aspect-video overflow-hidden border bg-inset">
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""} ${
            covered ? "invisible" : ""
          }`}
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
      {!isSelf && stream && !audioOn && (
        <button
          type="button"
          onClick={() => setAudioOn(true)}
          className="kicker absolute right-2 top-2 border border-brass bg-field/80 px-3 py-1.5 text-ink-soft transition hover:text-signal"
        >
          Restore Audio
        </button>
      )}
      <figcaption className="kicker absolute bottom-2 left-2 bg-field/80 px-2 py-1 text-ink-soft">
        {label}
      </figcaption>
    </figure>
  );
}
