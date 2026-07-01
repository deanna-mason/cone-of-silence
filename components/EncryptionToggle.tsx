"use client";

interface EncryptionToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export default function EncryptionToggle({ enabled, onToggle }: EncryptionToggleProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-white">Extra end-to-end encryption</p>
          <p className="text-sm text-slate-400">Optional layer on top of the call.</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={enabled}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
            enabled ? "bg-emerald-500 text-slate-950" : "bg-slate-700 text-slate-200"
          }`}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>

      {enabled && (
        <p className="mt-3 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-300">
          Keys are generated on your device and shared only with the other participant.
          The server never sees your keys or your content.
        </p>
      )}
    </div>
  );
}
