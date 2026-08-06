// components/InCallDeviceBar.tsx
// In-call equipment controls (S4): swap camera/mic without leaving the call,
// and flip front/back on phones. A disclosure so the collapsed default costs
// one short row — the no-scroll room layout stays intact (Deanna, 2026-07-25).
//
// DESIGN RULING (amended 2026-08-05): while a podcast take is rolling CLEANLY,
// device swaps are LOCKED — the record graph holds the raw mic and the recorder
// holds the exact video track it encodes, so a swap mid-take would poison the
// tape. Once the take is COMPROMISED the lock lifts: the tape is already hurt,
// and reselecting a device is the only remedy that doesn't require rejoining
// (8/5 re-drill finding 2 — acknowledging the unplugged-camera alarm dropped
// the panel back to "rolling" and re-locked the operator out).
//
// A swap does NOT re-wire the recorder. There is no replaceTrack path: the
// recorder keeps the track it was handed at roll time, and that track is dead
// after the swap. So the video row stays faulted for the rest of the take, and
// it SHOULD — usePodcastTake's watchdog polls the recorded track, not the live
// one, precisely so the panel and the partner's beacon cannot report a healthy
// camera over a tape whose video has stopped. The swap fixes the CALL; only a
// re-take fixes the tape.
//
// `locked` is the page's deviceBarLocked (a take in progress that has not
// faulted), NOT the broader podcastLocked the call controls still use.
"use client";

import { useState, useSyncExternalStore } from "react";
import DevicePicker from "@/components/DevicePicker";
import { LensIcon } from "@/components/icons";

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
  /** The mic/camera the capture is ACTUALLY on (useLocalMedia.liveDeviceIds),
   *  not the stored choice — see the truth rule in DevicePicker. Undefined
   *  means nothing is live and the picker shows nothing selected. */
  liveMicId?: string;
  liveCameraId?: string;
  hasCamera: boolean;
  /** True while a podcast take is in progress AND still clean — swaps disabled
   *  to protect the tape. False once the take is compromised (see the ruling
   *  above): the swap is then the remedy, and the video row stays faulted. */
  locked: boolean;
  onSelectMic: (deviceId: string) => void;
  onSelectCamera: (deviceId: string) => void;
  onFlip: () => void;
}

export default function InCallDeviceBar({
  mics,
  cameras,
  liveMicId,
  liveCameraId,
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
              selectedId={liveMicId}
              onSelect={onSelectMic}
              disabled={locked}
            />
            <DevicePicker
              label="Camera"
              devices={cameras}
              selectedId={liveCameraId}
              onSelect={onSelectCamera}
              disabled={locked}
            />
          </div>
        </div>
      )}
    </div>
  );
}
