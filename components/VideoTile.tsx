// components/VideoTile.tsx
"use client";

import { useEffect, useRef } from "react";

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

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const hasVideoTrack = stream !== null && stream.getVideoTracks().length > 0;
  const covered = !hasVideoTrack || camOff;

  return (
    <figure className="hairline relative aspect-video overflow-hidden border bg-inset">
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf}
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
      <figcaption className="kicker absolute bottom-2 left-2 bg-field/80 px-2 py-1 text-ink-soft">
        {label}
      </figcaption>
    </figure>
  );
}
