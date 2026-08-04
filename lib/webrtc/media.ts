// lib/webrtc/media.ts
// Typed helpers around getUserMedia/enumerateDevices. Components never call
// navigator.mediaDevices directly — all acquisition and teardown lives here.

export interface MediaDeviceChoice {
  audioDeviceId?: string;
  videoDeviceId?: string;
  // Phone front/back flip: honored only when no explicit videoDeviceId is set
  // (a deviceId names one physical camera, so the two never combine). Requested
  // as *ideal* — a device that can't offer the asked-for facing degrades to
  // whatever it has rather than hard-failing, same philosophy as VIDEO_QUALITY.
  facingMode?: "user" | "environment";
}

export interface DeviceLists {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

export type MediaFailure = "denied" | "no-devices" | "unavailable";

export class MediaError extends Error {
  readonly reason: MediaFailure;

  constructor(reason: MediaFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const DEVICE_KEY = "cos-devices";

// Episodes are YouTube-bound: ask for 1080p30, but only as *ideal* — ideal
// never hard-fails, it degrades gracefully on weak devices. Capture resolution
// drives recorder quality; call encodes self-adapt regardless.
const VIDEO_QUALITY: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};

function toConstraints(choice: MediaDeviceChoice): MediaStreamConstraints {
  const video: MediaTrackConstraints = choice.videoDeviceId
    ? { deviceId: { exact: choice.videoDeviceId }, ...VIDEO_QUALITY }
    : choice.facingMode
      ? { facingMode: { ideal: choice.facingMode }, ...VIDEO_QUALITY }
      : { ...VIDEO_QUALITY };
  return {
    audio: choice.audioDeviceId ? { deviceId: { exact: choice.audioDeviceId } } : true,
    video,
  };
}

function isMissingDevice(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "NotFoundError" || err.name === "OverconstrainedError")
  );
}

function isBusyDevice(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "NotReadableError" || err.name === "AbortError")
  );
}

function toMediaError(err: unknown): MediaError {
  // Users report failures as the card's spy-themed title; keep the real
  // DOMException in the console so remote reports can be diagnosed.
  if (err instanceof DOMException) {
    console.error(`[cone] getUserMedia failed: ${err.name} — ${err.message}`);
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return new MediaError("denied", "Permission to use camera/microphone was denied.");
    }
    if (err.name === "NotFoundError") {
      return new MediaError("no-devices", "No camera or microphone was found.");
    }
  } else {
    console.error("[cone] getUserMedia failed:", err);
  }
  return new MediaError("unavailable", "Camera/microphone could not be started.");
}

/**
 * Acquire the local stream, degrading gracefully:
 * exact requested devices → default devices (only when an explicit choice failed) → mic-only → MediaError.
 * Covers stale stashed device IDs (unplugged gear), busy devices (held by another app), and machines with no camera.
 */
export async function getLocalStream(choice: MediaDeviceChoice = {}): Promise<MediaStream> {
  const hasExplicitChoice = Boolean(choice.audioDeviceId || choice.videoDeviceId);
  try {
    return await navigator.mediaDevices.getUserMedia(toConstraints(choice));
  } catch (err) {
    // A stale (unplugged) or busy (held by another app) chosen device should
    // degrade to defaults, not hard-fail; without an explicit choice, stage 1
    // already asked for defaults, so only a missing device moves us onward.
    const degradable = isMissingDevice(err) || (hasExplicitChoice && isBusyDevice(err));
    if (!degradable) throw toMediaError(err);
  }
  if (hasExplicitChoice) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: { ...VIDEO_QUALITY } });
    } catch (err) {
      if (!isMissingDevice(err)) throw toMediaError(err);
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    throw toMediaError(err);
  }
}

export async function listDevices(): Promise<DeviceLists> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: all.filter((d) => d.kind === "audioinput"),
    cameras: all.filter((d) => d.kind === "videoinput"),
  };
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function stashDeviceChoice(choice: MediaDeviceChoice): void {
  try {
    sessionStorage.setItem(DEVICE_KEY, JSON.stringify(choice));
  } catch {
    // storage unavailable — device choice just won't survive refresh
  }
}

export function readStashedDeviceChoice(): MediaDeviceChoice {
  try {
    const raw = sessionStorage.getItem(DEVICE_KEY);
    if (!raw) return {};
    const val = JSON.parse(raw) as MediaDeviceChoice;
    return {
      audioDeviceId: typeof val.audioDeviceId === "string" ? val.audioDeviceId : undefined,
      videoDeviceId: typeof val.videoDeviceId === "string" ? val.videoDeviceId : undefined,
      facingMode: val.facingMode === "user" || val.facingMode === "environment" ? val.facingMode : undefined,
    };
  } catch {
    return {};
  }
}
