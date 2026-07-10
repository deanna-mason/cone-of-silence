// components/CallControls.tsx
"use client";

interface CallControlsProps {
  micOn: boolean;
  camOn: boolean;
  copied: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onCopyInvite: () => void;
  onLeave: () => void;
}

export default function CallControls({
  micOn,
  camOn,
  copied,
  onToggleMic,
  onToggleCam,
  onCopyInvite,
  onLeave,
}: CallControlsProps) {
  const toggleClass = (on: boolean) =>
    `kicker border px-4 py-3 transition ${
      on ? "border-brass text-ink" : "border-vermilion/60 text-vermilion"
    }`;

  return (
    <div className="hairline flex flex-wrap items-center gap-3 border bg-inset p-4">
      <button type="button" aria-pressed={micOn} onClick={onToggleMic} className={toggleClass(micOn)}>
        {micOn ? "Mic Live" : "Mic Cut"}
      </button>
      <button type="button" aria-pressed={camOn} onClick={onToggleCam} className={toggleClass(camOn)}>
        {camOn ? "Lens Open" : "Lens Capped"}
      </button>
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
