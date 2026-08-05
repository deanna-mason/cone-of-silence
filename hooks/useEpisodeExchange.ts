// hooks/useEpisodeExchange.ts
// Phase 5B Task 11: React glue over the shipped episode-exchange engines
// (lib/podcast/transfer.ts's EpisodeSender/EpisodeReceiver) and the xfer
// port on the call bus (hooks/useCallSession.ts). This hook composes —
// it never re-implements engine logic; every state transition it surfaces
// comes straight from an engine's onPhase/onProgress callback.
//
// CONTROLLER DECISION D5 (deferred twice, ends here): episodeId === takeId.
// Both hosts share the takeId directory name for a recorded take, and the
// exchange's manifest lands inside that same directory — so the wire's
// episodeId is literally this host's lastTakeId. There is no separate
// episode namespace to reconcile.
"use client";

import { useEffect, useRef, useState } from "react";
import type { XferPort } from "@/hooks/useCallSession";
import type { PodcastPanelState } from "@/components/PodcastPanel";
import * as episodeStore from "@/lib/podcast/episodeStore";
import type { SidecarEntry } from "@/lib/podcast/vault";
import {
  EpisodeReceiver,
  EpisodeSender,
  type EpisodeReceiverCallbacks,
  type EpisodeSenderCallbacks,
  type ReceiveProgress,
  type ReceiverPhase,
  type ReceiverStore,
  type SendProgress,
  type SenderPhase,
  type SenderStore,
  type XferLink,
} from "@/lib/podcast/transfer";
import { parseXferFrame } from "@/lib/podcast/xferProtocol";

export type ExchangePanelState =
  | { kind: "xfer-sending"; file: string; sentBytes: number; totalBytes: number; mbps: number; etaS: number | null }
  | {
      kind: "xfer-receiving";
      file: string;
      committedBytes: number;
      totalBytes: number;
      mbps: number;
      etaS: number | null;
      fromCodename: string | null;
    } // canResend: sender side && xfer channel open again
  | { kind: "xfer-interrupted"; direction: "send" | "receive"; canResend: boolean }
  | { kind: "xfer-done"; direction: "send" | "receive"; totalBytes: number }
  | { kind: "xfer-fault"; reason: string };

export interface EpisodeExchange {
  state: ExchangePanelState | null; // null = no exchange in flight or shown
  busy: boolean; // sending or receiving RIGHT NOW → feeds holdRolls
  canSend: boolean; // lastTakeId && exactly one peer && that peer's xfer channel open && no take active && not already delivered
  // The current lastTakeId has already been delivered to the partner this
  // session — the armed card shows a delivered marker instead of re-offering
  // Send (a second send of an all-committed episode streams nothing and
  // lands an instant confusing "0.0 MB filed." no-op). Cleared by recording
  // a fresh take (a new lastTakeId).
  delivered: boolean;
  actions: { send(): void; resend(): void; dismiss(): void };
  debug: { kind: string | null; sentBytes: number; committedBytes: number; totalBytes: number; resumedParts: number | null };
}

export interface EpisodeExchangeArgs {
  enabled: boolean; // authed && in-room && supported (same gate as the take hook)
  xfer: XferPort;
  // Task 6 (5D): the session's derived xfer key (lib/crypto/derive.ts's
  // RoomCryptoKeys.xferKey) — null only for the brief window before
  // useCallSession's async key derivation resolves. Both engines take it as
  // a mandatory constructor dep (no keyless mode any more), so this hook
  // never constructs one without a real key in hand; canSend/the inbound
  // offer path both only fire once the channel is actually open, by which
  // point the session (and therefore this) is never null in practice.
  xferKey: CryptoKey | null;
  peerIds: string[];
  // CONTROLLER RULING D8: the offer's `from` carries the SENDER's OWN
  // codename (not the partner's) — myCodename feeds sender.start();
  // partnerCodename only feeds the receiving copy.
  myCodename: string | null;
  partnerCodename: string | null; // receiving copy only
  lastTakeId: string | null;
  takeActive: boolean; // panel.kind in countdown|rolling|stopping|fault
  // Review fix (Phase 5D round 2, UX): the call session's aggregate cos
  // channel signal (hooks/useCallSession.ts), which mesh.ts now gates on
  // PROVEN peers only (Minor 7). `xferOpen` below tracks the "cos-xfer"
  // channel's raw open/closed lifecycle, which is deliberately NOT
  // proof-gated (Task 5 scope — only message/send content is), so during a
  // 4C rebuild's re-proof window the xfer channel can physically reopen
  // (xferOpen -> true) a beat before the fresh join-proof actually
  // completes, while sendXferTo still correctly refuses. Without this,
  // canSend/canResend would read true for that sub-second window and
  // transfer.ts's callers ignore send()'s boolean return, so pressing SEND
  // would silently drop the offer and park on OFFER_TIMEOUT_MS. `dcOpen`
  // is already proven-gated, so requiring it here closes that window.
  dcOpen: boolean;
}

// ---------------------------------------------------------------------------
// episodeStore adapter — the REAL module, wrapped only so the engines see
// the narrow Sender/ReceiverStore surface they declare. Referencing
// `episodeStore.xxx` at call time (not destructured at import time) means a
// hook test's `vi.mock("@/lib/podcast/episodeStore")` is honored exactly the
// same way a direct import would be.
// ---------------------------------------------------------------------------
const senderStoreAdapter: SenderStore = {
  readSendPlan: (episodeId) => episodeStore.readSendPlan(episodeId),
  openPartReader: (episodeId, name) => episodeStore.openPartReader(episodeId, name),
};
const receiverStoreAdapter: ReceiverStore = {
  scanCommitted: (episodeId, expected) => episodeStore.scanCommitted(episodeId, expected),
  openIncomingPart: (episodeId, entry: SidecarEntry) => episodeStore.openIncomingPart(episodeId, entry),
  writeManifest: (episodeId, remote, from) => episodeStore.writeManifest(episodeId, remote, from),
};

// ---------------------------------------------------------------------------
// MB/s EMA: rate = 0.7*rate + 0.3*(Δbytes/Δt); etaS = remaining/rate, null
// until rate > 0. One tracker per direction, reset whenever that direction
// starts a fresh transfer session (a new offer sent, or a new offer adopted).
// ---------------------------------------------------------------------------
interface RateState {
  rate: number; // bytes/sec, smoothed
  lastBytes: number | null;
  lastAt: number | null;
}
const RATE_IDLE: RateState = { rate: 0, lastBytes: null, lastAt: null };

function sampleRate(prev: RateState, bytes: number, now: number): RateState {
  if (prev.lastBytes === null || prev.lastAt === null) return { rate: prev.rate, lastBytes: bytes, lastAt: now };
  const dtS = (now - prev.lastAt) / 1000;
  if (dtS <= 0) return { rate: prev.rate, lastBytes: bytes, lastAt: now };
  const instant = (bytes - prev.lastBytes) / dtS;
  return { rate: 0.7 * prev.rate + 0.3 * instant, lastBytes: bytes, lastAt: now };
}

interface SenderView {
  phase: SenderPhase;
  file: string;
  sentBytes: number;
  totalBytes: number;
  resumedParts: number;
  mbps: number;
  etaS: number | null;
  faultReason: string | null;
}
const IDLE_SENDER_VIEW: SenderView = {
  phase: "idle",
  file: "",
  sentBytes: 0,
  totalBytes: 0,
  resumedParts: 0,
  mbps: 0,
  etaS: null,
  faultReason: null,
};

interface ReceiverView {
  phase: ReceiverPhase;
  // Local-only: hides a parked/done/fault card the operator dismissed,
  // WITHOUT touching the engine, which is kept alive across dismissal — a
  // re-offer from the partner must still land in the same receiver instance
  // (Task 8 carry-in: a 4C link rebuild resumes the SAME parked receiver).
  dismissed: boolean;
  file: string;
  committedBytes: number;
  totalBytes: number; // PER-PART, straight off ReceiveProgress
  // Whole-episode total for the terminal "done" card, folded in at the
  // moment the phase flips to "done" (see handleReceiverPhase) rather than
  // summed out of the per-part ref during render. Meaningless — and reset to
  // 0 — in every other phase, which is exactly when nothing reads it.
  episodeTotalBytes: number;
  fromCodename: string | null;
  mbps: number;
  etaS: number | null;
  faultReason: string | null;
}
const IDLE_RECEIVER_VIEW: ReceiverView = {
  phase: "idle",
  dismissed: false,
  file: "",
  committedBytes: 0,
  totalBytes: 0,
  episodeTotalBytes: 0,
  fromCodename: null,
  mbps: 0,
  etaS: null,
  faultReason: null,
};

export function useEpisodeExchange(args: EpisodeExchangeArgs): EpisodeExchange {
  const { enabled, xfer, xferKey, peerIds, myCodename, partnerCodename, lastTakeId, takeActive, dcOpen } = args;
  const singlePeerId = peerIds.length === 1 ? peerIds[0] : null;
  // Same `latest` idiom as myCodenameRef etc. below — startSender/
  // createReceiver read the CURRENT key at construction time, not whatever
  // was in scope when the wire-subscription effect closed over it.
  const xferKeyRef = useRef(xferKey);
  // eslint-disable-next-line react-hooks/refs -- `latest` idiom: startSender/createReceiver read the current key at call time, not construction time (see lines 192-194)
  xferKeyRef.current = xferKey;

  // Same `latest` idiom as usePodcastTake.ts: the wire-subscription effect
  // below is built once per (enabled, xfer) and must read the CURRENT
  // myCodename/partnerCodename/lastTakeId at call time, not whatever was in
  // scope when it was constructed.
  const myCodenameRef = useRef(myCodename);
  // eslint-disable-next-line react-hooks/refs -- `latest` idiom: the wire-subscription effect is built once per (enabled, xfer) and must read the current value at call time, not construction time (see lines 199-202)
  myCodenameRef.current = myCodename;
  const partnerCodenameRef = useRef(partnerCodename);
  // eslint-disable-next-line react-hooks/refs -- `latest` idiom: the wire-subscription effect is built once per (enabled, xfer) and must read the current value at call time, not construction time (see lines 199-202)
  partnerCodenameRef.current = partnerCodename;
  const lastTakeIdRef = useRef(lastTakeId);
  // eslint-disable-next-line react-hooks/refs -- `latest` idiom: the wire-subscription effect is built once per (enabled, xfer) and must read the current value at call time, not construction time (see lines 199-202)
  lastTakeIdRef.current = lastTakeId;
  const takeActiveRef = useRef(takeActive);
  // eslint-disable-next-line react-hooks/refs -- `latest` idiom: the wire-subscription effect is built once per (enabled, xfer) and must read the current value at call time, not construction time (see lines 199-202)
  takeActiveRef.current = takeActive;

  const [senderView, setSenderView] = useState<SenderView>(IDLE_SENDER_VIEW);
  const [receiverView, setReceiverView] = useState<ReceiverView>(IDLE_RECEIVER_VIEW);
  // Per-peer, not a single boolean: a single "current peer" flag reset on
  // every peerKey change would forget a SURVIVING peer's already-open
  // channel the moment a third peer transiently joins/leaves ([P1] ->
  // [P1,P2] -> [P1] must not wedge canSend false forever, since P1's
  // channel never actually closed). `xferOpenTick` forces a re-render on
  // every channel-state event; `xferOpen` itself is derived fresh below
  // from the map for whichever peer is CURRENTLY the single peer.
  const xferOpenMapRef = useRef<Map<string, boolean>>(new Map());
  const [, setXferOpenTick] = useState(0);

  const senderRef = useRef<EpisodeSender | null>(null);
  const senderPeerRef = useRef<string | null>(null);
  const senderEpisodeIdRef = useRef<string | null>(null);
  const senderRateRef = useRef<RateState>(RATE_IDLE);
  // The episodeId whose SEND reached "done" — set once delivery completes and
  // kept across the operator dismissing the done card, so `delivered` below
  // stays true for that episode and the armed card never re-offers Send for
  // an already-delivered take. A fresh take (different lastTakeId) makes
  // `delivered` false again on its own; no reset needed here. State rather
  // than a ref: its ONLY write is from the sender's onPhase callback below
  // and its ONLY read is the `delivered` derivation during render, so it is
  // render data, not ref data.
  const [deliveredEpisodeId, setDeliveredEpisodeId] = useState<string | null>(null);

  const receiverRef = useRef<EpisodeReceiver | null>(null);
  const receiverPeerRef = useRef<string | null>(null);
  const receiverRateRef = useRef<RateState>(RATE_IDLE);
  // ReceiveProgress.totalBytes is PER-PART (the engine has no whole-episode
  // total to report — a shipped, accepted asymmetry vs. SendProgress, which
  // IS whole-episode). Tracked here by summing each distinct part name's
  // size as it's first reported, so the "done" card can report a real
  // episode total instead of just the last part's size. Keyed by episodeId
  // (read off the wire offer itself, the only place this hook can learn it
  // early) so a genuinely new episode doesn't inherit a prior one's totals,
  // while a same-episode resume (adopt() rescans, no re-progress for
  // already-committed parts) keeps what it already knows.
  const receiverEpisodeIdRef = useRef<string | null>(null);
  const receiverPartTotalsRef = useRef<Map<string, number>>(new Map());

  function disposeSender(): void {
    senderRef.current?.dispose();
    senderRef.current = null;
    senderPeerRef.current = null;
    senderEpisodeIdRef.current = null;
  }

  function disposeReceiver(): void {
    receiverRef.current?.dispose();
    receiverRef.current = null;
    receiverPeerRef.current = null;
    receiverEpisodeIdRef.current = null;
    receiverPartTotalsRef.current = new Map();
  }

  function handleSenderPhase(phase: SenderPhase, detail?: string): void {
    if (phase === "offering") senderRateRef.current = RATE_IDLE;
    // Delivery reached "done": remember which episode, so the armed card
    // marks it delivered rather than re-offering Send after dismissal.
    if (phase === "done") setDeliveredEpisodeId(senderEpisodeIdRef.current);
    setSenderView((prev) => ({ ...prev, phase, faultReason: phase === "fault" ? (detail ?? "") : null }));
  }

  function handleSenderProgress(p: SendProgress): void {
    const now = Date.now();
    senderRateRef.current = sampleRate(senderRateRef.current, p.sentBytes, now);
    const rate = senderRateRef.current.rate;
    const mbps = rate / 1_000_000;
    const remaining = Math.max(0, p.totalBytes - p.sentBytes);
    const etaS = rate > 0 ? remaining / rate : null;
    setSenderView((prev) => ({
      ...prev,
      file: p.file,
      sentBytes: p.sentBytes,
      totalBytes: p.totalBytes,
      resumedParts: p.resumedParts,
      mbps,
      etaS,
    }));
  }

  function handleReceiverPhase(phase: ReceiverPhase, detail?: string): void {
    if (phase === "receiving") receiverRateRef.current = RATE_IDLE;
    // The whole-episode total for the "done" card, summed HERE (a callback)
    // instead of during render. Sound because transfer.ts only reaches
    // onPhase("done") from finishEpisode(), i.e. strictly after every part
    // has committed and therefore after every onProgress this session was
    // ever going to deliver — the per-part map is complete at this instant.
    // Every path that empties that map (a new episodeId on the wire, a
    // peer-churn disposeReceiver) is immediately followed, in the same
    // synchronous turn, by adopt()'s onPhase("receiving"), so no render can
    // observe a "done" phase against an already-cleared map.
    const episodeTotalBytes =
      phase === "done" ? [...receiverPartTotalsRef.current.values()].reduce((a, b) => a + b, 0) : 0;
    setReceiverView((prev) => ({
      ...prev,
      phase,
      dismissed: false,
      episodeTotalBytes,
      faultReason: phase === "fault" ? (detail ?? "") : null,
    }));
  }

  function handleReceiverProgress(p: ReceiveProgress): void {
    receiverPartTotalsRef.current.set(p.file, p.totalBytes);
    const now = Date.now();
    receiverRateRef.current = sampleRate(receiverRateRef.current, p.committedBytes, now);
    const rate = receiverRateRef.current.rate;
    const mbps = rate / 1_000_000;
    const remaining = Math.max(0, p.totalBytes - p.committedBytes);
    const etaS = rate > 0 ? remaining / rate : null;
    setReceiverView((prev) => ({
      ...prev,
      file: p.file,
      committedBytes: p.committedBytes,
      totalBytes: p.totalBytes,
      fromCodename: p.fromCodename,
      mbps,
      etaS,
    }));
  }

  function makeLink(peerId: string): XferLink {
    return {
      send: (data) => xfer.send(peerId, data),
      bufferedAmount: () => xfer.bufferedAmount(peerId),
    };
  }

  /** ONE EpisodeSender per send()/resend() call — the old one is disposed
   *  first (Task 8 loopback review's confirmed engine-construction model). */
  function startSender(peerId: string, episodeId: string): void {
    // Defensive only (see EpisodeExchangeArgs.xferKey's doc) — canSend
    // already implies dcOpen, which implies the session (and its derived
    // keys) exists, so this null in practice never fires in production.
    const xferKey = xferKeyRef.current;
    if (!xferKey) return;
    disposeSender();
    senderRateRef.current = RATE_IDLE;
    const cb: EpisodeSenderCallbacks = { onPhase: handleSenderPhase, onProgress: handleSenderProgress };
    const sender = new EpisodeSender(peerId, makeLink(peerId), senderStoreAdapter, cb, xferKey);
    senderRef.current = sender;
    senderPeerRef.current = peerId;
    senderEpisodeIdRef.current = episodeId;
    // D8: the offer's `from` is OUR OWN codename — the receiver persists it
    // verbatim as manifest.receivedFrom, so it must name the sender, not
    // the sender's view of the partner.
    sender.start(episodeId, myCodenameRef.current);
  }

  /** ONE EpisodeReceiver, built lazily on the first inbound xfr/offer and
   *  KEPT for the life of this hook (enabled/unmount is the only disposal
   *  path) — a 4C link rebuild keeps the peerId and must resume into this
   *  SAME parked receiver, not a fresh one. */
  function createReceiver(peerId: string): void {
    // Defensive only — see startSender's comment; an offer landing before
    // the session's keys exist has nothing to gate on anyway, so it's simply
    // not adopted (no receiver, no reply) rather than crashing.
    const xferKey = xferKeyRef.current;
    if (!xferKey) return;
    const cb: EpisodeReceiverCallbacks = { onPhase: handleReceiverPhase, onProgress: handleReceiverProgress };
    const receiver = new EpisodeReceiver(peerId, makeLink(peerId), receiverStoreAdapter, cb, xferKey);
    receiverRef.current = receiver;
    receiverPeerRef.current = peerId;
  }

  // ---------------------------------------------------------------------
  // Wire subscriptions.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    const offMessage = xfer.onMessage((peerId, data) => {
      const frame = typeof data === "string" ? parseXferFrame(data) : null;
      // GLOBAL CONSTRAINT ("the transfer never runs during a take"),
      // RECEIVING half — `canSend` above is only the sending half. An offer
      // that lands while THIS host is rolling is dropped outright: not
      // queued, not adopted-then-parked, no receiver even constructed. The
      // far sender's own OFFER_TIMEOUT_MS parks them, which is already the
      // spec's answer for an unanswered offer, and their operator can press
      // SEND again once the take is done. Only the OFFER is gated: an
      // exchange already in flight keeps its remaining frames, since a take
      // can't have started under it (busy feeds holdRolls).
      if (frame && frame.t === "xfr/offer" && takeActiveRef.current) return;
      if (frame && frame.t === "xfr/offer") {
        if (!receiverRef.current) {
          createReceiver(peerId);
        } else if (receiverPeerRef.current !== peerId) {
          // Peer churn, not a 4C link rebuild (which keeps the peerId and
          // never reaches this branch): the bound peer left and a DIFFERENT
          // peer is now offering. The kept receiver belongs to a partner
          // who is gone — rebind fresh rather than silently dropping every
          // frame from the new peer forever.
          disposeReceiver();
          createReceiver(peerId);
        }
      }
      // Each engine's own handleFrame already filters by frame type (a
      // sender ignores xfr/offer/part, a receiver ignores xfr/have/
      // part-committed/fault/done) — safe to forward unconditionally to
      // whichever engine(s) are bound to this peerId.
      if (senderRef.current && senderPeerRef.current === peerId) senderRef.current.handleFrame(peerId, data);
      if (receiverRef.current && receiverPeerRef.current === peerId) {
        if (frame && frame.t === "xfr/offer" && receiverEpisodeIdRef.current !== frame.episodeId) {
          receiverEpisodeIdRef.current = frame.episodeId;
          receiverPartTotalsRef.current = new Map();
        }
        receiverRef.current.handleFrame(peerId, data);
      }
    });
    const offDrain = xfer.onDrain((peerId) => {
      if (senderRef.current && senderPeerRef.current === peerId) senderRef.current.handleDrain();
    });
    // CHANNEL-CLOSED WIRING IS THE ONLY STALL RECOVERY: the engines have no
    // sending-phase timeout by design. A "closed"/"error" xfer channel state
    // MUST reach both engines' handleChannelClosed, or a stalled transfer is
    // unrecoverable short of a page reload. Ordering vs. any aggregate
    // channel-closed signal elsewhere is deliberately not depended on
    // (Task 2 advisory) — this listens only to the per-channel event.
    const offState = xfer.onChannelState((peerId, channel, state) => {
      if (channel !== "xfer") return;
      if (state === "closed" || state === "error") {
        if (senderRef.current && senderPeerRef.current === peerId) senderRef.current.handleChannelClosed();
        if (receiverRef.current && receiverPeerRef.current === peerId) receiverRef.current.handleChannelClosed();
      }
      // Recorded per-peer, unconditionally — a peer not currently "the"
      // single peer still gets its state tracked, so a later swap back to
      // it (or a third peer's transient presence) never has to guess.
      xferOpenMapRef.current.set(peerId, state === "open");
      setXferOpenTick((n) => n + 1);
    });
    return () => {
      offMessage();
      offDrain();
      offState();
      disposeSender();
      disposeReceiver();
      xferOpenMapRef.current = new Map();
      setSenderView(IDLE_SENDER_VIEW);
      setReceiverView(IDLE_RECEIVER_VIEW);
    };
    // Every listener above reads the CURRENT engine refs, not a closed-over
    // render's — safe to build once per (enabled, xfer) identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, xfer]);

  // Derived fresh every render from the per-peer map — no reset-on-churn
  // effect needed (and none should exist: a surviving peer's already-open
  // channel emits no further event, so resetting on every peerKey change
  // would forget it, wedging canSend false through a transient [P1] ->
  // [P1,P2] -> [P1]).
  // eslint-disable-next-line react-hooks/refs -- deliberate ref-held per-peer map re-rendered by the setXferOpenTick pump; the reset-on-churn effect that would let this be state is exactly what must not exist, as it would wedge canSend (see lines 462-466 and 218-224)
  const xferOpen = singlePeerId !== null && (xferOpenMapRef.current.get(singlePeerId) ?? false);

  const sendingBusy = senderView.phase === "offering" || senderView.phase === "sending";
  const receivingBusy = receiverView.phase === "receiving";
  const busy = sendingBusy || receivingBusy;

  // This session already delivered the current take to the partner — hold
  // Send off so a second press can't fire the instant "0.0 MB filed." no-op.
  const delivered = lastTakeId !== null && deliveredEpisodeId === lastTakeId;
  // `dcOpen` (review fix round 2): see EpisodeExchangeArgs's doc — closes the
  // sub-second sendable-but-refused window during a 4C re-proof.
  const canSend = lastTakeId !== null && singlePeerId !== null && xferOpen && dcOpen && !takeActive && !delivered;

  const receiverEffectivePhase: ReceiverPhase | "idle" = receiverView.dismissed ? "idle" : receiverView.phase;

  // Priority when both directions are simultaneously in flight (either host
  // may click Send independently of receiving the other's episode): the
  // outbound card wins. Not exercised by the brief's case list — a judgment
  // call, documented rather than silent.
  let state: ExchangePanelState | null = null;
  switch (senderView.phase) {
    case "offering":
    case "sending":
      state = {
        kind: "xfer-sending",
        file: senderView.file,
        sentBytes: senderView.sentBytes,
        totalBytes: senderView.totalBytes,
        mbps: senderView.mbps,
        etaS: senderView.etaS,
      };
      break;
    case "parked":
      state = {
        kind: "xfer-interrupted",
        direction: "send",
        // Peer-aware, matching resend()'s own guard below: the parked
        // sender's peer must still BE the current single peer, not merely
        // have some peer's channel open — otherwise this button would
        // render live while resend() silently no-ops behind it. `dcOpen`:
        // see EpisodeExchangeArgs's doc — same sendable-but-refused window.
        // eslint-disable-next-line react-hooks/refs -- senderPeerRef cannot be promoted: the wire callbacks built once per (enabled, xfer) read it synchronously (lines 417/427/438) and state would leave them closed over a stale peer; read here so canResend matches resend()'s own guard (see lines 504-508)
        canResend: senderPeerRef.current === singlePeerId && xferOpen && dcOpen,
      };
      break;
    case "done":
      state = { kind: "xfer-done", direction: "send", totalBytes: senderView.totalBytes };
      break;
    case "fault":
      state = { kind: "xfer-fault", reason: senderView.faultReason ?? "" };
      break;
    case "idle":
      break;
  }
  if (state === null) {
    switch (receiverEffectivePhase) {
      case "receiving":
        state = {
          kind: "xfer-receiving",
          file: receiverView.file,
          committedBytes: receiverView.committedBytes,
          totalBytes: receiverView.totalBytes,
          mbps: receiverView.mbps,
          etaS: receiverView.etaS,
          // The engine only reports fromCodename via ReceiveProgress (i.e.
          // not until the first chunk lands) — this hook already knows who
          // the partner is the moment an offer is adopted, so the receiving
          // copy rides THIS arg rather than flashing null while a transfer
          // sits offer-received-but-nothing-streamed-yet. Since D8 (above),
          // this also now AGREES with the wire's own `from` once progress
          // does start, rather than compensating for a wrong wire value.
          fromCodename: partnerCodename,
        };
        break;
      case "parked":
        state = { kind: "xfer-interrupted", direction: "receive", canResend: false };
        break;
      case "done":
        state = {
          kind: "xfer-done",
          direction: "receive",
          totalBytes: receiverView.episodeTotalBytes,
        };
        break;
      case "fault":
        state = { kind: "xfer-fault", reason: receiverView.faultReason ?? "" };
        break;
      case "idle":
        break;
    }
  }

  const debug =
    senderView.phase !== "idle"
      ? {
          kind: senderView.phase,
          sentBytes: senderView.sentBytes,
          committedBytes: 0,
          totalBytes: senderView.totalBytes,
          resumedParts: senderView.resumedParts,
        }
      : receiverView.phase !== "idle"
        ? {
            kind: receiverView.phase,
            sentBytes: 0,
            committedBytes: receiverView.committedBytes,
            totalBytes: receiverView.totalBytes,
            resumedParts: null,
          }
        : { kind: null, sentBytes: 0, committedBytes: 0, totalBytes: 0, resumedParts: null };

  return {
    state,
    busy,
    canSend,
    delivered,
    actions: {
      send: () => {
        if (!canSend || singlePeerId === null || lastTakeId === null) return;
        startSender(singlePeerId, lastTakeId);
      },
      resend: () => {
        // Belt + suspenders, same idiom as usePodcastTake's roll(): the
        // panel already hides Resume Transmission unless canResend, this is
        // the backstop.
        const peerId = senderPeerRef.current;
        const episodeId = senderEpisodeIdRef.current ?? lastTakeId;
        if (
          senderView.phase !== "parked" ||
          peerId === null ||
          // The parked transfer's peer is no longer THE peer (they left,
          // possibly replaced by someone else) — re-offering at a departed
          // peerId would fire into the void and could never be acked.
          // Honest behavior: bail, don't silently rebind to whoever's here
          // now under a resume the operator didn't ask for.
          peerId !== singlePeerId ||
          episodeId === null ||
          !xferOpen ||
          !dcOpen // see EpisodeExchangeArgs's doc — same sendable-but-refused window
        ) {
          return;
        }
        startSender(peerId, episodeId);
      },
      dismiss: () => {
        // Whichever card is actually on screen (same priority as `state`
        // above) is the one Stand Down / File Away clears.
        if (senderView.phase === "parked" || senderView.phase === "done" || senderView.phase === "fault") {
          disposeSender();
          setSenderView(IDLE_SENDER_VIEW);
          return;
        }
        if (receiverView.phase === "parked" || receiverView.phase === "done" || receiverView.phase === "fault") {
          setReceiverView((prev) => ({ ...prev, dismissed: true }));
        }
      },
    },
    debug,
  };
}

/** Pure priority merge — take-in-progress outranks exchange outranks armed. */
export function mergePanel(take: PodcastPanelState, xchg: EpisodeExchange): PodcastPanelState {
  if (take.kind === "countdown" || take.kind === "rolling" || take.kind === "stopping" || take.kind === "fault") {
    return take;
  }
  if (xchg.state !== null) return xchg.state;
  if (take.kind === "armed") return { kind: "armed", canSend: xchg.canSend, delivered: xchg.delivered };
  return take;
}
