// lib/studioApi.ts
// Thin client for the studio recordings API. Every call requires a session
// bearer token — callers must be gated on getSession() already being present.

import { API_URL } from "./config";
import { getSession } from "./authApi";

export interface RecordingDto {
  id: string;
  originalName: string;
  sourceExt: string;
  status: "queued" | "processing" | "done" | "error";
  error: string | null;
  createdAt: string;
}

export class StudioApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

function bearer(): string {
  const s = getSession();
  if (!s) throw new StudioApiError(401, "no session");
  return `Bearer ${s.session}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: bearer(),
      },
    });
  } catch {
    throw new StudioApiError(0, "channel unavailable");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new StudioApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function listRecordings(): Promise<RecordingDto[]> {
  const { recordings } = await req<{ recordings: RecordingDto[] }>("/studio/recordings");
  return recordings;
}

export async function deleteRecording(id: string): Promise<void> {
  await req<void>(`/studio/recordings/${id}`, { method: "DELETE" });
}

export function uploadRecording(
  file: File,
  onProgress: (pct: number) => void,
): Promise<RecordingDto> {
  return new Promise((resolve, reject) => {
    let auth: string;
    try {
      auth = bearer();
    } catch (err) {
      reject(err);
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/studio/recordings`);
    xhr.setRequestHeader("Authorization", auth);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      let body: { recording?: RecordingDto; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // fall through to status-based handling below
      }
      if (xhr.status === 201 && body.recording) {
        resolve(body.recording);
      } else {
        reject(new StudioApiError(xhr.status, body.error ?? `request failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new StudioApiError(0, "channel unavailable"));

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export async function fetchArtifact(
  id: string,
  name: "enhanced.m4a" | "waveform.png",
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/studio/recordings/${id}/${name}`, {
      headers: { Authorization: bearer() },
    });
  } catch {
    throw new StudioApiError(0, "channel unavailable");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new StudioApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
