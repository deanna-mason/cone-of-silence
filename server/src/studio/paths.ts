import { join } from "node:path";

export const ENHANCED_NAME = "enhanced.m4a";
export const WAVEFORM_NAME = "waveform.png";
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per user, total on disk
export const ALLOWED_EXTS = new Set([
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".webm", ".mp4", ".mov", ".mkv",
]);

export function recordingDir(uploadDir: string, userId: string, recordingId: string): string {
  return join(uploadDir, userId, recordingId);
}

export function sourcePath(dir: string, sourceExt: string): string {
  return join(dir, `source${sourceExt}`);
}
