"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getSession, type StoredSession } from "@/lib/authApi";
import { listRecordings, StudioApiError, uploadRecording, type RecordingDto } from "@/lib/studioApi";
import RecordingRow from "@/components/RecordingRow";

const ACCEPT = ".mp3,.m4a,.wav,.aac,.flac,.ogg,.webm,.mp4,.mov,.mkv";

export default function StudioPage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);

  const [recordings, setRecordings] = useState<RecordingDto[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSession(getSession());
    setReady(true);
  }, []);

  // Initial fetch once a session is present.
  useEffect(() => {
    if (!ready || !session) return;
    let cancelled = false;
    listRecordings()
      .then((list) => {
        if (!cancelled) setRecordings(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setListError(err instanceof StudioApiError ? err.message : "channel unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ready, session]);

  // Poll every 3s only while something is queued/processing; stop otherwise.
  useEffect(() => {
    if (!session) return;
    const hasPending = recordings.some((r) => r.status === "queued" || r.status === "processing");
    if (!hasPending) return;
    const interval = setInterval(() => {
      listRecordings()
        .then(setRecordings)
        .catch(() => {
          // transient poll failures are silent — next tick retries
        });
    }, 3000);
    return () => clearInterval(interval);
  }, [session, recordings]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    try {
      const rec = await uploadRecording(file, setUploadProgress);
      setRecordings((prev) => [rec, ...prev]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSelectedName(null);
    } catch (err) {
      setUploadError(err instanceof StudioApiError ? err.message : "channel unavailable");
    } finally {
      setUploading(false);
    }
  }

  function handleDeleted(id: string) {
    setRecordings((prev) => prev.filter((r) => r.id !== id));
  }

  if (!ready) return null;

  if (!session) {
    return (
      <section className="hairline mx-auto max-w-lg border bg-inset p-6">
        <p className="kicker text-sienna">Clearance Required</p>
        <h1 className="mt-2 font-display text-4xl tracking-[0.04em] text-ink">
          The Studio Is For Cleared Personnel
        </h1>
        <p className="mt-4 font-body text-ink-soft">
          Log in or register at the Identity Desk to begin submitting recordings for enhancement.
        </p>
        <Link
          href="/account"
          className="kicker mt-6 inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Go to Account →
        </Link>
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <section className="hairline border bg-inset p-6">
        <p className="kicker text-sienna">Development Desk</p>
        <h1 className="mt-2 font-display text-4xl tracking-[0.04em] text-ink">Studio</h1>
        <form className="mt-6 space-y-4" onSubmit={handleUpload}>
          <div>
            <label htmlFor="studio-file" className="kicker block text-ink-soft">
              Select a recording
            </label>
            <input
              id="studio-file"
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              onChange={(e) => setSelectedName(e.target.files?.[0]?.name ?? null)}
              className="sr-only"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`mt-2 w-full border-2 border-dashed px-4 py-6 text-center font-type text-sm transition ${
                selectedName
                  ? "border-brass/60 text-ink"
                  : "border-ink-faint/40 text-ink-soft hover:border-brass hover:text-signal"
              }`}
            >
              {selectedName ? (
                <>
                  <span className="text-brass">✓</span> {selectedName}
                </>
              ) : (
                "Click to choose an audio or video file"
              )}
            </button>
          </div>
          <button
            type="submit"
            disabled={uploading || !selectedName}
            className="kicker w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal disabled:opacity-40"
          >
            {uploading ? `UPLOADING… ${uploadProgress}%` : "Upload for Enhancement"}
          </button>
          {uploading && (
            <div className="h-2 w-full bg-inset">
              <div
                className="h-2 bg-brass transition-[width]"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
          {uploadError && (
            <p role="alert" className="kicker text-vermilion">
              ✕ {uploadError}
            </p>
          )}
        </form>
      </section>

      <section>
        <p className="kicker text-sienna">Library</p>
        {listError && (
          <p role="alert" className="kicker mt-3 text-vermilion">
            ✕ {listError}
          </p>
        )}
        <ul className="mt-4 space-y-4">
          {recordings.map((r) => (
            <RecordingRow key={r.id} recording={r} onDeleted={handleDeleted} />
          ))}
          {recordings.length === 0 && !listError && (
            <li className="hairline border p-6 text-center font-body italic text-ink-soft">
              No recordings yet.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
