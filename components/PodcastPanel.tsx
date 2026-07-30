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
  | { kind: "armed" }
  | { kind: "countdown"; secondsLeft: number }
  | {
      kind: "rolling";
      elapsedS: number;
      localBytes: number;
      partnerBytes: number;
      partnerCodename: string | null;
    }
  | { kind: "fault"; faults: Fault[]; partnerCodename: string | null }
  | { kind: "stopping" };

export interface PodcastPanelProps {
  state: PodcastPanelState;
  onChooseVault(): void;
  onGrantVault(): void;
  onRoll(): void;
  onStop(): void;
  onDismissFault(): void;
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

const ROW = "hairline flex h-12 items-center gap-3 border bg-inset px-4";
const GHOST_BUTTON =
  "kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal";
const CTA_BUTTON = "kicker bg-vermilion px-5 py-2 text-cream transition hover:bg-vermilion-bright";

export default function PodcastPanel({
  state,
  onChooseVault,
  onGrantVault,
  onRoll,
  onStop,
  onDismissFault,
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
  }
}
