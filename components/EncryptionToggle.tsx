"use client";

interface EncryptionToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export default function EncryptionToggle({ enabled, onToggle }: EncryptionToggleProps) {
  return (
    <div className="rounded-2xl border-4 border-slate-900 bg-white p-5 shadow-[6px_6px_0_0_#0f172a]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-extrabold text-slate-900">🔐 Extra secret encryption</p>
          <p className="text-sm text-slate-500">Optional super-private layer on top of the call.</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={enabled}
          className={`rounded-full border-2 border-slate-900 px-5 py-1.5 text-sm font-extrabold shadow-[2px_2px_0_0_#0f172a] transition hover:-translate-y-0.5 ${
            enabled ? "bg-teal-300 text-slate-900" : "bg-slate-100 text-slate-500"
          }`}
        >
          {enabled ? "ON" : "OFF"}
        </button>
      </div>

      {enabled && (
        <p className="mt-4 rounded-xl border-2 border-teal-500 bg-teal-50 p-3 text-sm font-medium text-teal-800">
          🤐 Keys are generated on your device and shared only with the other person.
          The server never sees your keys or your content.
        </p>
      )}
    </div>
  );
}
