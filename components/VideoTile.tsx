// components/VideoTile.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { EPISODE_PANE_H, EPISODE_PANE_W } from "@/lib/podcast/paneAspect";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  isSelf?: boolean;
  camOff?: boolean;
  fill?: boolean; // Phase 4B: size from the parent grid cell instead of aspect-video
  signalLost?: boolean;
  speaking?: boolean;
  /** The LOCAL host's own mic is cut (8/3 drill F2: a seat talked into a cut
   *  mic and nobody noticed). Self tile only — draws a persistent vermilion
   *  border + a loud badge so your own muted state can't go unread mid-call.
   *  An overlay sibling, like signalLost/figcaption — the div>div>video tree
   *  is untouched, preserving the episodeFrame remount invariant. */
  micCut?: boolean;
  /** Episode framing (design 2026-08-03): while the tape rolls, show exactly
   *  the mp4's visible region — a centered viewport at the darkroom pane
   *  aspect with the video cover-cropped inside it, letterbox around it.
   *  Replaces the old object-contain letterbox monitor: the composite now
   *  cover-crops, so the honest preview is the crop. */
  episodeFrame?: boolean;
  /** A shared screen, not a face: letterbox (object-contain — cover-cropping
   *  a document amputates its edges), keep playback muted (the track carries
   *  no audio, so there is nothing to restore), and offer no per-agent Mute
   *  control. */
  screenShare?: boolean;
}

/** The episode viewport's inline style (exported so the regression test can
 *  pin the exact formulas directly — jsdom's CSSOM can't round-trip a
 *  cqw/cqh-mixed min()/calc() value through element.style, so asserting on
 *  the rendered DOM's style.width isn't possible there; this function is
 *  the source of truth the DOM style is built from).
 *
 *  Iris Pan (CS-DR-04 2B): BOTH width and height are plain cqw/cqh lengths so
 *  the roll-tape crop can EASE between the two states on a persistent node —
 *  aspect-ratio is NEVER animated (interpolating it jumps). `rolling` picks
 *  the target:
 *    • rolling  → the pane-shaped crop: width = min(own width, own height x
 *      pane ratio); height = the inverse min. Whichever tile dimension binds,
 *      the box keeps the 930:1008 pane shape and centres, letterboxed.
 *    • not rolling → a plain full fill (100cqw x 100cqh) — the same box the
 *      un-cropped tile always showed, but expressed in the same length family
 *      as the crop so the transition has two interpolable endpoints. */
export function episodeViewportStyle(rolling: boolean): CSSProperties {
  if (!rolling) {
    return { width: "100cqw", height: "100cqh" };
  }
  return {
    width: `min(100cqw, calc(100cqh * (${EPISODE_PANE_W} / ${EPISODE_PANE_H})))`,
    height: `min(100cqh, calc(100cqw * (${EPISODE_PANE_H} / ${EPISODE_PANE_W})))`,
  };
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
  micCut = false,
  episodeFrame = false,
  screenShare = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const figureRef = useRef<HTMLElement>(null);
  const [, setTrackEpoch] = useState(0);
  // Screen tiles only: whether THIS tile currently owns the browser's
  // fullscreen. Tracked off fullscreenchange (Esc exits without us) so the
  // button's label never lies.
  const [fullscreen, setFullscreen] = useState(false);
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
    video.muted = isSelf || screenShare || audio !== "on";
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
  }, [stream, isSelf, screenShare, audio]);

  useEffect(() => {
    if (!screenShare) return;
    const onChange = () => setFullscreen(document.fullscreenElement === figureRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [screenShare]);

  // The reading mode for a text-heavy share (8/11 live test: no in-call tile
  // is big enough): native fullscreen on the whole figure, so the button and
  // caption ride along for the exit path. Permissions-Policy already grants
  // fullscreen=(self).
  function toggleFullscreen() {
    const node = figureRef.current;
    if (!node) return;
    if (document.fullscreenElement === node) void document.exitFullscreen();
    else void node.requestFullscreen().catch(() => {}); // refused = stay a tile
  }

  const hasVideoTrack = stream !== null && stream.getVideoTracks().length > 0;
  const covered = !hasVideoTrack || camOff;
  const reducedMotion = usePrefersReducedMotion();

  // One speaking grammar for every tile (8/4 dress-rehearsal rework): the
  // slim 1px inner brass line — the old self-only "Needle Tick" — now marks
  // any speaking tile. The 3px lamplight bloom, its breathing pulse, and the
  // caption dot are gone (distracting), and the per-word flash is gone with
  // them: the room page latches `speaking` on the most recent speaker and
  // holds it until a DIFFERENT person speaks. A cut own-mic still outranks
  // the outline — you can't be speaking into a cut mic.
  const speakingClass = micCut ? "ring-2 ring-vermilion" : speaking ? "speaking-tick" : "";

  return (
    <figure
      ref={figureRef}
      className={`hairline relative overflow-hidden border bg-inset ${
        fill ? "h-full min-h-0 w-full" : "aspect-video"
      } ${speakingClass}`}
    >
      {stream && (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{ containerType: "size" }}
        >
          {/* Iris Pan (CS-DR-04 2B): the viewport is ALWAYS this same node with
              the SAME shape — a size container parent, one crop child, one
              <video>. Only the child's inline width/height change between the
              full fill and the 930:1008 pane crop (episodeViewportStyle), and
              `iris-viewport` transitions those two cqw/cqh lengths over 420ms
              so the crop eases in and out on the persistent node. Never a
              branch/shape change: that would remount <video> and drop
              srcObject (black tile — the pinned remount invariant). The crop
              child clips the cover-cropped video; the parent centres it so the
              letterbox falls evenly. testid is set only while framing so the
              "no wrapper by default" contract holds. */}
          <div
            data-testid={episodeFrame ? "episode-viewport" : undefined}
            className={`relative max-w-full max-h-full overflow-hidden${reducedMotion ? "" : " iris-viewport"}`}
            style={episodeViewportStyle(episodeFrame)}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className={`h-full w-full ${screenShare ? "object-contain" : "object-cover"} ${mirrored ? "-scale-x-100" : ""} ${covered ? "invisible" : ""} ${audio === "muted" ? "brightness-[.85] saturate-[.6]" : ""}`}
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
      {micCut && (
        <p
          role="status"
          className="kicker absolute left-2 top-2 flex items-center gap-2 bg-vermilion px-2.5 py-1 text-cream"
        >
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-cream" />
          Your Mic Is Cut
        </p>
      )}
      {screenShare && stream && (
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit full screen" : `View ${label} full screen`}
          className="kicker absolute right-2 top-2 border border-brass bg-field/80 px-3 py-1.5 text-ink-soft transition hover:text-signal"
        >
          {fullscreen ? "✕ Exit Full Screen" : "⛶ Full Screen"}
        </button>
      )}
      {!isSelf && !screenShare && stream && audio !== "blocked" && (
        <button
          type="button"
          onClick={() => setAudio(audio === "muted" ? "on" : "muted")}
          // Every remote tile's Mute button read as the same control to a
          // screen reader; the label names which agent it silences.
          aria-label={audio === "muted" ? `Unmute ${label}` : `Mute ${label}`}
          className={`kicker absolute right-2 top-2 border bg-field/80 px-3 py-1.5 transition hover:text-signal ${
            audio === "muted"
              ? "border-vermilion/60 text-vermilion"
              : "border-brass text-ink-soft"
          }`}
        >
          {audio === "muted" ? "◇ Muted — Unmute" : "Mute"}
        </button>
      )}
      {!isSelf && !screenShare && stream && audio === "blocked" && (
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
      {/* Iris Pan slate: a clapper-style flash on the roller's OWN tile when
          the tape starts. One per viewer (their self tile), never duplicated
          onto the partner tile. A pure overlay sibling — the video tree is
          untouched. Suppressed under reduced motion (the flash IS the motion:
          hard cut means it simply does not appear). */}
      {episodeFrame && isSelf && !reducedMotion && (
        <p
          data-testid="slate-stamp"
          role="status"
          className="slate-flash kicker absolute right-2 top-2 flex items-center gap-2 bg-vermilion px-2.5 py-1 text-cream"
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cream" />
          Rolling
        </p>
      )}
      <figcaption className="kicker absolute bottom-2 left-2 bg-field/80 px-2 py-1 text-ink-soft">
        {label}
      </figcaption>
    </figure>
  );
}
