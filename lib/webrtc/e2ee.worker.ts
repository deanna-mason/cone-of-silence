// lib/webrtc/e2ee.worker.ts
// Phase 5D: the repo's first worker. One instance per PeerLink (constructed
// and terminated alongside it — see lib/webrtc/peer.ts), running every
// encrypt/decrypt frame transform for that peer off the main thread.
//
// Both Chrome encoded-transform APIs land here, because they hand the
// worker a { readable, writable } pipe in two structurally different ways:
//   - "encoded-streams" (legacy Insertable Streams): the main thread calls
//     `sender.createEncodedStreams()` / `receiver.createEncodedStreams()`
//     itself and posts the resulting streams to this worker as ordinary
//     transferable postMessage payloads.
//   - "script-transform" (RTCRtpScriptTransform): the browser constructs the
//     pipe itself and delivers it to the worker as an `rtctransform` event,
//     with the constructor's second argument riding along as
//     `event.transformer.options`.
// Only one of the two ever actually fires for a given PeerLink (peer.ts only
// drives the API `detectE2eeApi()` picked), but both listeners are wired
// unconditionally — that's simpler and cheaper than teaching this file which
// API is in play.
//
// Wire protocol for the legacy path (peer.ts is the only caller): a pipe is
// set up by a SINGLE message — `{op:"pipe", key, side, readable, writable}`.
// Every field the pipe needs travels together, so there is no ordering
// invariant between messages left for a comment to enforce.
//
// Failure reporting: a pipe that fails (readable/writable torn down under
// us, or an encrypt/decrypt rejection that escapes frameCipher's own
// fail-closed handling) posts `{op:"error", detail}` back to the main
// thread instead of failing silently — peer.ts relays that to
// `PeerLinkOptions.onE2eeFailure`.
//
// Nonce rule (load-bearing — see the plan's Global Constraints): each call
// to attachPipe with side "encrypt" constructs exactly ONE fresh IvState,
// right here, at pipe setup. It is never reused across pipes and never
// persisted/restored — a brand-new PeerLink (every 4C rebuild builds one)
// means a brand-new worker means a brand-new prefix for every pipe, by
// construction.
//
// Frame-flow timer (Task 7 review round 2, production hardening — NOT
// related to lib/podcast/watchdog.ts's fault system; same word, unconnected
// concept, different layer entirely): the failure reporting above only
// covers a pipe that REJECTS — but a `readable` whose underlying source
// silently never yields any chunk produces neither a rejection nor a
// dropped-frame log (frameCipher's fail-closed decrypt only ever runs once
// a frame actually arrives at `transform()`). That is exactly the failure
// mode e2e/phase5d-e2e.js's investigation found live: chrome-headless-
// shell's receiver-side RTCRtpScriptTransform can attach cleanly, report no
// error, and simply never invoke `transform()` for a single frame, forever
// — a silently-dead pipe with no signal anywhere. Each pipe now arms a
// one-shot timer at attach time; if `transform()` has not fired even once
// by FRAME_FLOW_TIMEOUT_MS, it reports through the SAME onE2eeFailure
// funnel as every other e2ee failure (naming the side and which transform
// API is in play), exactly once per pipe (a plain setTimeout, not an
// interval — it can only ever fire once).
//
// Budget (review round 3): this timer is armed at PIPE ATTACH time, which
// for the sender side is inside the PeerLink constructor's addTrack loop —
// BEFORE `onnegotiationneeded` even fires (peer.ts:152-163) — so the budget
// has to cover the full offer -> signaling -> answer -> ICE -> DTLS ->
// first-encoded-frame path, not just "the connection is already up." LAN
// Chrome-to-Chrome is typically 1-3s, but a TURN relay (`?forceTurn=1`,
// symmetric NAT), a cold signaling server, or several links negotiating at
// once (the four-person case) can plausibly run longer — this project's own
// e2e/phase5d-e2e.js observed a third peer's negotiation exceed 20s under
// this sandbox's shared CPU load. Arming the timer instead from the pc's
// "connected" state would need a new worker<->main-thread message this file
// doesn't otherwise have any use for (peer.ts would have to notify the
// worker on every connectionstatechange, and this file would have to track
// per-pipe "armed yet?" state across an event it doesn't currently know
// about) — that's protocol surface to add and maintain for a single timer's
// start point. Raising the budget instead (15s, generous even for a TURN
// allocation) keeps the worker's message shape exactly as small as it's
// always been, at the cost of a slower worst-case detection — an acceptable
// trade for a last-resort signal that only needs to eventually fire, not
// fire fast. If real usage shows 15s is still too tight (or too loose),
// this constant is the only thing that needs to change.
//
// Reporting: a pipe that later fails or closes (for ANY reason — success or
// rejection) clears this timer via `.finally()`, so a call that legitimately
// ends before any frame ever needed to flow (a very short call, hung up
// before video started) does NOT get a spurious "zero frames" report just
// because it happened to end inside the window. A pipe that keeps running
// PAST the window with zero frames still gets exactly one report at the
// deadline; if it also fails later, that second report is new information
// (it outlived the zero-frames call-out and then also died), not a
// duplicate of the first.

import { IvState, decryptFrame, encryptFrame } from "../crypto/frameCipher";
import type { E2eeApi } from "./e2eeSupport";

type Side = "encrypt" | "decrypt";
type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;
const FRAME_FLOW_TIMEOUT_MS = 15000;

type WorkerInMsg = {
  op: "pipe";
  key: CryptoKey;
  side: Side;
  readable: ReadableStream<Frame>;
  writable: WritableStream<Frame>;
};

type WorkerOutMsg = { op: "error"; detail: string };

// TypeScript's DOM lib (this repo has no separate "webworker" lib config —
// see AGENTS.md's Next.js-version caveat, this is genuinely new ground) types
// the bare identifier `self` as `Window`, which is wrong in here but doesn't
// matter: the built-in encoded-transform types (RTCEncodedVideoFrame,
// RTCRtpScriptTransform, ...) already live in the DOM lib, and everything
// this file needs from the worker global scope is re-declared narrowly below
// instead of relying on Window's (mismatched) shape.
interface RTCRtpScriptTransformer {
  readonly options: { key: CryptoKey; side: Side };
  readonly readable: ReadableStream<Frame>;
  readonly writable: WritableStream<Frame>;
}
interface RTCTransformEvent extends Event {
  readonly transformer: RTCRtpScriptTransformer;
}
interface E2eeWorkerScope {
  onmessage: ((ev: MessageEvent<WorkerInMsg>) => void) | null;
  onrtctransform: ((ev: RTCTransformEvent) => void) | null;
  postMessage(message: WorkerOutMsg): void;
}
const scope = self as unknown as E2eeWorkerScope;

/** `onFrame` fires at the TOP of `transform()`, before any await — it marks
 * "the readable actually yielded a chunk", independent of whether the
 * encrypt/decrypt call that follows succeeds. That is precisely what the
 * frame-flow watchdog needs to observe (see the module doc): a frame that
 * later fails to decrypt still proves the pipe itself is alive. */
function makeEncryptTransform(key: CryptoKey, onFrame: () => void): TransformStream<Frame, Frame> {
  const iv = new IvState(); // fresh prefix — see module doc's nonce rule note
  return new TransformStream<Frame, Frame>({
    async transform(frame, controller) {
      onFrame();
      frame.data = await encryptFrame(key, iv, frame.data);
      controller.enqueue(frame);
    },
  });
}

function makeDecryptTransform(key: CryptoKey, onFrame: () => void): TransformStream<Frame, Frame> {
  return new TransformStream<Frame, Frame>({
    async transform(frame, controller) {
      onFrame();
      const plain = await decryptFrame(key, frame.data);
      if (plain === null) return; // fail closed: DROP the frame, never enqueue, never throw
      frame.data = plain;
      controller.enqueue(frame);
    },
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function attachPipe(
  key: CryptoKey,
  side: Side,
  readable: ReadableStream<Frame>,
  writable: WritableStream<Frame>,
  api: E2eeApi,
): void {
  let sawFrame = false;
  // Frame-flow timer (see module doc) — one-shot, per pipe, never repeats.
  const frameFlowTimer = setTimeout(() => {
    if (!sawFrame) {
      scope.postMessage({
        op: "error",
        detail: `e2ee ${side} pipe (${api}) produced zero frames within ${FRAME_FLOW_TIMEOUT_MS}ms — the transform may be silently dead`,
      });
    }
  }, FRAME_FLOW_TIMEOUT_MS);

  const transform =
    side === "encrypt"
      ? makeEncryptTransform(key, () => {
          sawFrame = true;
        })
      : makeDecryptTransform(key, () => {
          sawFrame = true;
        });
  // This pipe runs for the lifetime of the pc/worker. A rejection here (pipe
  // torn down under us, or an encrypt/decrypt call that itself rejects) is
  // surfaced to the main thread rather than swallowed — silent pipe death
  // otherwise means permanent, undiagnosable media loss on that track.
  readable
    .pipeThrough(transform)
    .pipeTo(writable)
    .catch((err) => {
      scope.postMessage({ op: "error", detail: `e2ee pipe failed (${side}): ${errMessage(err)}` });
    })
    .finally(() => clearTimeout(frameFlowTimer)); // ANY settlement (clean close or failure) disarms the timer — see module doc's "Reporting" note
}

scope.onmessage = (ev) => {
  const { key, side, readable, writable } = ev.data;
  attachPipe(key, side, readable, writable, "encoded-streams");
};

scope.onrtctransform = (ev) => {
  const { key, side } = ev.transformer.options;
  attachPipe(key, side, ev.transformer.readable, ev.transformer.writable, "script-transform");
};
