// components/PodcastPanel.tsx — pure presentational chrome for podcast mode.
// ALL state arrives via props; no hooks, no local state. Sits above the tile
// grid as a slim single row (<=3rem) in every state except the fault banner,
// which may wrap. The no-scroll rule owns the viewport; this panel is chrome.
"use client";

import type { Fault, FaultCause } from "@/lib/podcast/watchdog";

export type PodcastPanelState =
  | { kind: "unsupported" }
  | { kind: "not-two"; count: number }
  | { kind: "vault-needed"; permission: "unset" | "prompt" }
  /** Two chairs and a vault, but the data channel to the other chair is down —
   *  a proposal sent now would be dropped, never acked, and never rolled. */
  | { kind: "link-down" }
  | { kind: "armed"; canSend: boolean }
  | { kind: "countdown"; secondsLeft: number }
  | {
      kind: "rolling";
      elapsedS: number;
      localBytes: number;
      partnerBytes: number;
      partnerCodename: string | null;
    }
  | { kind: "fault"; faults: Fault[]; partnerCodename: string | null }
  | { kind: "stopping" }
  // Phase 5B (Task 11): episode-exchange states. Shapes are structurally
  // identical to hooks/useEpisodeExchange.ts's ExchangePanelState — mergePanel
  // there hands one of these straight through, unmodified, when a transfer
  // is in flight.
  | { kind: "xfer-sending"; file: string; sentBytes: number; totalBytes: number; mbps: number; etaS: number | null }
  | {
      kind: "xfer-receiving";
      file: string;
      committedBytes: number;
      totalBytes: number;
      mbps: number;
      etaS: number | null;
      fromCodename: string | null;
    }
  | { kind: "xfer-interrupted"; direction: "send" | "receive"; canResend: boolean }
  | { kind: "xfer-done"; direction: "send" | "receive"; totalBytes: number }
  | { kind: "xfer-fault"; reason: string };

export interface PodcastPanelProps {
  state: PodcastPanelState;
  onChooseVault(): void;
  onGrantVault(): void;
  onRoll(): void;
  onStop(): void;
  onDismissFault(): void;
  onSendEpisode(): void;
  onResendEpisode(): void;
  onDismissXfer(): void;
}

const CAUSE_COPY: Record<FaultCause, string> = {
  "camera-lost": "CAMERA DROPPED",
  "mic-lost": "MIC DROPPED",
  "encoder-stalled": "RECORDER STALLED",
  "disk-error": "DISK WRITE FAILED",
  "encoder-error": "RECORDER FAILED",
  "partner-fault": "REPORTS A FAULT",
  "partner-silent": "WENT SILENT",
};

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

/** Bare number, one decimal, no unit — the xfer copy spells "MB" once after
 *  a sent/total pair (`12.3/45.6 MB`), not per-number like formatMB above. */
function mbNum(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

const ROW = "hairline flex h-12 items-center gap-3 border bg-inset px-4";
const ROW_BAR = "hairline flex flex-col gap-1.5 border bg-inset px-4 py-2";
const GHOST_BUTTON =
  "kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal";
const CTA_BUTTON = "kicker bg-vermilion px-5 py-2 text-cream transition hover:bg-vermilion-bright";

/** Thin progress bar: inset track + vermilion fill at width: pct%. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-faint/20">
      <div className="h-full bg-vermilion transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

function pctOf(current: number, total: number): number {
  return total > 0 ? Math.min(100, (current / total) * 100) : 0;
}

export default function PodcastPanel({
  state,
  onChooseVault,
  onGrantVault,
  onRoll,
  onStop,
  onDismissFault,
  onSendEpisode,
  onResendEpisode,
  onDismissXfer,
}: PodcastPanelProps) {
  switch (state.kind) {
    case "unsupported":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-vermilion">◈ Wrong Equipment</p>
          <p className="truncate font-body text-sm text-ink-soft">
            <span className="font-display tracking-[0.04em] text-ink">
              Recording Requires the Bureau Browser
            </span>{" "}
            — Podcast mode needs Chrome on a Mac. Ordinary calls work anywhere.
          </p>
        </div>
      );

    case "not-two":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">◈ Two Chairs Only</p>
          <p className="truncate font-body text-sm text-ink-soft">
            The reel rolls for exactly two agents. Presently: {state.count}.
          </p>
        </div>
      );

    case "vault-needed":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">◈ Tape Vault</p>
          <p className="flex-1 truncate font-body text-sm text-ink-soft">
            Choose where the reel is written before the tape can roll.
          </p>
          <button
            type="button"
            onClick={state.permission === "unset" ? onChooseVault : onGrantVault}
            className={GHOST_BUTTON}
          >
            {state.permission === "unset" ? "Choose Tape Vault" : "Open Tape Vault"}
          </button>
        </div>
      );

    case "link-down":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">◈ Line Down</p>
          <p className="truncate font-body text-sm text-ink-soft">
            The tape rolls on both machines or neither. Waiting for the line to the other chair.
          </p>
        </div>
      );

    case "armed":
      return (
        <div className={ROW}>
          <p className="kicker flex-1 text-sienna">◈ Ready to Roll</p>
          {state.canSend && (
            <button type="button" onClick={onSendEpisode} className={GHOST_BUTTON}>
              Send Episode
            </button>
          )}
          <button type="button" onClick={onRoll} className={CTA_BUTTON}>
            Roll Tape
          </button>
        </div>
      );

    case "countdown":
      return (
        <div className={ROW}>
          <p
            aria-live="polite"
            className="w-full text-center font-display text-3xl tracking-[0.08em] text-vermilion"
          >
            {state.secondsLeft}
          </p>
        </div>
      );

    case "rolling":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">◈ Reel Rolling</p>
          <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-vermilion" />
          <p className="kicker shrink-0 text-ink-soft">{mmss(state.elapsedS)}</p>
          <p className="flex-1 truncate font-body text-sm text-ink-soft">
            You {formatMB(state.localBytes)} · {state.partnerCodename ?? "Partner"}{" "}
            {formatMB(state.partnerBytes)}
          </p>
          <button
            type="button"
            onClick={onStop}
            className="kicker border border-vermilion/60 px-4 py-2 text-vermilion transition hover:bg-vermilion hover:text-cream"
          >
            Cut
          </button>
        </div>
      );

    case "fault":
      return (
        <div
          role="alert"
          className="hairline flex flex-wrap items-center gap-3 border bg-vermilion px-4 py-3 text-cream"
        >
          <p className="kicker shrink-0 text-cream">◈ Tape Fault</p>
          <ul className="flex flex-1 flex-wrap gap-x-4 gap-y-1 font-body text-sm">
            {state.faults.map((f, i) => (
              <li key={i}>
                {f.side === "local"
                  ? `YOUR ${CAUSE_COPY[f.cause]}`
                  : // A remote fault names the partner's OWN cause when their
                    // beacon carried one; `partner-fault`'s generic copy is
                    // the fallback for a partner who stopped rolling without
                    // saying why.
                    `${state.partnerCodename ?? "PARTNER"}: ${CAUSE_COPY[f.detail ?? f.cause]}`}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onDismissFault}
            className="kicker shrink-0 border border-cream/50 px-4 py-2 text-cream transition hover:bg-cream/10"
          >
            Stand Down
          </button>
        </div>
      );

    case "stopping":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">◈ Securing Take</p>
          <p className="truncate font-body text-sm text-ink-soft">Cutting the tape…</p>
        </div>
      );

    case "xfer-sending": {
      const eta = state.etaS !== null ? mmss(state.etaS) : "—";
      return (
        <div className={ROW_BAR}>
          <div className="flex items-center gap-3">
            <p className="kicker shrink-0 text-sienna">◈ Transmitting</p>
            <p className="flex-1 truncate font-body text-sm text-ink-soft">
              {`${state.file} · ${mbNum(state.sentBytes)}/${mbNum(state.totalBytes)} MB · ${state.mbps.toFixed(1)} MB/s · ETA ${eta}`}
            </p>
          </div>
          <ProgressBar pct={pctOf(state.sentBytes, state.totalBytes)} />
        </div>
      );
    }

    case "xfer-receiving": {
      const eta = state.etaS !== null ? mmss(state.etaS) : "—";
      return (
        <div className={ROW_BAR}>
          <div className="flex items-center gap-3">
            <p className="kicker shrink-0 text-sienna">◈ Incoming Reel</p>
            <p className="flex-1 truncate font-body text-sm text-ink-soft">
              {`${state.fromCodename ?? "Partner"} transmits ${state.file} · ${mbNum(state.committedBytes)}/${mbNum(state.totalBytes)} MB · ETA ${eta}`}
            </p>
          </div>
          <ProgressBar pct={pctOf(state.committedBytes, state.totalBytes)} />
        </div>
      );
    }

    case "xfer-interrupted":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">◈ Transmission Interrupted</p>
          <p className="flex-1 truncate font-body text-sm text-ink-soft">
            The line dropped mid-reel. Committed parts are safe in the vault.
          </p>
          {state.direction === "send" && state.canResend && (
            <button type="button" onClick={onResendEpisode} className={CTA_BUTTON}>
              Resume Transmission
            </button>
          )}
          <button type="button" onClick={onDismissXfer} className={GHOST_BUTTON}>
            Stand Down
          </button>
        </div>
      );

    case "xfer-done":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">
            {state.direction === "send" ? "◈ Episode Delivered" : "◈ Episode Received"}
          </p>
          <p className="flex-1 truncate font-body text-sm text-ink-soft">{`${mbNum(state.totalBytes)} MB filed.`}</p>
          <button type="button" onClick={onDismissXfer} className={GHOST_BUTTON}>
            File Away
          </button>
        </div>
      );

    case "xfer-fault": {
      const body = state.reason.startsWith("hash-mismatch:")
        ? "A reel arrived damaged and was burned. Resume to send it again."
        : `The transmission broke down: ${state.reason}.`;
      return (
        <div
          role="alert"
          className="hairline flex flex-wrap items-center gap-3 border bg-vermilion px-4 py-3 text-cream"
        >
          <p className="kicker shrink-0 text-cream">◈ Transmission Fault</p>
          <p className="flex-1 font-body text-sm text-cream">{body}</p>
          <button
            type="button"
            onClick={onDismissXfer}
            className="kicker shrink-0 border border-cream/50 px-4 py-2 text-cream transition hover:bg-cream/10"
          >
            Stand Down
          </button>
        </div>
      );
    }
  }
}
