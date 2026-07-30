export const STALL_MS = 3_000;
export const BEACON_SILENCE_MS = 3_000;
export const BEACON_INTERVAL_MS = 1_000;

export type FaultCause =
  | "camera-lost"
  | "mic-lost"
  | "encoder-stalled"
  | "disk-error"
  | "encoder-error"
  | "partner-fault"
  | "partner-silent";

export interface Fault {
  side: "local" | "remote";
  cause: FaultCause;
}

export interface Beacon {
  rolling: boolean;
  bytes: number;
  camOk: boolean;
  micOk: boolean;
  fault: FaultCause | null;
}

export interface WatchSnapshot {
  now: number;
  rolling: boolean;
  bytes: number;
  lastBytesChangeAt: number;
  videoTrack: { readyState: MediaStreamTrackState; muted: boolean };
  audioTrack: { readyState: MediaStreamTrackState; muted: boolean };
  recorderFault: { cause: "disk-error" | "encoder-error"; detail: string } | null;
  remote: { lastBeaconAt: number; lastBeacon: Beacon | null };
}

/**
 * Evaluate snapshot and return all active faults.
 * Matrix rows only apply while rolling. Returns empty array if not rolling or healthy.
 */
export function evaluate(s: WatchSnapshot): Fault[] {
  const faults: Fault[] = [];

  // Only evaluate fault conditions while rolling
  if (!s.rolling) {
    return faults;
  }

  // Row 1: video track ended/muted → camera-lost
  if (s.videoTrack.readyState === "ended" || s.videoTrack.muted) {
    faults.push({ side: "local", cause: "camera-lost" });
  }

  // Row 2: audio track ended/muted → mic-lost
  if (s.audioTrack.readyState === "ended" || s.audioTrack.muted) {
    faults.push({ side: "local", cause: "mic-lost" });
  }

  // Row 3: bytes unchanged for > STALL_MS → encoder-stalled
  if (s.now - s.lastBytesChangeAt > STALL_MS) {
    faults.push({ side: "local", cause: "encoder-stalled" });
  }

  // Row 4: recorderFault present → its cause
  if (s.recorderFault !== null) {
    faults.push({ side: "local", cause: s.recorderFault.cause });
  }

  // Row 5: remote beacon fault != null OR rolling === false while we roll → partner-fault
  // Edge: remote.lastBeacon can be null; don't throw, only check if it exists
  if (s.remote.lastBeacon !== null) {
    if (s.remote.lastBeacon.fault !== null || s.remote.lastBeacon.rolling === false) {
      faults.push({ side: "remote", cause: "partner-fault" });
    }
  }

  // Row 6: remote beacon stale (now - lastBeaconAt > BEACON_SILENCE_MS) → partner-silent
  if (s.now - s.remote.lastBeaconAt > BEACON_SILENCE_MS) {
    faults.push({ side: "remote", cause: "partner-silent" });
  }

  return faults;
}

/**
 * Build the beacon to send this tick.
 * Mirrors rolling/bytes from snapshot, derives camOk/micOk from track state,
 * and carries the first local fault from evaluate (or null if healthy).
 */
export function localBeacon(s: WatchSnapshot): Beacon {
  const camOk = s.videoTrack.readyState === "live" && !s.videoTrack.muted;
  const micOk = s.audioTrack.readyState === "live" && !s.audioTrack.muted;

  // Get first local fault from evaluate, if any
  const faults = evaluate(s);
  const localFault = faults.find((f) => f.side === "local");
  const fault = localFault ? localFault.cause : null;

  return {
    rolling: s.rolling,
    bytes: s.bytes,
    camOk,
    micOk,
    fault,
  };
}
