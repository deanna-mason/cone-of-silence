// components/CallControls.tsx
"use client";

import { LensIcon, MicIcon } from "@/components/icons";

interface CallControlsProps {
  micOn: boolean;
  camOn: boolean;
  copied: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onCopyInvite: () => void;
  onLeave: () => void;
  /** Locks the mic/lens toggles only — a mid-take device change would poison
   *  the tape. Copy Invite and Burn & Leave stay live. */
  disabled?: boolean;
  /** Screen sharing — the control renders only where the browser can capture
   *  a screen at all (shareSupported; phones can't). Not caught in the
   *  mid-take lock: the screen never enters the tape. */
  shareSupported?: boolean;
  sharing?: boolean;
  onToggleShare?: () => void;
}

export default function CallControls({
  micOn,
  camOn,
  copied,
  onToggleMic,
  onToggleCam,
  onCopyInvite,
  onLeave,
  disabled = false,
  shareSupported = false,
  sharing = false,
  onToggleShare,
}: CallControlsProps) {
  const toggleClass = (on: boolean) =>
    `kicker inline-flex items-center gap-2 border px-4 py-3 transition disabled:cursor-not-allowed disabled:opacity-50 ${
      on ? "border-brass text-ink" : "border-vermilion/60 text-vermilion"
    }`;

  return (
    <div className="hairline flex flex-wrap items-center gap-3 border bg-inset p-4">
      <button
        type="button"
        aria-pressed={micOn}
        disabled={disabled}
        onClick={onToggleMic}
        className={toggleClass(micOn)}
      >
        <MicIcon on={micOn} />
        {micOn ? "Mic Live" : "Mic Cut"}
      </button>
      <button
        type="button"
        aria-pressed={camOn}
        disabled={disabled}
        onClick={onToggleCam}
        className={toggleClass(camOn)}
      >
        <LensIcon on={camOn} />
        {camOn ? "Lens Open" : "Lens Capped"}
      </button>
      {shareSupported && onToggleShare && (
        // Not toggleClass: its off state is alarm-vermilion ("your mic is
        // cut"), and an untabled screen is the neutral state, not a fault —
        // idle wears Copy Invite's quiet dress, active wears brass.
        <button
          type="button"
          aria-pressed={sharing}
          onClick={onToggleShare}
          className={`kicker border px-4 py-3 transition ${
            sharing
              ? "border-brass text-ink"
              : "border-ink-faint/30 text-ink-soft hover:border-brass hover:text-signal"
          }`}
        >
          {sharing ? "Screen on the Table" : "Table Your Screen"}
        </button>
      )}
      <button
        type="button"
        onClick={onCopyInvite}
        className="kicker border border-ink-faint/30 px-4 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
      >
        {copied ? "Link Secured ✓" : "Copy Invite"}
      </button>
      <button
        type="button"
        onClick={onLeave}
        className="kicker ml-auto bg-vermilion px-5 py-3 text-cream transition hover:bg-vermilion-bright"
      >
        Burn &amp; Leave
      </button>
    </div>
  );
}
