// components/FaceThumb.tsx
// A tiny face for the fullscreen screen view. Strictly picture-only: the
// full tiles — the ones carrying the call's live audio and its mute
// machinery — keep playing underneath the fullscreen element, so an unmuted
// copy here would double every voice. No controls, no overlays; just enough
// face to read the room while a document fills the monitor.
"use client";

import { useEffect, useRef } from "react";

interface FaceThumbProps {
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
}

export default function FaceThumb({ stream, label, mirrored = false }: FaceThumbProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) {
      video.muted = true;
      video.play().catch(() => {});
    }
  }, [stream]);

  return (
    <figure className="hairline relative w-28 overflow-hidden border bg-inset sm:w-36">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`aspect-video w-full object-cover ${mirrored ? "-scale-x-100" : ""}`}
      />
      <figcaption className="kicker absolute bottom-1 left-1 bg-field/80 px-1.5 py-0.5 text-ink-soft">
        {label}
      </figcaption>
    </figure>
  );
}
