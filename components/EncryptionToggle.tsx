"use client";

interface EncryptionToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export default function EncryptionToggle({ enabled, onToggle }: EncryptionToggleProps) {
  return (
    <section className="hairline border bg-inset p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-display text-2xl tracking-[0.06em] text-ink">
            Signal Scrambler
          </p>
          <p className="mt-1 font-body text-sm italic text-ink-soft">
            An extra cipher layer. Only you hold the keys.
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={enabled}
          className={`stamp shrink-0 rotate-[-4deg] transition ${
            enabled
              ? "bg-spyteal/15 text-spyteal"
              : "text-ink-soft"
          }`}
        >
          {enabled ? "Engaged" : "Standby"}
        </button>
      </div>

      {enabled && (
        <p className="mt-5 border-l-2 border-spyteal bg-field-deep py-3 pl-4 font-type text-sm leading-relaxed text-ink-soft">
          &gt; Keys generated on your device. Shared only with the other agent.
          <br />
          &gt; The Bureau&apos;s servers never see your keys or your words.
        </p>
      )}
    </section>
  );
}
