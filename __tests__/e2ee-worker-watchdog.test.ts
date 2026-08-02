// __tests__/e2ee-worker-watchdog.test.ts
// Phase 5D (Task 7 review round 3): unit coverage for lib/webrtc/e2ee.worker.ts's
// frame-flow timer — see that file's own module doc for what it's for (a
// pipe whose readable silently never yields any chunk produces neither a
// rejection nor a dropped-frame log; this timer is the one signal that
// catches that) and why the budget/behavior are what they are. The cipher
// itself (encryptFrame/decryptFrame) is already exhaustively covered by
// __tests__/crypto-frame.test.ts — this file drives ONLY the worker's own
// pipe-attach/timer logic.
//
// No mocking of the worker's internals: the module is imported for real (its
// top-level side effects wire `self.onmessage`/`self.onrtctransform`, the
// SAME entry points peer.ts's real postMessage/RTCRtpScriptTransform calls
// use) and driven with genuine WHATWG ReadableStream/WritableStream
// instances — the jsdom environment (this suite's default) provides real
// implementations of both, plus a real `self` and real `crypto.subtle`. Real
// AES-GCM keys come from deriveRoomKeys, same idiom as
// __tests__/crypto-frame.test.ts, so the transform's actual encrypt/decrypt
// call is exercised for real, not stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";

// Must match lib/webrtc/e2ee.worker.ts's own FRAME_FLOW_TIMEOUT_MS. Not
// imported directly — the constant isn't exported (this file's own module
// doc explains why: it's an internal implementation detail of a worker entry
// point with no other consumer) — so it's pinned here instead; a change to
// the real constant without updating this one will surface as this suite's
// "fires once" test timing out waiting for a call that never comes, or the
// "stays silent" test's window closing too early — either way, loudly, not
// silently.
const FRAME_FLOW_TIMEOUT_MS = 15000;

type Frame = { data: ArrayBuffer };

async function testKey(): Promise<CryptoKey> {
  const { secret } = createRoomKeys();
  const { mediaKey } = await deriveRoomKeys(secret);
  return mediaKey;
}

/** A controllable pipe pair — enough shape for the worker's transforms
 *  (which only ever read/write `frame.data`). */
function makePipe(): {
  readable: ReadableStream<Frame>;
  writable: WritableStream<Frame>;
  controller: ReadableStreamDefaultController<Frame>;
  written: ArrayBuffer[];
} {
  let controller!: ReadableStreamDefaultController<Frame>;
  const readable = new ReadableStream<Frame>({
    start(c) {
      controller = c;
    },
  });
  const written: ArrayBuffer[] = [];
  const writable = new WritableStream<Frame>({
    write(chunk) {
      written.push(chunk.data);
    },
  });
  return { readable, writable, controller, written };
}

describe("e2ee.worker.ts frame-flow timer", () => {
  let postMessageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Fresh module state isn't actually required between tests (attachPipe's
    // sawFrame/timer live in a closure per call, not module-level state),
    // but resetModules + a fresh import keeps each test's `self.onmessage`/
    // `self.onrtctransform` wiring unambiguous and independent of import
    // order across the suite.
    vi.resetModules();
    postMessageSpy = vi.spyOn(self, "postMessage").mockImplementation(() => {});
    await import("@/lib/webrtc/e2ee.worker");
  });

  afterEach(() => {
    postMessageSpy.mockRestore();
    vi.useRealTimers();
  });

  function attachViaLegacyMessage(key: CryptoKey, side: "encrypt" | "decrypt") {
    const pipe = makePipe();
    // Mirrors peer.ts's legacy-path postMessage shape exactly (lib/webrtc/
    // peer.ts's attachSenderTransform/attachReceiverTransform, "encoded-
    // streams" branch) — the op field is accepted but not actually checked
    // by scope.onmessage today; included anyway for shape-fidelity.
    (self as unknown as { onmessage: (ev: MessageEvent) => void }).onmessage({
      data: { op: "pipe", key, side, readable: pipe.readable, writable: pipe.writable },
    } as MessageEvent);
    return pipe;
  }

  it("fires exactly once when no frames arrive within the timeout window", async () => {
    const key = await testKey();
    attachViaLegacyMessage(key, "encrypt");

    await vi.advanceTimersByTimeAsync(FRAME_FLOW_TIMEOUT_MS);

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][0]).toMatchObject({
      op: "error",
      detail: expect.stringContaining("encrypt pipe (encoded-streams) produced zero frames"),
    });

    // One-shot: advancing well past the deadline again must not re-fire.
    await vi.advanceTimersByTimeAsync(FRAME_FLOW_TIMEOUT_MS * 2);
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a frame arrives before the deadline, even though the frame is dropped (decrypt fails closed)", async () => {
    // Deliberately a WRONG key on the decrypt side — decryptFrame will fail
    // closed and drop every frame (never enqueued), but sawFrame fires at
    // the TOP of transform(), before that failure — proving the timer
    // watches "did the pipe receive anything", not "did it succeed".
    const wrongKey = await testKey();
    const pipe = makePipe();
    (self as unknown as { onrtctransform: (ev: unknown) => void }).onrtctransform({
      transformer: { options: { key: wrongKey, side: "decrypt" }, readable: pipe.readable, writable: pipe.writable },
    });

    // Frame's data must at least be long enough to hold a 12-byte IV or
    // decryptFrame's own length guard would short-circuit before ever
    // reaching crypto.subtle — 28 bytes is a harmless made-up ciphertext.
    pipe.controller.enqueue({ data: new ArrayBuffer(28) });
    await vi.advanceTimersByTimeAsync(FRAME_FLOW_TIMEOUT_MS);

    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(pipe.written).toHaveLength(0); // confirms the frame really was dropped, not silently mis-tested
  });

  it("does not fire after the pipe is torn down (closed cleanly with zero frames)", async () => {
    const key = await testKey();
    const pipe = attachViaLegacyMessage(key, "encrypt");
    pipe.controller.close(); // e.g. the call ended before any frame ever needed to flow

    // Let pipeTo's promise chain (readable -> transform -> writable) settle
    // and its `.finally` disarm the timer BEFORE the deadline would have hit.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(FRAME_FLOW_TIMEOUT_MS);

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it("clears the timer on an outright pipe failure too — one report, not two", async () => {
    const key = await testKey();
    const pipe = attachViaLegacyMessage(key, "encrypt");
    pipe.controller.error(new Error("boom"));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(FRAME_FLOW_TIMEOUT_MS);

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][0]).toMatchObject({
      op: "error",
      detail: expect.stringContaining("e2ee pipe failed (encrypt)"),
    });
  });

  it("names the side and API in the timeout report — both call sites (legacy postMessage, rtctransform)", async () => {
    const key = await testKey();
    const legacyPipe = makePipe();
    (self as unknown as { onmessage: (ev: MessageEvent) => void }).onmessage({
      data: { op: "pipe", key, side: "decrypt", readable: legacyPipe.readable, writable: legacyPipe.writable },
    } as MessageEvent);
    const scriptPipe = makePipe();
    (self as unknown as { onrtctransform: (ev: unknown) => void }).onrtctransform({
      transformer: { options: { key, side: "encrypt" }, readable: scriptPipe.readable, writable: scriptPipe.writable },
    });

    await vi.advanceTimersByTimeAsync(FRAME_FLOW_TIMEOUT_MS);

    expect(postMessageSpy).toHaveBeenCalledTimes(2);
    const details: string[] = postMessageSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { detail: string }).detail,
    );
    expect(details.some((d: string) => d.includes("decrypt pipe (encoded-streams)"))).toBe(true);
    expect(details.some((d: string) => d.includes("encrypt pipe (script-transform)"))).toBe(true);
  });
});
