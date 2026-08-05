// components/PodcastPanel.tsx — presentational chrome for podcast mode.
// Every piece of TAKE state arrives via props. The one exception is the
// pre-roll reminder's open/closed flag (2026-08-05): it is ephemeral
// presentation with no meaning outside this component and nothing upstream
// needs to observe it, so lifting it would only widen the hook's surface.
// Sits above the tile grid as a slim row (3rem at rest). Live-telemetry
// states hold that height exactly (ROW) so a take never costs tile space;
// states whose static MESSAGE is the point may grow to a second line rather
// than ellipsize (ROW_WRAP), as may the fault banner. The no-scroll rule owns
// the viewport; this panel is chrome — the reminder is a fixed overlay for
// that reason, and never affects the row's geometry.
"use client";

import { useState } from "react";
import type { Fault, FaultCause } from "@/lib/podcast/watchdog";

export type PodcastPanelState =
  | { kind: "unsupported" }
  | { kind: "not-two"; count: number }
  | { kind: "vault-needed"; permission: "unset" | "prompt" }
  /** Two chairs and a vault, but the data channel to the other chair is down —
   *  a proposal sent now would be dropped, never acked, and never rolled. */
  | { kind: "link-down" }
  | {
      kind: "armed";
      canSend: boolean;
      delivered?: boolean;
      partnerCodename: string | null;
      /** The sendable take was restored from a previous session (reload
       *  recovery) — nothing has rolled in THIS session yet, so the send
       *  affordance must say it re-sends the last take, not imply a fresh
       *  episode exists (8/4 rehearsal feedback). */
      restoredTake?: boolean;
    }
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
  | {
      kind: "xfer-interrupted";
      direction: "send" | "receive";
      canResend: boolean;
      /** The last attempt was refused because the PARTNER's take is still
       *  rolling (xfr/busy) — a different problem from a dropped line, with
       *  a different remedy, so the card says which one it is. */
      partnerRolling?: boolean;
    }
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
  // Retired 2026-08-05 (see watchdog.ts): unreachable from this build, kept
  // so a partner still running the 8/5 build renders as words, not undefined.
  "echo-guard": "RECORDER FAILED",
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
/** The same 3rem shape at rest, but free to grow to a second line rather
 *  than ellipsize. Used by every state whose MESSAGE is the point — an
 *  explanation the operator has to read in full — as opposed to live
 *  telemetry, which keeps the fixed ROW so a take never costs tile height.
 *  The 8/5 drill found the interrupted card reading "Transmission
 *  Interrupted The li…"; the grid below is flex-1/min-h-0, so a wrapped
 *  line costs tile height, never a scrollbar. */
const ROW_WRAP =
  "hairline flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 border bg-inset px-4 py-2";
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

/**
 * The pre-roll reminder (2026-08-05, replaces the per-take headphones
 * declaration).
 *
 * The declaration asked "headphones or open speakers?" every take and gated
 * Roll Tape on the answer. It was withdrawn because the honest answer to
 * "speakers" is nothing: Chrome will not give a second capture of an in-call
 * mic its own echo canceller (measured, see recordGraph.ts), so an
 * open-speakers host records the partner's voice off their own speakers and
 * nothing downstream removes it. A gate that can only ever say "yes, that
 * will be bad" is a toll, not a safeguard — the remedy is a person putting
 * headphones on before the tape rolls, which is what this says.
 *
 * Both lines are things that actually cost a real take:
 *  - 8/4 dress rehearsal: a co-host on open speakers baked ~465ms of echo
 *    into her raw tape. Unrecoverable in post; the take was scrapped.
 *  - 7/30 rehearsal: an incoming call stole the Continuity Camera mid-take.
 *
 * Fixed overlay, not an inline row: the panel is chrome under the no-scroll
 * rule and must never grow the tile grid's budget.
 */
function RollReminder({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="roll-reminder-title"
        className="hairline w-full max-w-md border bg-inset p-6"
      >
        <p className="kicker text-sienna">Before You Roll</p>
        <h2
          id="roll-reminder-title"
          className="mt-2 font-display text-3xl tracking-[0.04em] text-ink"
        >
          Two Things
        </h2>

        <ul className="mt-4 space-y-3 font-body text-ink-soft">
          <li>
            <span className="text-ink">Headphones on — both chairs.</span> Open speakers bleed the
            other voice into your tape, and nothing downstream can take it back out.
          </li>
          <li>
            <span className="text-ink">Phones on Do Not Disturb.</span> An incoming call steals the
            camera mid-take.
          </li>
        </ul>

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onConfirm} className={`${CTA_BUTTON} shrink-0`}>
            Roll It
          </button>
          <button type="button" onClick={onCancel} className={GHOST_BUTTON}>
            Not Yet
          </button>
        </div>
      </div>
    </div>
  );
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
  // The documented exception to this component's props-only rule — see the
  // file header. Declared before the switch so it stays unconditional.
  const [rollReminderOpen, setRollReminderOpen] = useState(false);
  switch (state.kind) {
    case "unsupported":
      return (
        <div className={ROW_WRAP}>
          <p className="kicker shrink-0 text-vermilion">◈ Wrong Equipment</p>
          <p className="min-w-0 flex-1 font-body text-sm text-ink-soft">
            <span className="font-display tracking-[0.04em] text-ink">
              Recording Requires the Bureau Browser
            </span>{" "}
            — Podcast mode needs Chrome on a Mac. Ordinary calls work anywhere.
          </p>
        </div>
      );

    case "not-two":
      return (
        <div className={ROW_WRAP}>
          <p className="kicker shrink-0 text-sienna">◈ Two Chairs Only</p>
          <p className="min-w-0 flex-1 font-body text-sm text-ink-soft">
            The reel rolls for exactly two agents. Presently: {state.count}.
          </p>
        </div>
      );

    case "vault-needed":
      return (
        <div className={ROW_WRAP}>
          <p className="kicker shrink-0 text-sienna">◈ Tape Vault</p>
          <p className="min-w-0 flex-1 font-body text-sm text-ink-soft">
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
        <div className={ROW_WRAP}>
          <p className="kicker shrink-0 text-sienna">◈ Line Down</p>
          <p className="min-w-0 flex-1 font-body text-sm text-ink-soft">
            The tape rolls on both machines or neither. Waiting for the line to the other chair.
          </p>
        </div>
      );

    case "armed": {
      return (
        // ROW_WRAP, not ROW: this row still carries Send + Roll and MUST wrap
        // rather than spill its buttons outside the border — the 8/5 sighting,
        // at max-w-3xl. (It carried the declaration pair too until 8/5, which
        // is what tipped it over in the first place.)
        <div className={ROW_WRAP}>
          <p className="kicker shrink-0 text-sienna">◈ Ready to Roll</p>
          <span className="flex-1" aria-hidden />
          {/* Once this take has been delivered, a static in-theme marker
              (text-brass = static positive) replaces Send Episode — a second
              send of an all-committed episode is an instant "0.0 MB filed."
              no-op. Roll Tape stays: record another take to send again. */}
          {state.delivered ? (
            <p className="kicker shrink-0 text-brass">◈ Episode Delivered</p>
          ) : (
            state.canSend && (
              <button type="button" onClick={onSendEpisode} className={GHOST_BUTTON}>
                {state.restoredTake ? "Send Last Take" : "Send Episode"}
              </button>
            )
          )}
          {/* Roll Tape is no longer gated on anything — it opens the reminder,
              and the reminder rolls. See RollReminder for why the question
              became a reminder. */}
          <button
            type="button"
            onClick={() => setRollReminderOpen(true)}
            className={`${CTA_BUTTON} shrink-0`}
          >
            Roll Tape
          </button>
          {rollReminderOpen && (
            <RollReminder
              onCancel={() => setRollReminderOpen(false)}
              onConfirm={() => {
                setRollReminderOpen(false);
                onRoll();
              }}
            />
          )}
        </div>
      );
    }

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
          {/* The open-speakers marker lived here until 2026-08-05. It went out
              with the declaration that fed it: nobody was answering it
              truthfully under time pressure, and a warning mid-take is too
              late to act on anyway. The reminder now fires before the roll,
              which is the only moment it can change anything. */}
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
            Acknowledge
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
            {/* Progress numbers lead (never ellipsized); the take file name
                is dropped below sm and trails on the desktop line, so a
                width-bound truncate eats the file name, not the numbers —
                the "…transmission t…" bug (8/3). ProgressBar carries progress
                visually regardless. */}
            <p className="min-w-0 flex-1 truncate font-body text-sm text-ink-soft">
              {`${mbNum(state.sentBytes)}/${mbNum(state.totalBytes)} MB · ${state.mbps.toFixed(1)} MB/s · ETA ${eta}`}
              <span className="hidden sm:inline">{` · ${state.file}`}</span>
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
            {/* Same rule as xfer-sending: sender + progress numbers lead, the
                part file name is dropped below sm and trails on desktop. */}
            <p className="min-w-0 flex-1 truncate font-body text-sm text-ink-soft">
              {`${state.fromCodename ?? "Partner"} · ${mbNum(state.committedBytes)}/${mbNum(state.totalBytes)} MB · ETA ${eta}`}
              <span className="hidden sm:inline">{` · ${state.file}`}</span>
            </p>
          </div>
          <ProgressBar pct={pctOf(state.committedBytes, state.totalBytes)} />
        </div>
      );
    }

    case "xfer-interrupted": {
      // A refused resume and a dropped line are different problems with
      // different remedies, so the card names which one it is instead of
      // leaving Resume to no-op silently (both 8/5 drill findings).
      const held = state.partnerRolling === true;
      return (
        <div className={ROW_WRAP}>
          <p className="kicker shrink-0 text-sienna">
            {held ? "◈ Transmission Held" : "◈ Transmission Interrupted"}
          </p>
          <p className="min-w-0 flex-1 font-body text-sm text-ink-soft">
            {held
              ? "The other chair is still rolling tape. Resume once they cut."
              : "The line dropped mid-reel. Committed parts are safe in the vault."}
          </p>
          {state.direction === "send" && state.canResend && (
            <button type="button" onClick={onResendEpisode} className={CTA_BUTTON}>
              Resume Transmission
            </button>
          )}
          <button type="button" onClick={onDismissXfer} className={GHOST_BUTTON}>
            Dismiss
          </button>
        </div>
      );
    }

    case "xfer-done":
      return (
        <div className={ROW}>
          <p className="kicker shrink-0 text-sienna">
            {state.direction === "send" ? "◈ Episode Delivered" : "◈ Episode Received"}
          </p>
          <p className="flex-1 truncate font-body text-sm text-ink-soft">{`${mbNum(state.totalBytes)} MB filed.`}</p>
          <button type="button" onClick={onDismissXfer} className={GHOST_BUTTON}>
            Dismiss
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
            Acknowledge
          </button>
        </div>
      );
    }
  }
}
