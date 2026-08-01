// Task 6: EpisodeReceiver state machine. Fakes only — no real disk, no real
// WebRTC. Frames are driven by hand via handleFrame(), mirroring how
// xfer-channel.test.ts drives PeerLink by hand rather than mocking it away.
import { describe, expect, it } from "vitest";
import {
  EpisodeReceiver,
  type EpisodeReceiverCallbacks,
  type ReceiverPhase,
  type ReceiverStore,
  type ReceiveProgress,
  type XferLink,
} from "@/lib/podcast/transfer";
import { HashMismatchError, type IncomingPart } from "@/lib/podcast/episodeStore";
import type { SidecarEntry } from "@/lib/podcast/vault";
import { XFER_HEADER_BYTES, encodeChunk, encodeFrame, type FilePlan, type XferFrame } from "@/lib/podcast/xferProtocol";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeLink implements XferLink {
  sent: Array<string | ArrayBuffer> = [];
  send(data: string | ArrayBuffer): boolean {
    this.sent.push(data);
    return true;
  }
  bufferedAmount(): number {
    return 0;
  }
  /** Sent xfr/* control frames, parsed, in order. */
  frames(): XferFrame[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as XferFrame);
  }
}

interface FakePartState {
  chunks: Uint8Array[];
  committed: boolean;
  abandoned: boolean;
}

class FakeStore implements ReceiverStore {
  ops: string[] = [];
  /** Names scanCommitted() reports as already on disk before this test drives anything. */
  seededCommitted: string[] = [];
  /** Part names whose commit() must reject with HashMismatchError. */
  hashMismatchFor = new Set<string>();
  /** Set to make writeManifest() reject with this message. */
  manifestRejects: string | null = null;
  manifestCalls: Array<{ episodeId: string; remote: { video: SidecarEntry[]; audio: SidecarEntry[] }; from: string | null }> =
    [];
  parts = new Map<string, FakePartState>();

  async scanCommitted(episodeId: string): Promise<string[]> {
    this.ops.push(`scan:${episodeId}`);
    return [...this.seededCommitted];
  }

  async openIncomingPart(_episodeId: string, entry: SidecarEntry): Promise<IncomingPart> {
    this.ops.push(`open:${entry.name}`);
    const state: FakePartState = { chunks: [], committed: false, abandoned: false };
    this.parts.set(entry.name, state);
    return {
      append: async (bytes: Uint8Array) => {
        this.ops.push(`append:${entry.name}:${bytes.length}`);
        state.chunks.push(bytes);
      },
      commit: async () => {
        if (this.hashMismatchFor.has(entry.name)) {
          this.ops.push(`commit-fail:${entry.name}`);
          throw new HashMismatchError(entry.name);
        }
        this.ops.push(`commit:${entry.name}`);
        state.committed = true;
        this.seededCommitted.push(entry.name);
      },
      abandon: async () => {
        this.ops.push(`abandon:${entry.name}`);
        state.abandoned = true;
      },
    };
  }

  async writeManifest(
    episodeId: string,
    remote: { video: SidecarEntry[]; audio: SidecarEntry[] },
    from: string | null,
  ): Promise<void> {
    this.ops.push(`manifest:${episodeId}`);
    this.manifestCalls.push({ episodeId, remote, from });
    if (this.manifestRejects) throw new Error(this.manifestRejects);
  }
}

class FakeCallbacks implements EpisodeReceiverCallbacks {
  phases: Array<{ phase: ReceiverPhase; detail?: string }> = [];
  progress: ReceiveProgress[] = [];
  onPhase(phase: ReceiverPhase, detail?: string): void {
    this.phases.push({ phase, detail });
  }
  onProgress(p: ReceiveProgress): void {
    this.progress.push(p);
  }
  lastPhase(): ReceiverPhase | undefined {
    return this.phases.at(-1)?.phase;
  }
}

/** Drains the receiver's private disk-op chain. A macrotask boundary (not a
 *  fixed count of microtask ticks) is used deliberately: the chain nests
 *  several un-enqueued `await`s inside its longest link (append -> commit ->
 *  writeManifest), so a fixed tick count is fragile — a setTimeout(0) lets
 *  the whole microtask queue drain to exhaustion regardless of depth. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// frame builders
// ---------------------------------------------------------------------------

const PEER = "peer-a";
const OTHER_PEER = "peer-b";

function audioEntry(name: string, size = 4): SidecarEntry {
  return { name, size, sha256: `sha-${name}` };
}
function videoEntry(name: string, size = 4): SidecarEntry {
  return { name, size, sha256: `sha-${name}` };
}

function plan(audioParts: SidecarEntry[], videoParts: SidecarEntry[]): FilePlan[] {
  return [
    { base: "audio", parts: audioParts },
    { base: "video", parts: videoParts },
  ];
}

function offer(episodeId: string, files: FilePlan[], from: string | null = "static-otter"): string {
  return encodeFrame({ t: "xfr/offer", v: 1, episodeId, from, files });
}

function partFrame(episodeId: string, entry: SidecarEntry, chunks: number): string {
  return encodeFrame({ t: "xfr/part", v: 1, episodeId, name: entry.name, size: entry.size, sha256: entry.sha256, chunks });
}

function chunkBuf(seq: number, text: string): ArrayBuffer {
  return encodeChunk(seq, new TextEncoder().encode(text));
}

function enc1ChunkBuf(seq: number, text: string): ArrayBuffer {
  const payload = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(XFER_HEADER_BYTES + payload.length);
  const dv = new DataView(buf);
  dv.setUint8(0, 1); // version
  dv.setUint8(1, 1); // enc = aes-gcm (5B must reject this)
  dv.setUint16(2, 0, true);
  dv.setUint32(4, seq >>> 0, true);
  new Uint8Array(buf, XFER_HEADER_BYTES).set(payload);
  return buf;
}

/** Drives a single part end to end: xfr/part, then N one-byte-string chunks. */
async function sendWholePart(
  receiver: EpisodeReceiver,
  episodeId: string,
  entry: SidecarEntry,
  chunks: string[],
  fromPeer = PEER,
): Promise<void> {
  receiver.handleFrame(fromPeer, partFrame(episodeId, entry, chunks.length));
  for (let i = 0; i < chunks.length; i++) {
    receiver.handleFrame(fromPeer, chunkBuf(i, chunks[i]!));
  }
  await flush();
}

function makeReceiver(store: FakeStore, cb: FakeCallbacks, link = new FakeLink()) {
  const receiver = new EpisodeReceiver(PEER, link, store, cb);
  return { receiver, link };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("EpisodeReceiver", () => {
  // -- (a) offer -> have carries previously-committed names -----------------
  it("(a) xfr/offer -> scanCommitted -> xfr/have carrying previously-committed names, phase receiving", async () => {
    const store = new FakeStore();
    store.seededCommitted = ["audio.part000"];
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);

    const files = plan([audioEntry("audio.part000"), audioEntry("audio.part001")], [videoEntry("video.part000")]);
    receiver.handleFrame(PEER, offer("ep-1", files));
    await flush();

    expect(store.ops).toEqual(["scan:ep-1"]);
    expect(link.frames()).toEqual([{ t: "xfr/have", v: 1, episodeId: "ep-1", committed: ["audio.part000"] }]);
    expect(cb.lastPhase()).toBe("receiving");
  });

  // -- (b) sequential chunks assemble a part; part-committed after commit ---
  it("(b) sequential chunks append in order and commit; xfr/part-committed sent after the store commit resolves", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const entry = audioEntry("audio.part000", 6);
    const files = plan([entry], [videoEntry("video.part000")]);

    receiver.handleFrame(PEER, offer("ep-2", files));
    await flush();
    link.sent = [];
    store.ops = [];

    await sendWholePart(receiver, "ep-2", entry, ["ab", "cd", "ef"]);

    expect(store.ops).toEqual([
      "open:audio.part000",
      "append:audio.part000:2",
      "append:audio.part000:2",
      "append:audio.part000:2",
      "commit:audio.part000",
    ]);
    expect(link.frames()).toEqual([{ t: "xfr/part-committed", v: 1, episodeId: "ep-2", name: "audio.part000" }]);
    expect(cb.progress.length).toBeGreaterThanOrEqual(3);
    const last = cb.progress.at(-1)!;
    expect(last.file).toBe("audio.part000");
    expect(last.totalBytes).toBe(6);
    expect(last.fromCodename).toBe("static-otter");
  });

  // -- (c) chunk seq gap -> fault ---------------------------------------------
  it("(c) a seq gap faults: xfr/fault sent, in-flight part abandoned, phase fault", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const entry = audioEntry("audio.part000");
    const files = plan([entry], [videoEntry("video.part000")]);

    receiver.handleFrame(PEER, offer("ep-3", files));
    await flush();
    link.sent = [];

    receiver.handleFrame(PEER, partFrame("ep-3", entry, 3));
    receiver.handleFrame(PEER, chunkBuf(0, "aa"));
    await flush(); // the good chunk lands first, like a real per-message DC delivery
    receiver.handleFrame(PEER, chunkBuf(2, "cc")); // skips seq 1
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    const fault = link.frames().find((f) => f.t === "xfr/fault");
    expect(fault).toBeTruthy();
    expect((fault as { episodeId: string }).episodeId).toBe("ep-3");
    expect(store.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:audio.part000"]);
    // the good chunk did land, but the part was never committed — a gap
    // downstream of it can never be silently swallowed into a valid part.
    expect(store.ops.filter((o) => o.startsWith("append:"))).toEqual(["append:audio.part000:2"]);
    expect(store.ops.some((o) => o.startsWith("commit:"))).toBe(false);
  });

  it("(c) a duplicate seq faults the same way", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver } = makeReceiver(store, cb);
    const entry = audioEntry("audio.part000");
    receiver.handleFrame(PEER, offer("ep-3b", plan([entry], [videoEntry("video.part000")])));
    await flush();

    receiver.handleFrame(PEER, partFrame("ep-3b", entry, 3));
    receiver.handleFrame(PEER, chunkBuf(0, "aa"));
    receiver.handleFrame(PEER, chunkBuf(0, "aa")); // duplicate of seq 0
    await flush();

    expect(cb.lastPhase()).toBe("fault");
  });

  // -- (d) enc=1 chunk -> fault (5B rejects) --------------------------------
  it("(d) an enc=1 chunk faults — 5B never accepts ciphertext", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const entry = audioEntry("audio.part000");
    receiver.handleFrame(PEER, offer("ep-4", plan([entry], [videoEntry("video.part000")])));
    await flush();
    link.sent = [];

    receiver.handleFrame(PEER, partFrame("ep-4", entry, 2));
    receiver.handleFrame(PEER, enc1ChunkBuf(0, "aa"));
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(true);
    expect(store.ops.filter((o) => o.startsWith("append:"))).toEqual([]);
    expect(store.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:audio.part000"]);
  });

  it("a malformed (too-short) chunk buffer also faults", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver } = makeReceiver(store, cb);
    const entry = audioEntry("audio.part000");
    receiver.handleFrame(PEER, offer("ep-4b", plan([entry], [videoEntry("video.part000")])));
    await flush();

    receiver.handleFrame(PEER, partFrame("ep-4b", entry, 2));
    receiver.handleFrame(PEER, new ArrayBuffer(4)); // shorter than XFER_HEADER_BYTES
    await flush();

    expect(cb.lastPhase()).toBe("fault");
  });

  // -- (e) hash mismatch -> fault, no part-committed -------------------------
  it("(e) HashMismatchError on commit sends xfr/fault reason hash-mismatch:<name>, no part-committed", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const entry = audioEntry("audio.part000", 2);
    store.hashMismatchFor.add("audio.part000");
    receiver.handleFrame(PEER, offer("ep-5", plan([entry], [videoEntry("video.part000")])));
    await flush();
    link.sent = [];

    await sendWholePart(receiver, "ep-5", entry, ["aa"]);

    expect(cb.lastPhase()).toBe("fault");
    const fault = link.frames().find((f) => f.t === "xfr/fault");
    expect(fault).toBeTruthy();
    expect((fault as { reason: string }).reason).toBe("hash-mismatch:audio.part000");
    expect(link.frames().some((f) => f.t === "xfr/part-committed")).toBe(false);
  });

  // -- (f) manifest only after every part of both files; op-order ----------
  it("(f) writeManifest fires only after every part of both files commits; xfr/done sent after manifest resolves", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000", 2);
    const v0 = videoEntry("video.part000", 2);
    const files = plan([a0], [v0]);

    receiver.handleFrame(PEER, offer("ep-6", files));
    await flush();
    link.sent = [];

    await sendWholePart(receiver, "ep-6", a0, ["aa"]);
    // manifest must NOT have fired after just one of the two files
    expect(store.ops.some((o) => o.startsWith("manifest:"))).toBe(false);
    expect(link.frames().some((f) => f.t === "xfr/done")).toBe(false);

    await sendWholePart(receiver, "ep-6", v0, ["bb"]);

    const commitAudioIdx = store.ops.indexOf("commit:audio.part000");
    const commitVideoIdx = store.ops.indexOf("commit:video.part000");
    const manifestIdx = store.ops.indexOf("manifest:ep-6");
    expect(commitAudioIdx).toBeGreaterThanOrEqual(0);
    expect(commitVideoIdx).toBeGreaterThan(commitAudioIdx);
    expect(manifestIdx).toBeGreaterThan(commitVideoIdx);

    expect(store.manifestCalls).toEqual([
      { episodeId: "ep-6", remote: { video: [v0], audio: [a0] }, from: "static-otter" },
    ]);

    // done is the LAST frame sent, after both part-committed acks — and by
    // construction (finishEpisode awaits writeManifest before sending done)
    // it can only have been sent after the manifest call above resolved.
    const sentFrames = link.frames();
    expect(sentFrames.at(-1)).toEqual({ t: "xfr/done", v: 1, episodeId: "ep-6" });
    expect(cb.lastPhase()).toBe("done");
  });

  it("(f) writeManifest rejection is a fault (reason manifest:<message>), not a crash — re-offer retries it", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000", 2);
    const v0 = videoEntry("video.part000", 2);
    const files = plan([a0], [v0]);
    store.manifestRejects = "corrupt local sidecar";

    receiver.handleFrame(PEER, offer("ep-6b", files));
    await flush();
    await sendWholePart(receiver, "ep-6b", a0, ["aa"]);
    await sendWholePart(receiver, "ep-6b", v0, ["bb"]);

    expect(cb.lastPhase()).toBe("fault");
    const fault = link.frames().find((f) => f.t === "xfr/fault");
    expect((fault as { reason: string }).reason).toBe("manifest:corrupt local sidecar");
    expect(link.frames().some((f) => f.t === "xfr/done")).toBe(false);

    // Recovery: a re-offer of the same episode, now with both parts already
    // committed on disk, rescans, finds everything committed, and retries —
    // this time writeManifest succeeds.
    store.manifestRejects = null;
    link.sent = [];
    receiver.handleFrame(PEER, offer("ep-6b", files));
    await flush();

    expect(link.frames()).toEqual([
      { t: "xfr/have", v: 1, episodeId: "ep-6b", committed: expect.arrayContaining(["audio.part000", "video.part000"]) },
    ]);
    expect(cb.lastPhase()).toBe("receiving");
  });

  // -- (g) handleChannelClosed mid-part -> abandon, parked; resumes on offer -
  it("(g) handleChannelClosed mid-part abandons the in-flight part and parks; a fresh offer resumes with committed parts in have", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000", 6);
    const v0 = videoEntry("video.part000", 2);
    const files = plan([a0], [v0]);

    receiver.handleFrame(PEER, offer("ep-7", files));
    await flush();
    await sendWholePart(receiver, "ep-7", a0, ["aa", "bb", "cc"]); // audio fully committed

    // video part started but not finished when the channel drops
    receiver.handleFrame(PEER, partFrame("ep-7", v0, 2));
    receiver.handleFrame(PEER, chunkBuf(0, "x"));
    await flush();

    receiver.handleChannelClosed();
    await flush();

    expect(cb.lastPhase()).toBe("parked");
    expect(store.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:video.part000"]);

    link.sent = [];
    receiver.handleFrame(PEER, offer("ep-7", files));
    await flush();

    expect(link.frames()).toEqual([{ t: "xfr/have", v: 1, episodeId: "ep-7", committed: ["audio.part000"] }]);
    expect(cb.lastPhase()).toBe("receiving");
  });

  it("(g) handleChannelClosed while idle is a no-op", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver } = makeReceiver(store, cb);
    receiver.handleChannelClosed();
    await flush();
    expect(cb.phases).toEqual([]);
  });

  // -- offer while receiving: different episode ignored; same restarts -----
  it("an offer for a DIFFERENT episode while actively receiving is ignored entirely", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000");
    receiver.handleFrame(PEER, offer("ep-8", plan([a0], [videoEntry("video.part000")])));
    await flush();

    // begin a part so we can prove it's untouched by the ignored offer
    receiver.handleFrame(PEER, partFrame("ep-8", a0, 2));
    receiver.handleFrame(PEER, chunkBuf(0, "aa"));
    await flush();
    link.sent = [];
    const opsBefore = [...store.ops];

    receiver.handleFrame(PEER, offer("ep-9-different", plan([audioEntry("audio.part000")], [videoEntry("video.part000")])));
    await flush();

    expect(link.sent).toEqual([]);
    expect(store.ops).toEqual(opsBefore); // no scan, no abandon — completely ignored
    expect(cb.lastPhase()).toBe("receiving");

    // the original episode's transfer is still alive: finishing it works
    receiver.handleFrame(PEER, chunkBuf(1, "bb"));
    await flush();
    expect(store.ops).toContain("commit:audio.part000");
  });

  it("a re-offer of the SAME episode while receiving restarts cleanly: abandons the in-flight part, rescans, re-haves", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000");
    const files = plan([a0], [videoEntry("video.part000")]);
    receiver.handleFrame(PEER, offer("ep-10", files));
    await flush();

    receiver.handleFrame(PEER, partFrame("ep-10", a0, 3));
    receiver.handleFrame(PEER, chunkBuf(0, "aa")); // in-flight, uncommitted
    await flush();
    link.sent = [];

    receiver.handleFrame(PEER, offer("ep-10", files)); // same episode, mid-part
    await flush();

    expect(store.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:audio.part000"]);
    expect(store.ops.filter((o) => o.startsWith("scan:"))).toHaveLength(2);
    expect(link.frames()).toEqual([{ t: "xfr/have", v: 1, episodeId: "ep-10", committed: [] }]);
    expect(cb.lastPhase()).toBe("receiving");

    // and a fresh part for this episode now proceeds normally
    await sendWholePart(receiver, "ep-10", a0, ["11", "22", "33"]);
    expect(store.ops).toContain("commit:audio.part000");
  });

  // -- (h) frames from a second peerId are ignored entirely -----------------
  it("(h) frames from a different peerId are ignored entirely — no state change, no sends", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);

    receiver.handleFrame(OTHER_PEER, offer("ep-11", plan([audioEntry("audio.part000")], [videoEntry("video.part000")])));
    await flush();

    expect(link.sent).toEqual([]);
    expect(store.ops).toEqual([]);
    expect(cb.phases).toEqual([]);
  });

  it("(h) chunks from a different peerId mid-transfer are ignored, not misapplied to the real transfer", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000");
    receiver.handleFrame(PEER, offer("ep-12", plan([a0], [videoEntry("video.part000")])));
    await flush();
    receiver.handleFrame(PEER, partFrame("ep-12", a0, 2));
    await flush();
    link.sent = [];

    receiver.handleFrame(OTHER_PEER, chunkBuf(0, "zz")); // wrong peer, would-be seq 0
    await flush();

    expect(store.ops.filter((o) => o.startsWith("append:"))).toEqual([]);
    expect(cb.lastPhase()).toBe("receiving"); // no fault — frame never reached the state machine

    // the real peer's seq 0 still lands correctly afterward
    receiver.handleFrame(PEER, chunkBuf(0, "aa"));
    receiver.handleFrame(PEER, chunkBuf(1, "bb"));
    await flush();
    expect(store.ops).toContain("commit:audio.part000");
  });

  // -- (i) dispose() mid-part abandons and goes quiet ------------------------
  it("(i) dispose() mid-part abandons the in-flight part and goes quiet — no further sends or callbacks", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000", 6);
    receiver.handleFrame(PEER, offer("ep-13", plan([a0], [videoEntry("video.part000")])));
    await flush();
    receiver.handleFrame(PEER, partFrame("ep-13", a0, 3));
    receiver.handleFrame(PEER, chunkBuf(0, "aa"));
    await flush();

    receiver.dispose();
    await flush();

    expect(store.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:audio.part000"]);
    const phasesAtDispose = cb.phases.length;
    const sentAtDispose = link.sent.length;

    // further frames after dispose must produce no sends and no callbacks
    receiver.handleFrame(PEER, chunkBuf(1, "bb"));
    receiver.handleFrame(PEER, offer("ep-14", plan([audioEntry("x")], [videoEntry("y")])));
    receiver.handleChannelClosed();
    await flush();

    expect(cb.phases.length).toBe(phasesAtDispose);
    expect(link.sent.length).toBe(sentAtDispose);
    expect(store.ops.filter((o) => o.startsWith("commit:"))).toEqual([]);
  });

  // -- malformed frame bodies (Task 4 advisory): fault, never throw ---------
  it("a malformed offer (files not an array) is a protocol fault, not an uncaught throw", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);

    expect(() => {
      receiver.handleFrame(PEER, JSON.stringify({ t: "xfr/offer", v: 1, episodeId: "ep-15", from: null }));
    }).not.toThrow();
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(true);
  });

  it("a malformed xfr/part (non-numeric chunks) is a protocol fault, not an uncaught throw", async () => {
    const store = new FakeStore();
    const cb = new FakeCallbacks();
    const { receiver, link } = makeReceiver(store, cb);
    const a0 = audioEntry("audio.part000");
    receiver.handleFrame(PEER, offer("ep-16", plan([a0], [videoEntry("video.part000")])));
    await flush();
    link.sent = [];

    expect(() => {
      receiver.handleFrame(
        PEER,
        JSON.stringify({ t: "xfr/part", v: 1, episodeId: "ep-16", name: "audio.part000", size: 4, sha256: "x", chunks: "two" }),
      );
    }).not.toThrow();
    await flush();

    expect(cb.lastPhase()).toBe("fault");
    expect(link.frames().some((f) => f.t === "xfr/fault")).toBe(true);
  });
});
