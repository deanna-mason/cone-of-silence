// lib/webrtc/media.ts
// Typed helpers around getUserMedia/enumerateDevices. Components never call
// navigator.mediaDevices directly — all acquisition and teardown lives here.

export interface MediaDeviceChoice {
  audioDeviceId?: string;
  videoDeviceId?: string;
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

function toConstraints(choice: MediaDeviceChoice): MediaStreamConstraints {
  return {
    audio: choice.audioDeviceId ? { deviceId: { exact: choice.audioDeviceId } } : true,
    video: choice.videoDeviceId ? { deviceId: { exact: choice.videoDeviceId } } : true,
  };
}

function isMissingDevice(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "NotFoundError" || err.name === "OverconstrainedError")
  );
}

function toMediaError(err: unknown): MediaError {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return new MediaError("denied", "Permission to use camera/microphone was denied.");
    }
    if (err.name === "NotFoundError") {
      return new MediaError("no-devices", "No camera or microphone was found.");
    }
  }
  return new MediaError("unavailable", "Camera/microphone could not be started.");
}

/** Acquire the local stream. If the camera is missing, falls back to mic-only. */
export async function getLocalStream(choice: MediaDeviceChoice = {}): Promise<MediaStream> {
  const constraints = toConstraints(choice);
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (!isMissingDevice(err)) throw toMediaError(err);
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
    } catch (audioErr) {
      throw toMediaError(audioErr);
    }
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
    };
  } catch {
    return {};
  }
}
