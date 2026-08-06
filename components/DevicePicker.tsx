// components/DevicePicker.tsx
"use client";

interface DevicePickerProps {
  label: string;
  devices: MediaDeviceInfo[];
  /** The device the capture is ACTUALLY on — read off the live track, not the
   *  stored choice. Undefined (or an id no longer in `devices`) means nobody
   *  can say, and the picker must show nothing selected. */
  selectedId?: string;
  onSelect: (deviceId: string) => void;
  /** Additive: force-disable even when devices exist — used in-call to lock
   *  swaps while a podcast take is rolling. Defaults false, so the green-room
   *  callers are unchanged (disabled still follows an empty device list). */
  disabled?: boolean;
}

export default function DevicePicker({ label, devices, selectedId, onSelect, disabled = false }: DevicePickerProps) {
  const id = `picker-${label.toLowerCase().replace(/\W+/g, "-")}`;
  // TRUTH RULE (8/5 re-drill, finding 4). This used to fall back to
  // `devices[0]`, so an unresolvable selection made the picker name whichever
  // camera happened to sort first. Deanna replugged her Continuity Camera, it
  // came back at the head of the list, and the picker claimed it was selected
  // while the capture was still on something else — and because the <select>
  // already held that value, re-picking it fired no change event at all. She
  // had to pick a different camera and come back before the swap took. A
  // picker that names nothing is honest; one that names the wrong device both
  // lies and jams the control.
  const known = selectedId !== undefined && devices.some((d) => d.deviceId === selectedId);
  const value = known ? selectedId : "";

  return (
    <div>
      <label htmlFor={id} className="kicker block text-ink-soft">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled || devices.length === 0}
        className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base text-ink focus:border-brass focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {devices.length === 0 ? (
          <option value="">No equipment detected</option>
        ) : (
          <>
            {!known && (
              // `disabled` so it can never be chosen back into onSelect(""),
              // and deliberately NOT `hidden`: whether a hidden-but-selected
              // option still labels the closed select is browser-dependent,
              // and a picker that goes silently blank is the same class of
              // failure this fix exists to remove.
              <option value="" disabled>
                No {label.toLowerCase()} live — select one
              </option>
            )}
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${label} ${i + 1}`}
              </option>
            ))}
          </>
        )}
      </select>
    </div>
  );
}
