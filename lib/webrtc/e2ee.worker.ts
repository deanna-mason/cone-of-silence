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
// Frame-flow watchdog (Task 7 review, production hardening): the failure
// reporting above only covers a pipe that REJECTS — but a `readable` whose
// underlying source silently never yields any chunk produces neither a
// rejection nor a dropped-frame log (frameCipher's fail-closed decrypt only
// ever runs once a frame actually arrives at `transform()`). That is exactly
// the failure mode e2e/phase5d-e2e.js's investigation found live: chrome-
// headless-shell's receiver-side RTCRtpScriptTransform can attach cleanly,
// report no error, and simply never invoke `transform()` for a single frame,
// forever — a silently-dead pipe with no signal anywhere. Each pipe now arms
// a one-shot ~5s timer at attach time; if `transform()` has not fired even
// once by then, it reports through the SAME onE2eeFailure funnel as every
// other e2ee failure (naming the side and which transform API is in play),
// exactly once per pipe (a plain setTimeout, not an interval — it can only
// ever fire once). A pipe that sees at least one frame in time is silent, as
// before; a pipe that later fails outright clears the timer first so the two
// reports never double up for the same pipe.

import { IvState, decryptFrame, encryptFrame } from "../crypto/frameCipher";
import type { E2eeApi } from "./e2eeSupport";

type Side = "encrypt" | "decrypt";
type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;
const FRAME_FLOW_WATCHDOG_MS = 5000;

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
  // Frame-flow watchdog (see module doc) — one-shot, per pipe, never repeats.
  const watchdog = setTimeout(() => {
    if (!sawFrame) {
      scope.postMessage({
        op: "error",
        detail: `e2ee ${side} pipe (${api}) produced zero frames within ${FRAME_FLOW_WATCHDOG_MS}ms — the transform may be silently dead`,
      });
    }
  }, FRAME_FLOW_WATCHDOG_MS);

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
      clearTimeout(watchdog); // the pipe-failure report below supersedes the watchdog's — never double-report the same pipe
      scope.postMessage({ op: "error", detail: `e2ee pipe failed (${side}): ${errMessage(err)}` });
    });
}

scope.onmessage = (ev) => {
  const { key, side, readable, writable } = ev.data;
  attachPipe(key, side, readable, writable, "encoded-streams");
};

scope.onrtctransform = (ev) => {
  const { key, side } = ev.transformer.options;
  attachPipe(key, side, ev.transformer.readable, ev.transformer.writable, "script-transform");
};
