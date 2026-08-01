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
// set up by TWO messages sent back-to-back with no other postMessage to this
// worker in between — `{op:"init", key, side}` immediately followed by
// `{op:"pipe", readable, writable}`. postMessage delivery is FIFO, so the
// worker can just remember the most recent uncombined "init" and consume it
// on the next "pipe"; peer.ts is responsible for never interleaving two
// pipes' setup messages (each attach call does both sends synchronously,
// with no other e2ee attach call — and therefore no other postMessage to
// this worker — able to run in between).
//
// Nonce rule (load-bearing — see the plan's Global Constraints): each call
// to attachPipe with side "encrypt" constructs exactly ONE fresh IvState,
// right here, at pipe setup. It is never reused across pipes and never
// persisted/restored — a brand-new PeerLink (every 4C rebuild builds one)
// means a brand-new worker means a brand-new prefix for every pipe, by
// construction.

import { IvState, decryptFrame, encryptFrame } from "../crypto/frameCipher";

type Side = "encrypt" | "decrypt";
type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;

type WorkerInMsg =
  | { op: "init"; key: CryptoKey; side: Side }
  | { op: "pipe"; readable: ReadableStream<Frame>; writable: WritableStream<Frame> };

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
}
const scope = self as unknown as E2eeWorkerScope;

function makeEncryptTransform(key: CryptoKey): TransformStream<Frame, Frame> {
  const iv = new IvState(); // fresh prefix — see module doc's nonce rule note
  return new TransformStream<Frame, Frame>({
    async transform(frame, controller) {
      frame.data = await encryptFrame(key, iv, frame.data);
      controller.enqueue(frame);
    },
  });
}

function makeDecryptTransform(key: CryptoKey): TransformStream<Frame, Frame> {
  return new TransformStream<Frame, Frame>({
    async transform(frame, controller) {
      const plain = await decryptFrame(key, frame.data);
      if (plain === null) return; // fail closed: DROP the frame, never enqueue, never throw
      frame.data = plain;
      controller.enqueue(frame);
    },
  });
}

function attachPipe(key: CryptoKey, side: Side, readable: ReadableStream<Frame>, writable: WritableStream<Frame>): void {
  const transform = side === "encrypt" ? makeEncryptTransform(key) : makeDecryptTransform(key);
  // Fire-and-forget: this pipe runs for the lifetime of the pc/worker. A
  // rejection here (pipe torn down under us) is expected teardown noise, not
  // a crash — mirrors frameCipher's own fail-closed philosophy.
  readable.pipeThrough(transform).pipeTo(writable).catch(() => {});
}

let pendingInit: { key: CryptoKey; side: Side } | null = null;

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.op === "init") {
    pendingInit = { key: msg.key, side: msg.side };
    return;
  }
  // msg.op === "pipe": consumes the immediately-preceding "init" (see the
  // module doc's wire-protocol note on why no correlation id is needed).
  if (!pendingInit) return; // malformed sequence — defensive, should never happen
  const { key, side } = pendingInit;
  pendingInit = null;
  attachPipe(key, side, msg.readable, msg.writable);
};

scope.onrtctransform = (ev) => {
  const { key, side } = ev.transformer.options;
  attachPipe(key, side, ev.transformer.readable, ev.transformer.writable);
};
