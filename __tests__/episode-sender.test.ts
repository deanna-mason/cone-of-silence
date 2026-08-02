// Task 7: EpisodeSender state machine. Fakes only — no real disk, no real
// WebRTC. Frames are driven by hand via handleFrame(), mirroring
// episode-receiver.test.ts's conventions (FakeLink, FakeStore, FakeCallbacks,
// a flush() macrotask boundary for the store's async ops).
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  EpisodeSender,
  type EpisodeSenderCallbacks,
  type SenderPhase,
  type SenderStore,
  type SendProgress,
  type XferLink,
} from "@/lib/podcast/transfer";
import type { PartReader } from "@/lib/podcast/episodeStore";
import type { SidecarEntry } from "@/lib/podcast/vault";
import {
  OFFER_TIMEOUT_MS,
  XFER_CHUNK_BYTES,
  decodeChunk,
  encodeFrame,
  type FilePlan,
  type XferFrame,
} from "@/lib/podcast/xferProtocol";
import { XFER_HIGH_WATER } from "@/lib/webrtc/peer";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";
import { decryptFrame } from "@/lib/crypto/frameCipher";

// Task 6 (5D): EpisodeSender now takes xferKey as a mandatory constructor
// dep (no keyless mode) — every chunk it sends is real AES-GCM ciphertext
// under this key, exercising the actual default (enc=1) path.
let TEST_XFER_KEY: CryptoKey;
beforeAll(async () => {
  const { secret } = createRoomKeys();
  ({ xferKey: TEST_XFER_KEY } = await deriveRoomKeys(secret));
});

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeLink implements XferLink {
  sent: Array<string | ArrayBuffer> = [];
  private buffered = 0;
  private sendOk = true;
  /** When true, every ArrayBuffer send() jumps bufferedAmount() to
   *  XFER_HIGH_WATER as a side effect — the deterministic way to observe
   *  the pump stopping after exactly one chunk per handleDrain() without
   *  racing a real timer or allocating a multi-MB buffer. */
  saturateOnSend = false;

  send(data: string | ArrayBuffer): boolean {
    this.sent.push(data);
    if (this.saturateOnSend && data instanceof ArrayBuffer) this.buffered = XFER_HIGH_WATER;
    return this.sendOk;
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  setBufferedAmount(n: number): void {
    this.buffered = n;
  }
  setSendOk(ok: boolean): void {
    this.sendOk = ok;
  }
  frames(): XferFrame[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as XferFrame);
  }
  chunkSends(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

class FakePartReader implements PartReader {
  size: number;
  reads: Array<{ offset: number; length: number }> = [];
  private bytes: Uint8Array;
  private gate: Promise<void> | null = null;
  private releaseFn: (() => void) | null = null;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.length;
  }

  /** Gates the NEXT single read() call until releaseRead() is called — lets
   *  a test deterministically race handleDrain()/handleChannelClosed()
   *  against an in-flight reader.read(), rather than hoping timing lines up. */
  pauseNextRead(): void {
    this.gate = new Promise((resolve) => {
      this.releaseFn = resolve;
    });
  }
  releaseRead(): void {
    this.releaseFn?.();
    this.gate = null;
    this.releaseFn = null;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads.push({ offset, length });
    if (this.gate) await this.gate;
    return this.bytes.slice(offset, offset + length);
  }
}

class FakeStore implements SenderStore {
  ops: string[] = [];
  plan: FilePlan[] = [];
  planRejects: string | null = null;
  readers = new Map<string, FakePartReader>();
  openRejects = new Set<string>();

  async readSendPlan(episodeId: string): Promise<FilePlan[]> {
    this.ops.push(`plan:${episodeId}`);
    if (this.planRejects) throw new Error(this.planRejects);
    return this.plan;
  }

  async openPartReader(episodeId: string, name: string): Promise<PartReader> {
    this.ops.push(`open:${name}`);
    if (this.openRejects.has(name)) throw new Error(`cannot open ${name}`);
    const reader = this.readers.get(name);
    if (!reader) throw new Error(`no fake reader seeded for ${name}`);
    return reader;
  }
}

class FakeCallbacks implements EpisodeSenderCallbacks {
  phases: Array<{ phase: SenderPhase; detail?: string }> = [];
  progress: SendProgress[] = [];
  onPhase(phase: SenderPhase, detail?: string): void {
    this.phases.push({ phase, detail });
  }
  onProgress(p: SendProgress): void {
    this.progress.push(p);
  }
  lastPhase(): SenderPhase | undefined {
    return this.phases.at(-1)?.phase;
  }
}

/** Drains the sender's async continuations (readSendPlan/openPartReader
 *  promise chains) — a macrotask boundary, matching episode-receiver.test.ts.
 *  Task 6 (5D): pump() now does a REAL crypto.subtle.encrypt() per chunk —
 *  several real ticks (not just one), same reasoning as
 *  episode-receiver.test.ts's flush(). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PEER = "peer-a";
const OTHER_PEER = "peer-b";

function entry(name: string, size: number): SidecarEntry {
  return { name, size, sha256: `sha-${name}` };
}

function haveFrame(episodeId: string, committed: string[]): string {
  return encodeFrame({ t: "xfr/have", v: 1, episodeId, committed });
}
function partCommittedFrame(episodeId: string, name: string): string {
  return encodeFrame({ t: "xfr/part-committed", v: 1, episodeId, name });
}
function faultFrame(episodeId: string, reason: string): string {
  return encodeFrame({ t: "xfr/fault", v: 1, episodeId, reason });
}
function doneFrame(episodeId: string): string {
  return encodeFrame({ t: "xfr/done", v: 1, episodeId });
}

function makeSender(store: FakeStore, cb: FakeCallbacks, link = new FakeLink()) {
  const sender = new EpisodeSender(PEER, link, store, cb, TEST_XFER_KEY);
  return { sender, link };
}

/** Seeds a one-audio-part, one-video-part plan and its readers, then drives
 *  start() -> plan resolves -> xfr/have([]) so the first part is announced
 *  and the pump has begun. Returns the entries + readers for assertions. */
async function startAndOffer(
  sender: EpisodeSender,
  store: FakeStore,
  episodeId: string,
  audioBytes: Uint8Array,
  videoBytes: Uint8Array,
): Promise<{ audio: SidecarEntry; video: SidecarEntry }> {
  const audio = entry("audio.part000", audioBytes.length);
  const video = entry("video.part000", videoBytes.length);
  store.plan = [
    { base: "video", parts: [video] }, // deliberately reversed — sender must still offer audio first
    { base: "audio", parts: [audio] },
  ];
  store.readers.set(audio.name, new FakePartReader(audioBytes));
  store.readers.set(video.name, new FakePartReader(videoBytes));

  sender.start(episodeId, "static-otter");
  await flush();
  return { audio, video };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("EpisodeSender", () => {
  // Fake timers are scoped to just the two tests that need them (below) —
  // flush()'s own setTimeout(0) must stay on REAL timers everywhere else,
  // exactly like episode-receiver.test.ts's flush().

  // -- (a) start -> offer sent, audio first; unanswered -> parked -----------
  it("(a) start() reads the plan and sends xfr/offer with audio listed first, regardless of store order", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const { audio, video } = await startAndOffer(sender, store, "ep-1", new Uint8Array([1, 2]), new Uint8Array([3, 4]));

    expect(store.ops).toEqual(["plan:ep-1"]);
    expect(link.frames()).toEqual([
      {
        t: "xfr/offer",
        v: 1,
        episodeId: "ep-1",
        from: "static-otter",
        files: [
          { base: "audio", parts: [audio] },
          { base: "video", parts: [video] },
        ],
      },
    ]);
    expect(cb.lastPhase()).toBe("offering");
  });

  // These two use REAL fake timers (vi.useFakeTimers, scoped locally — see
  // the note above the describe block) so the offer timer itself is
  // scheduled on the fake clock; vi.advanceTimersByTimeAsync also flushes
  // the readSendPlan() promise chain's microtasks, standing in for flush().
  it("(a) an offer left unanswered for OFFER_TIMEOUT_MS parks", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const cb = new FakeCallbacks();
      const { sender } = makeSender(store, cb);
      store.plan = [
        { base: "audio", parts: [entry("audio.part000", 1)] },
        { base: "video", parts: [entry("video.part000", 1)] },
      ];
      sender.start("ep-1b", "static-otter");
      await vi.advanceTimersByTimeAsync(0);

      expect(cb.lastPhase()).toBe("offering");
      await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS);

      expect(cb.lastPhase()).toBe("parked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(a) xfr/have arriving before the timeout cancels it — no late park", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const cb = new FakeCallbacks();
      const { sender } = makeSender(store, cb);
      store.plan = [
        { base: "audio", parts: [entry("audio.part000", 1)] },
        { base: "video", parts: [entry("video.part000", 1)] },
      ];
      store.readers.set("audio.part000", new FakePartReader(new Uint8Array([1])));
      store.readers.set("video.part000", new FakePartReader(new Uint8Array([2])));
      sender.start("ep-1c", "static-otter");
      await vi.advanceTimersByTimeAsync(0);

      sender.handleFrame(PEER, haveFrame("ep-1c", []));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS);

      expect(cb.phases.some((p) => p.phase === "parked")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // -- (b) have [] -> part announced, all chunks pumped in order -------------
  it("(b) have [] announces the first part and pumps every chunk in order with correct seq/payload slicing", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    // Two full chunks + a partial third, to exercise real chunk-boundary slicing.
    const audioBytes = new Uint8Array(XFER_CHUNK_BYTES * 2 + 5).fill(7);
    const { audio } = await startAndOffer(sender, store, "ep-2", audioBytes, new Uint8Array([9, 9]));

    link.frames(); // (not asserted here — offer already covered by case a)
    sender.handleFrame(PEER, haveFrame("ep-2", []));
    await flush();

    // audio part announced (audio-first ordering applies to the send queue too)
    const partFrames = link.frames().filter((f) => f.t === "xfr/part");
    expect(partFrames).toEqual([{ t: "xfr/part", v: 1, episodeId: "ep-2", name: audio.name, size: audio.size, sha256: audio.sha256, chunks: 3 }]);

    const chunks = link.chunkSends();
    expect(chunks.length).toBe(3);
    const decoded = chunks.map((buf) => decodeChunk(buf)!);
    expect(decoded.map((d) => d.seq)).toEqual([0, 1, 2]);
    // Task 6 (5D): every chunk is now real AES-GCM ciphertext+tag (enc=1) —
    // 16 bytes longer than the plaintext it carries, and NOT the plaintext
    // itself (proving it's actually encrypted, not just labeled as such).
    expect(decoded.every((d) => d.enc === 1)).toBe(true);
    expect(decoded[0]!.payload.length).toBe(XFER_CHUNK_BYTES + 16);
    expect(decoded[1]!.payload.length).toBe(XFER_CHUNK_BYTES + 16);
    expect(decoded[2]!.payload.length).toBe(5 + 16);
    expect(decoded.every((d) => d.iv.some((b) => b !== 0))).toBe(true); // never the 5B zeroed IV
    // decrypting and reassembling recovers the source bytes exactly —
    // stronger than the old plaintext-equality check, since it also proves
    // the sent ciphertext is genuinely decryptable under TEST_XFER_KEY.
    const reassembled = new Uint8Array(audioBytes.length);
    let off = 0;
    for (const d of decoded) {
      const ivAndCt = new Uint8Array(d.iv.length + d.payload.length);
      ivAndCt.set(d.iv, 0);
      ivAndCt.set(d.payload, d.iv.length);
      const plain = await decryptFrame(TEST_XFER_KEY, ivAndCt.buffer);
      expect(plain).not.toBeNull();
      reassembled.set(new Uint8Array(plain!), off);
      off += plain!.byteLength;
    }
    expect(reassembled).toEqual(audioBytes);

    // video part must NOT be announced yet — only after audio's part-committed
    expect(link.frames().filter((f) => f.t === "xfr/part").length).toBe(1);

    link.sent = [];
    sender.handleFrame(PEER, partCommittedFrame("ep-2", audio.name));
    await flush();

    const nextPartFrames = link.frames().filter((f) => f.t === "xfr/part");
    expect(nextPartFrames).toEqual([{ t: "xfr/part", v: 1, episodeId: "ep-2", name: "video.part000", size: 2, sha256: "sha-video.part000", chunks: 1 }]);
  });

  // -- (c) have containing already-committed names -> resumedParts ----------
  it("(c) parts already in have are never announced; resumedParts is the plan-intersection count, not have.length", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const audio = entry("audio.part000", 4);
    const video = entry("video.part000", 4);
    store.plan = [
      { base: "audio", parts: [audio] },
      { base: "video", parts: [video] },
    ];
    store.readers.set(video.name, new FakePartReader(new Uint8Array([1, 2, 3, 4])));
    sender.start("ep-3", "static-otter");
    await flush();

    // have carries the already-committed audio part PLUS a name unknown to
    // the plan (Task 5 advisory: an unknown name must just drop out, never
    // corrupt the count or crash).
    sender.handleFrame(PEER, haveFrame("ep-3", [audio.name, ".DS_Store"]));
    await flush();

    expect(link.frames().filter((f) => f.t === "xfr/part")).toEqual([
      { t: "xfr/part", v: 1, episodeId: "ep-3", name: video.name, size: 4, sha256: video.sha256, chunks: 1 },
    ]);
    expect(cb.progress.length).toBeGreaterThan(0);
    expect(cb.progress[0]!.resumedParts).toBe(1);
    expect(cb.progress[0]!.totalBytes).toBe(8); // both parts' sizes, resumed or not
    expect(cb.progress[0]!.sentBytes).toBe(4); // baseSentBytes (resumed audio) + 0 pumped so far
  });

  // -- (d) backpressure: pump stops at high water, resumes on handleDrain ---
  it("(d) pump stops once bufferedAmount reaches XFER_HIGH_WATER and resumes one chunk at a time on handleDrain", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    link.saturateOnSend = true;
    const audioBytes = new Uint8Array(XFER_CHUNK_BYTES * 2 + 1).fill(3); // 3 chunks
    await startAndOffer(sender, store, "ep-4", audioBytes, new Uint8Array([1]));

    sender.handleFrame(PEER, haveFrame("ep-4", []));
    await flush();
    expect(link.chunkSends().length).toBe(1); // stopped after exactly one chunk (saturated on send)

    link.setBufferedAmount(0);
    sender.handleDrain();
    await flush();
    expect(link.chunkSends().length).toBe(2);

    link.setBufferedAmount(0);
    sender.handleDrain();
    await flush();
    expect(link.chunkSends().length).toBe(3); // last chunk — part fully pumped, now awaiting part-committed

    // no further chunks appear even if drained again — the part is complete
    link.setBufferedAmount(0);
    sender.handleDrain();
    await flush();
    expect(link.chunkSends().length).toBe(3);
  });

  it("pump is re-entrancy-safe: a handleDrain during an in-flight reader.read() does not issue a second concurrent read", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const audio = entry("audio.part000", 4);
    store.plan = [{ base: "audio", parts: [audio] }, { base: "video", parts: [] }];
    const reader = new FakePartReader(new Uint8Array([1, 2, 3, 4]));
    store.readers.set(audio.name, reader);
    reader.pauseNextRead(); // gate the first (only) chunk's read

    sender.start("ep-5", "static-otter");
    await flush();
    sender.handleFrame(PEER, haveFrame("ep-5", []));
    await flush(); // xfr/part sent; pump() called; its read() is now gated

    expect(reader.reads.length).toBe(1);
    expect(link.chunkSends().length).toBe(0);

    sender.handleDrain(); // fires while the read is still pending
    await flush();

    // the guard means handleDrain's pump() call was a no-op — no second read
    expect(reader.reads.length).toBe(1);
    expect(link.chunkSends().length).toBe(0);

    reader.releaseRead();
    await flush();
    expect(link.chunkSends().length).toBe(1); // sent exactly once, not duplicated
  });

  // -- (e) send() false -> parked; handleChannelClosed mid-pump -> parked ---
  it("(e) link.send() returning false parks — the channel died between events", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    await startAndOffer(sender, store, "ep-6", new Uint8Array([1, 2]), new Uint8Array([3]));
    link.setSendOk(false);

    sender.handleFrame(PEER, haveFrame("ep-6", []));
    await flush();

    expect(cb.lastPhase()).toBe("parked");
  });

  it("(e) handleChannelClosed mid-pump parks; a read that resolves after the park sends nothing further", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const audio = entry("audio.part000", 4);
    store.plan = [{ base: "audio", parts: [audio] }, { base: "video", parts: [] }];
    const reader = new FakePartReader(new Uint8Array([1, 2, 3, 4]));
    store.readers.set(audio.name, reader);
    reader.pauseNextRead();

    sender.start("ep-7", "static-otter");
    await flush();
    sender.handleFrame(PEER, haveFrame("ep-7", []));
    await flush(); // pump() blocked mid-read

    sender.handleChannelClosed();
    expect(cb.lastPhase()).toBe("parked");

    reader.releaseRead();
    await flush();

    expect(link.chunkSends().length).toBe(0); // the superseded continuation sent nothing
    expect(cb.lastPhase()).toBe("parked"); // never pulled back to sending
  });

  it("(e) handleChannelClosed while idle (never started) is a no-op", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender } = makeSender(store, cb);
    sender.handleChannelClosed();
    await flush();
    expect(cb.phases).toEqual([]);
  });

  // -- review fix round: park()/fault() must supersede pending async
  // continuations from the SAME synchronous call, not just a future start()
  // (findings #1's three traces) --------------------------------------------
  it("(e) handleChannelClosed right after start() (offering, readSendPlan still pending) parks immediately; the plan resolving afterward sends no xfr/offer and arms no timeout", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    store.plan = [
      { base: "audio", parts: [entry("audio.part000", 1)] },
      { base: "video", parts: [entry("video.part000", 1)] },
    ];

    sender.start("ep-park-race-a", "static-otter");
    expect(cb.lastPhase()).toBe("offering");

    // races the still-pending readSendPlan().then() — the .then callbacks
    // are always deferred to a microtask, so this synchronously wins the race
    sender.handleChannelClosed();
    expect(cb.lastPhase()).toBe("parked");

    await flush();

    expect(link.frames().some((f) => f.t === "xfr/offer")).toBe(false); // a live peer's have reply would otherwise be dropped on the floor
    expect(cb.lastPhase()).toBe("parked");
    expect(cb.phases).toEqual([
      { phase: "offering", detail: undefined },
      { phase: "parked", detail: undefined },
    ]); // no phantom offer-timeout park layered on top
  });

  it("handleChannelClosed right after start() suppresses a subsequently-rejecting readSendPlan — no fault-after-park, no xfr/fault on the dead channel", async () => {
    const store = new FakeStore();
    store.planRejects = "sidecar missing";
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);

    sender.start("ep-park-race-b", "static-otter");
    expect(cb.lastPhase()).toBe("offering");

    sender.handleChannelClosed();
    expect(cb.lastPhase()).toBe("parked");

    await flush();

    expect(cb.lastPhase()).toBe("parked"); // NOT overwritten to fault by the late rejection
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(false);
  });

  it("handleChannelClosed right after an xfr/have (sending, openPartReader still pending and about to reject) suppresses the fault — stays parked, no xfr/fault", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const audio = entry("audio.part000", 4);
    store.plan = [{ base: "audio", parts: [audio] }, { base: "video", parts: [] }];
    store.openRejects.add(audio.name);

    sender.start("ep-park-race-c", "static-otter");
    await flush(); // plan resolves, offer sent, phase offering

    sender.handleFrame(PEER, haveFrame("ep-park-race-c", [])); // -> onHave (sending) -> announceNextPart -> openPartReader pending
    // races the still-unsettled rejection — synchronous, before any microtask runs
    sender.handleChannelClosed();
    expect(cb.lastPhase()).toBe("parked");

    link.sent = [];
    await flush(); // let the openPartReader rejection's catch continuation run

    expect(cb.lastPhase()).toBe("parked"); // NOT overwritten to fault (the success path already guarded phase; the error path didn't)
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(false);
  });

  // -- review fix round: malformed-body validation must be gated on phase
  // FIRST (finding #2) — a stray garbage frame after done/fault must never
  // un-complete a finished transfer or fault back to an already-done peer --
  it("a malformed xfr/have arriving AFTER done is ignored — a garbage frame can't un-complete a finished transfer", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const { audio } = await startAndOffer(sender, store, "ep-done-garbage-1", new Uint8Array([1]), new Uint8Array([2]));
    sender.handleFrame(PEER, haveFrame("ep-done-garbage-1", []));
    await flush();
    sender.handleFrame(PEER, partCommittedFrame("ep-done-garbage-1", audio.name));
    await flush();
    sender.handleFrame(PEER, partCommittedFrame("ep-done-garbage-1", "video.part000"));
    await flush();
    sender.handleFrame(PEER, doneFrame("ep-done-garbage-1"));
    await flush();
    expect(cb.lastPhase()).toBe("done");
    link.sent = [];

    // a garbage `have` (committed not an array) lands late, after done
    sender.handleFrame(PEER, JSON.stringify({ t: "xfr/have", v: 1, episodeId: "ep-done-garbage-1" }));
    await flush();

    expect(cb.lastPhase()).toBe("done"); // not un-completed to fault
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(false); // no fault sent to a peer that already wrote its manifest
  });

  it("a malformed xfr/part-committed arriving AFTER done is ignored the same way", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const { audio } = await startAndOffer(sender, store, "ep-done-garbage-2", new Uint8Array([1]), new Uint8Array([2]));
    sender.handleFrame(PEER, haveFrame("ep-done-garbage-2", []));
    await flush();
    sender.handleFrame(PEER, partCommittedFrame("ep-done-garbage-2", audio.name));
    await flush();
    sender.handleFrame(PEER, partCommittedFrame("ep-done-garbage-2", "video.part000"));
    await flush();
    sender.handleFrame(PEER, doneFrame("ep-done-garbage-2"));
    await flush();
    expect(cb.lastPhase()).toBe("done");
    link.sent = [];

    // a garbage `part-committed` (name missing) lands late, after done
    sender.handleFrame(PEER, JSON.stringify({ t: "xfr/part-committed", v: 1, episodeId: "ep-done-garbage-2" }));
    await flush();

    expect(cb.lastPhase()).toBe("done");
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(false);
  });

  // -- (f) xfr/fault -> fault phase; start() again re-offers -----------------
  it("(f) xfr/fault from the receiver enters fault phase with its reason; a later start() re-offers", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    await startAndOffer(sender, store, "ep-8", new Uint8Array([1]), new Uint8Array([2]));

    sender.handleFrame(PEER, faultFrame("ep-8", "hash-mismatch:audio.part000"));
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    expect(cb.phases.at(-1)?.detail).toBe("hash-mismatch:audio.part000");
    // the sender does not echo a fault back — that would ping-pong
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(false);

    link.sent = [];
    sender.start("ep-8", "static-otter"); // manual "press SEND again"
    await flush();

    expect(link.frames().some((f) => f.t === "xfr/offer")).toBe(true);
    expect(cb.lastPhase()).toBe("offering");
  });

  // -- (g) frames from another peerId ignored --------------------------------
  it("(g) frames from a different peerId are ignored entirely — no state change", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    await startAndOffer(sender, store, "ep-9", new Uint8Array([1]), new Uint8Array([2]));
    link.sent = [];
    const phasesBefore = cb.phases.length;

    sender.handleFrame(OTHER_PEER, haveFrame("ep-9", []));
    await flush();

    expect(link.sent).toEqual([]);
    expect(cb.phases.length).toBe(phasesBefore);
    expect(cb.lastPhase()).toBe("offering");
  });

  // -- (h) done on xfr/done ---------------------------------------------------
  it("(h) xfr/done moves the sender to done, including when the queue was already empty (full resume)", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender } = makeSender(store, cb);
    const audio = entry("audio.part000", 4);
    store.plan = [{ base: "audio", parts: [audio] }, { base: "video", parts: [] }];
    sender.start("ep-10", "static-otter");
    await flush();

    // everything already committed on the receiver's side — nothing to announce
    sender.handleFrame(PEER, haveFrame("ep-10", [audio.name]));
    await flush();
    expect(cb.lastPhase()).toBe("sending");

    sender.handleFrame(PEER, doneFrame("ep-10"));
    await flush();

    expect(cb.lastPhase()).toBe("done");
  });

  it("(h) xfr/done after a full pump-and-commit cycle moves to done", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    const { audio } = await startAndOffer(sender, store, "ep-11", new Uint8Array([1, 2]), new Uint8Array([3, 4]));

    sender.handleFrame(PEER, haveFrame("ep-11", []));
    await flush();
    sender.handleFrame(PEER, partCommittedFrame("ep-11", audio.name));
    await flush();
    sender.handleFrame(PEER, partCommittedFrame("ep-11", "video.part000"));
    await flush();
    link.sent = [];

    sender.handleFrame(PEER, doneFrame("ep-11"));
    await flush();

    expect(cb.lastPhase()).toBe("done");
  });

  // -- malformed frame bodies (Task 4 advisory): fault/ignore, never throw ---
  it("a malformed xfr/have (committed not an array) is a protocol fault, not an uncaught throw", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    await startAndOffer(sender, store, "ep-12", new Uint8Array([1]), new Uint8Array([2]));

    expect(() => {
      sender.handleFrame(PEER, JSON.stringify({ t: "xfr/have", v: 1, episodeId: "ep-12" }));
    }).not.toThrow();
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(true);
  });

  it("a malformed xfr/part-committed (name missing) is a protocol fault, not an uncaught throw", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    await startAndOffer(sender, store, "ep-13", new Uint8Array([1]), new Uint8Array([2]));
    sender.handleFrame(PEER, haveFrame("ep-13", []));
    await flush();

    expect(() => {
      sender.handleFrame(PEER, JSON.stringify({ t: "xfr/part-committed", v: 1, episodeId: "ep-13" }));
    }).not.toThrow();
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(true);
  });

  it("readSendPlan rejecting is a fault, not a crash", async () => {
    const store = new FakeStore();
    store.planRejects = "sidecar missing";
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);

    expect(() => sender.start("ep-14", "static-otter")).not.toThrow();
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    const fault = link.frames().find((f) => f.t === "xfr/fault");
    expect((fault as { reason: string }).reason).toBe("plan:sidecar missing");
  });

  it("a stray xfr/have for a different/superseded episodeId is ignored", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { sender, link } = makeSender(store, cb);
    await startAndOffer(sender, store, "ep-15", new Uint8Array([1]), new Uint8Array([2]));

    sender.handleFrame(PEER, haveFrame("ep-15-other", []));
    await flush();

    expect(link.frames().some((f) => f.t === "xfr/part")).toBe(false);
    expect(cb.lastPhase()).toBe("offering");
  });
});
