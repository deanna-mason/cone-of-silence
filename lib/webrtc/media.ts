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

/** Whether this browser can capture a screen at all (no mobile Safari/Chrome). */
export function screenShareSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/** Screen Capture spec members TypeScript's DOM lib doesn't declare yet.
 *  Browsers ignore dictionary members and constraints they don't know, so
 *  each one is a no-op where unsupported, never a failure. */
interface ScreenAudioConstraints extends MediaTrackConstraints {
  suppressLocalAudioPlayback?: boolean;
  restrictOwnAudio?: boolean;
}
interface ScreenCaptureOptions extends DisplayMediaStreamOptions {
  audio?: boolean | ScreenAudioConstraints;
  systemAudio?: "include" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
}

/** Audio is ALWAYS requested — whether it actually comes back is the user's
 *  call, made in the browser's own picker ("Share tab audio" / "Share system
 *  audio"), and the platform's (Safari/Firefox and macOS whole-screen offer
 *  none). The caller reads the result off the stream's audio tracks.
 *
 *  - Voice DSP off: echo cancellation, noise suppression and gain control are
 *    tuned for speech and mangle music/video soundtracks.
 *  - suppressLocalAudioPlayback false (the spec default, stated): the sharer
 *    keeps hearing their own tab.
 *  - The call's own audio stays out: restrictOwnAudio drops this document's
 *    playback (every remote voice) from a system-audio capture, and
 *    selfBrowserSurface excludes the Cone tab from the picker — either leak
 *    would send each agent's voice straight back to them. */
export const SCREEN_CAPTURE_OPTIONS: ScreenCaptureOptions = {
  video: true,
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: false,
    restrictOwnAudio: true,
  },
  systemAudio: "include",
  selfBrowserSurface: "exclude",
};

/**
 * Whether a capture's audio could carry the call itself back out. A tab
 * capture ("browser" surface) records only that tab — never this one,
 * selfBrowserSurface keeps the Cone tab out of the picker. A whole-screen or
 * window capture's audio is SYSTEM audio: everything the machine plays,
 * including this tab's playback of every remote voice, unless the browser
 * honored restrictOwnAudio — and the only proof of that is the track's own
 * settings reporting it true (an unsupporting browser silently ignores the
 * constraint). Sending such audio would echo each agent back to themselves.
 *
 * A capture whose video reports no displaySurface at all (a synthetic
 * stream; every browser that can capture screen audio reports it) is not
 * flagged — there is no system mix to loop.
 */
export function screenAudioLoopbackRisk(stream: MediaStream): boolean {
  const audio = stream.getAudioTracks()[0];
  if (!audio) return false;
  const surface = (stream.getVideoTracks()[0]?.getSettings() as { displaySurface?: string } | undefined)
    ?.displaySurface;
  if (surface !== "monitor" && surface !== "window") return false;
  return (audio.getSettings() as { restrictOwnAudio?: boolean }).restrictOwnAudio !== true;
}

/**
 * Acquire a screen capture, or null. Unlike getUserMedia, a NotAllowedError
 * here is the user closing the browser's picker — the normal way to change
 * your mind — so nothing on this path is an error card: a stream, or null.
 * The stream may or may not carry an audio track — see SCREEN_CAPTURE_OPTIONS.
 * Screen audio is live-only: it rides the screen's own stream, never the
 * mic/camera stream the podcast tape is built from.
 */
export async function getScreenStream(): Promise<MediaStream | null> {
  if (!screenShareSupported()) return null;
  try {
    return await navigator.mediaDevices.getDisplayMedia(SCREEN_CAPTURE_OPTIONS);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
      console.error("[cone] getDisplayMedia failed:", err);
    }
    return null;
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
