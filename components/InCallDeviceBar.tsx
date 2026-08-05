// components/InCallDeviceBar.tsx
// In-call equipment controls (S4): swap camera/mic without leaving the call,
// and flip front/back on phones. A disclosure so the collapsed default costs
// one short row — the no-scroll room layout stays intact (Deanna, 2026-07-25).
//
// DESIGN RULING: while a podcast take is rolling, device swaps are LOCKED. The
// record graph holds the raw mic + the exact video track the recorder encodes,
// so a mid-take swap would poison the tape. `locked` mirrors the page's
// podcastLocked (countdown / rolling / fault / stopping).
"use client";

import { useState, useSyncExternalStore } from "react";
import DevicePicker from "@/components/DevicePicker";
import { LensIcon } from "@/components/icons";
import type { MediaDeviceChoice } from "@/lib/webrtc/media";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeCoarsePointer(cb: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(COARSE_POINTER_QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

function getCoarsePointerSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(COARSE_POINTER_QUERY).matches
    : false;
}

// SSR renders the desktop shape and never touches matchMedia; the
// fine-pointer default means no hydration flip (see comment below).
function getCoarsePointerServerSnapshot(): boolean {
  return false;
}

interface InCallDeviceBarProps {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  choice: MediaDeviceChoice;
  hasCamera: boolean;
  /** True while a podcast take is in progress — swaps disabled to protect the tape. */
  locked: boolean;
  onSelectMic: (deviceId: string) => void;
  onSelectCamera: (deviceId: string) => void;
  onFlip: () => void;
}

export default function InCallDeviceBar({
  mics,
  cameras,
  choice,
  hasCamera,
  locked,
  onSelectMic,
  onSelectCamera,
  onFlip,
}: InCallDeviceBarProps) {
  const [open, setOpen] = useState(false);
  // facingMode is a phone concern — show the quick flip only on a coarse
  // pointer. Read via useSyncExternalStore so SSR renders the desktop shape
  // and never touches matchMedia; the fine-pointer default means no
  // hydration flip.
  const isTouch = useSyncExternalStore(
    subscribeCoarsePointer,
    getCoarsePointerSnapshot,
    getCoarsePointerServerSnapshot,
  );

  const showFlip = isTouch && hasCamera;

  return (
    <div className="hairline border bg-inset">
      <div className="flex items-center gap-3 px-4 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="kicker inline-flex items-center gap-2 text-ink-soft transition hover:text-signal"
        >
          <span aria-hidden>◈</span>
          Equipment
          <span aria-hidden className="text-ink-faint">
            {open ? "▾" : "▸"}
          </span>
        </button>
        {locked && (
          <span className="kicker text-sienna">Locked while rolling</span>
        )}
        {showFlip && (
          <button
            type="button"
            disabled={locked}
            onClick={onFlip}
            className="kicker ml-auto inline-flex items-center gap-2 border border-ink-faint/30 px-3 py-1.5 text-ink-soft transition hover:border-brass hover:text-signal disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LensIcon on />
            Flip Camera
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-ink-faint/20 p-4">
          {locked && (
            <p className="kicker mb-3 text-sienna">
              ◈ Locked while rolling — device swaps disabled to protect the tape.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <DevicePicker
              label="Microphone"
              devices={mics}
              selectedId={choice.audioDeviceId ?? mics[0]?.deviceId}
              onSelect={onSelectMic}
              disabled={locked}
            />
            <DevicePicker
              label="Camera"
              devices={cameras}
              selectedId={choice.videoDeviceId ?? cameras[0]?.deviceId}
              onSelect={onSelectCamera}
              disabled={locked}
            />
          </div>
        </div>
      )}
    </div>
  );
}
