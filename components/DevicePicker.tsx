// components/DevicePicker.tsx
"use client";

interface DevicePickerProps {
  label: string;
  devices: MediaDeviceInfo[];
  selectedId?: string;
  onSelect: (deviceId: string) => void;
}

export default function DevicePicker({ label, devices, selectedId, onSelect }: DevicePickerProps) {
  const id = `picker-${label.toLowerCase().replace(/\W+/g, "-")}`;

  return (
    <div>
      <label htmlFor={id} className="kicker block text-ink-soft">
        {label}
      </label>
      <select
        id={id}
        value={selectedId ?? devices[0]?.deviceId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={devices.length === 0}
        className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base text-ink focus:border-brass focus:outline-none"
      >
        {devices.length === 0 ? (
          <option value="">No equipment detected</option>
        ) : (
          devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
