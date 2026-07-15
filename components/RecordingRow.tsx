"use client";

import { useEffect, useState } from "react";
import { deleteRecording, fetchArtifact, StudioApiError, type RecordingDto } from "@/lib/studioApi";

function StatusBadge({ recording }: { recording: RecordingDto }) {
  switch (recording.status) {
    case "queued":
      return <span className="kicker text-ink-soft">IN QUEUE</span>;
    case "processing":
      return <span className="kicker text-brass">DEVELOPING…</span>;
    case "done":
      return <span className="kicker text-brass">READY</span>;
    case "error":
      return (
        <div>
          <span className="kicker text-vermilion">FAILED</span>
          {recording.error && (
            <p className="mt-1 font-body text-sm italic text-vermilion/80">{recording.error}</p>
          )}
        </div>
      );
  }
}

export default function RecordingRow({
  recording,
  onDeleted,
}: {
  recording: RecordingDto;
  onDeleted: (id: string) => void;
}) {
  const [waveformUrl, setWaveformUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [confirmingBurn, setConfirmingBurn] = useState(false);
  const [burnBusy, setBurnBusy] = useState(false);
  const [burnError, setBurnError] = useState<string | null>(null);

  // Waveform loads eagerly once the recording is done.
  useEffect(() => {
    if (recording.status !== "done") return;
    let cancelled = false;
    let url: string | null = null;
    fetchArtifact(recording.id, "waveform.png")
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        url = objectUrl;
        setWaveformUrl(objectUrl);
      })
      .catch(() => {
        // waveform is a nicety — silently skip if it can't be fetched
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [recording.id, recording.status]);

  // Revoke the on-demand audio object URL on unmount / row change.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  async function handleReview() {
    if (reviewBusy || audioUrl) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      setAudioUrl(await fetchArtifact(recording.id, "enhanced.m4a"));
    } catch (err) {
      setReviewError(err instanceof StudioApiError ? err.message : "channel unavailable");
    } finally {
      setReviewBusy(false);
    }
  }

  async function handleBurn() {
    setBurnBusy(true);
    setBurnError(null);
    try {
      await deleteRecording(recording.id);
      onDeleted(recording.id);
    } catch (err) {
      setBurnError(err instanceof StudioApiError ? err.message : "channel unavailable");
      setBurnBusy(false);
      setConfirmingBurn(false);
    }
  }

  const downloadName = recording.originalName.replace(/\.[^.]*$/, "") + "-enhanced.m4a";

  return (
    <li className="hairline border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-type text-base text-ink">{recording.originalName}</p>
          <p className="kicker mt-1 text-ink-soft">
            {new Date(recording.createdAt).toLocaleString()}
          </p>
        </div>
        <StatusBadge recording={recording} />
      </div>

      {recording.status === "done" && (
        <div className="mt-4 space-y-3">
          {waveformUrl && (
            <img src={waveformUrl} alt="waveform" className="w-full" style={{ maxWidth: "100%" }} />
          )}

          {audioUrl ? (
            <div className="flex flex-wrap items-center gap-4">
              <audio controls src={audioUrl} className="max-w-full grow" />
              <a
                href={audioUrl}
                download={downloadName}
                className="kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal"
              >
                Download
              </a>
            </div>
          ) : (
            <button
              type="button"
              disabled={reviewBusy}
              onClick={() => void handleReview()}
              className="kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal disabled:opacity-40"
            >
              {reviewBusy ? "LOADING…" : "Review"}
            </button>
          )}
          {reviewError && (
            <p role="alert" className="kicker text-vermilion">
              ✕ {reviewError}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-4">
        {confirmingBurn ? (
          <button
            type="button"
            disabled={burnBusy}
            onClick={() => void handleBurn()}
            className="kicker text-vermilion transition hover:text-vermilion-bright disabled:opacity-40"
          >
            {burnBusy ? "BURNING…" : "Confirm Burn"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingBurn(true)}
            className="kicker text-ink-soft transition hover:text-vermilion"
          >
            Burn
          </button>
        )}
        {burnError && (
          <p role="alert" className="kicker text-vermilion">
            ✕ {burnError}
          </p>
        )}
      </div>
    </li>
  );
}
