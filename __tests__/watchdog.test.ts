import { describe, it, expect } from "vitest";
import {
  STALL_MS,
  BEACON_SILENCE_MS,
  BEACON_INTERVAL_MS,
  FaultCause,
  Fault,
  Beacon,
  WatchSnapshot,
  evaluate,
  localBeacon,
} from "../lib/podcast/watchdog";

/**
 * Helper to build a healthy snapshot at baseline (no faults)
 */
function healthy(
  now: number,
  overrides?: Partial<WatchSnapshot>
): WatchSnapshot {
  const base: WatchSnapshot = {
    now,
    rolling: true,
    bytes: 1000,
    lastBytesChangeAt: now - 100, // recent
    videoTrack: { readyState: "live", muted: false },
    audioTrack: { readyState: "live", muted: false },
    recorderFault: null,
    remote: {
      lastBeaconAt: now - 500,
      lastBeacon: {
        rolling: true,
        bytes: 800,
        camOk: true,
        micOk: true,
        fault: null,
      },
    },
  };
  return { ...base, ...overrides };
}

describe("watchdog: evaluate() faults", () => {
  const now = 1000;

  it("healthy snapshot returns empty faults", () => {
    const snap = healthy(now);
    expect(evaluate(snap)).toEqual([]);
  });

  it("not rolling returns empty faults regardless of conditions", () => {
    const snap = healthy(now, {
      rolling: false,
      videoTrack: { readyState: "ended", muted: true },
      audioTrack: { readyState: "ended", muted: true },
      lastBytesChangeAt: now - STALL_MS - 1000,
      recorderFault: { cause: "disk-error", detail: "test" },
    });
    expect(evaluate(snap)).toEqual([]);
  });

  it("video track ended while rolling → camera-lost", () => {
    const snap = healthy(now, {
      videoTrack: { readyState: "ended", muted: false },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "camera-lost",
    });
  });

  it("video track muted while rolling → camera-lost", () => {
    const snap = healthy(now, {
      videoTrack: { readyState: "live", muted: true },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "camera-lost",
    });
  });

  it("audio track ended while rolling → mic-lost", () => {
    const snap = healthy(now, {
      audioTrack: { readyState: "ended", muted: false },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "mic-lost",
    });
  });

  it("audio track muted while rolling → mic-lost", () => {
    const snap = healthy(now, {
      audioTrack: { readyState: "live", muted: true },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "mic-lost",
    });
  });

  it("bytes unchanged for > STALL_MS while rolling → encoder-stalled", () => {
    const snap = healthy(now, {
      lastBytesChangeAt: now - STALL_MS - 100,
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "encoder-stalled",
    });
  });

  it("recorderFault disk-error while rolling → local disk-error", () => {
    const snap = healthy(now, {
      recorderFault: { cause: "disk-error", detail: "out of space" },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "disk-error",
    });
  });

  it("recorderFault encoder-error while rolling → local encoder-error", () => {
    const snap = healthy(now, {
      recorderFault: { cause: "encoder-error", detail: "codec failed" },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "local",
      cause: "encoder-error",
    });
  });

  it("remote lastBeacon.fault != null while rolling → partner-fault", () => {
    const snap = healthy(now, {
      remote: {
        lastBeaconAt: now - 100,
        lastBeacon: {
          rolling: true,
          bytes: 800,
          camOk: false, // their camera is down
          micOk: true,
          fault: "camera-lost",
        },
      },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "remote",
      cause: "partner-fault",
    });
  });

  it("remote lastBeacon.rolling === false while we roll → partner-fault", () => {
    const snap = healthy(now, {
      remote: {
        lastBeaconAt: now - 100,
        lastBeacon: {
          rolling: false,
          bytes: 800,
          camOk: true,
          micOk: true,
          fault: null,
        },
      },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "remote",
      cause: "partner-fault",
    });
  });

  it("remote lastBeaconAt stale (> BEACON_SILENCE_MS) while rolling → partner-silent", () => {
    const snap = healthy(now, {
      remote: {
        lastBeaconAt: now - BEACON_SILENCE_MS - 100,
        lastBeacon: {
          rolling: true,
          bytes: 800,
          camOk: true,
          micOk: true,
          fault: null,
        },
      },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "remote",
      cause: "partner-silent",
    });
  });

  it("remote lastBeacon === null while rolling → only partner-silent (not partner-fault)", () => {
    const snap = healthy(now, {
      remote: {
        lastBeaconAt: now - BEACON_SILENCE_MS - 100,
        lastBeacon: null,
      },
    });
    const faults = evaluate(snap);
    expect(faults).toContainEqual({
      side: "remote",
      cause: "partner-silent",
    });
    // should NOT have partner-fault
    expect(
      faults.some((f) => f.side === "remote" && f.cause === "partner-fault")
    ).toBe(false);
  });

  it("multiple simultaneous faults all reported", () => {
    const snap = healthy(now, {
      videoTrack: { readyState: "ended", muted: false }, // camera-lost
      audioTrack: { readyState: "ended", muted: false }, // mic-lost
      lastBytesChangeAt: now - STALL_MS - 100, // encoder-stalled
      remote: {
        lastBeaconAt: now - BEACON_SILENCE_MS - 100,
        lastBeacon: {
          rolling: false, // partner-fault
          bytes: 0,
          camOk: false,
          micOk: false,
          fault: "camera-lost",
        },
      },
    });
    const faults = evaluate(snap);
    expect(faults.length).toBe(5); // camera-lost, mic-lost, encoder-stalled, partner-fault, partner-silent
    expect(faults).toContainEqual({ side: "local", cause: "camera-lost" });
    expect(faults).toContainEqual({ side: "local", cause: "mic-lost" });
    expect(faults).toContainEqual({ side: "local", cause: "encoder-stalled" });
    expect(faults).toContainEqual({ side: "remote", cause: "partner-fault" });
    expect(faults).toContainEqual({ side: "remote", cause: "partner-silent" });
  });
});

describe("watchdog: localBeacon()", () => {
  const now = 1000;

  it("mirrors rolling, bytes from snapshot", () => {
    const snap = healthy(now, {
      rolling: true,
      bytes: 5000,
    });
    const beacon = localBeacon(snap);
    expect(beacon.rolling).toBe(true);
    expect(beacon.bytes).toBe(5000);
  });

  it("camOk = videoTrack live && !muted", () => {
    const snap1 = healthy(now, {
      videoTrack: { readyState: "live", muted: false },
    });
    expect(localBeacon(snap1).camOk).toBe(true);

    const snap2 = healthy(now, {
      videoTrack: { readyState: "ended", muted: false },
    });
    expect(localBeacon(snap2).camOk).toBe(false);

    const snap3 = healthy(now, {
      videoTrack: { readyState: "live", muted: true },
    });
    expect(localBeacon(snap3).camOk).toBe(false);
  });

  it("micOk = audioTrack live && !muted", () => {
    const snap1 = healthy(now, {
      audioTrack: { readyState: "live", muted: false },
    });
    expect(localBeacon(snap1).micOk).toBe(true);

    const snap2 = healthy(now, {
      audioTrack: { readyState: "ended", muted: false },
    });
    expect(localBeacon(snap2).micOk).toBe(false);

    const snap3 = healthy(now, {
      audioTrack: { readyState: "live", muted: true },
    });
    expect(localBeacon(snap3).micOk).toBe(false);
  });

  it("fault = first local fault cause from evaluate, else null", () => {
    const snap1 = healthy(now);
    expect(localBeacon(snap1).fault).toBe(null);

    // single fault
    const snap2 = healthy(now, {
      videoTrack: { readyState: "ended", muted: false },
    });
    expect(localBeacon(snap2).fault).toBe("camera-lost");

    // multiple local faults: should pick first in order
    // order from matrix: camera-lost, mic-lost, encoder-stalled, disk-error/encoder-error
    const snap3 = healthy(now, {
      audioTrack: { readyState: "ended", muted: false }, // mic-lost
      lastBytesChangeAt: now - STALL_MS - 100, // encoder-stalled
    });
    // should return mic-lost since it's earlier than encoder-stalled in evaluate order
    // actually, if both mic-lost AND encoder-stalled occur, we take the first one from evaluate
    const faults = evaluate(snap3);
    expect(faults.length).toBeGreaterThan(0);
    expect(localBeacon(snap3).fault).toBe(faults[0].cause);
  });

  it("localBeacon fault prioritizes first local fault (not remote)", () => {
    const snap = healthy(now, {
      videoTrack: { readyState: "ended", muted: false }, // camera-lost
      remote: {
        lastBeaconAt: now - BEACON_SILENCE_MS - 100,
        lastBeacon: null, // would trigger partner-silent
      },
    });
    const beacon = localBeacon(snap);
    expect(beacon.fault).toBe("camera-lost");
  });
});
