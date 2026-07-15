export type RecordingStatus = "queued" | "processing" | "done" | "error";

export interface Recording {
  id: string;
  userId: string;
  originalName: string;
  sourceExt: string; // ".mp3", ".mp4", …
  status: RecordingStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingStore {
  create(userId: string, originalName: string, sourceExt: string): Promise<Recording>; // status queued
  listByUser(userId: string): Promise<Recording[]>; // newest first
  get(id: string): Promise<Recording | null>; // caller checks userId
  setStatus(id: string, status: RecordingStatus, error?: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  claimNextQueued(): Promise<Recording | null>; // oldest queued → processing, atomically
  recoverStale(): Promise<void>; // boot: processing → queued
}
