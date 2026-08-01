// Task 8: loopback integration — BOTH real engines (EpisodeSender +
// EpisodeReceiver from lib/podcast/transfer.ts), no fakes between them. Only
// the two seams every other engine test in this suite already fakes are
// faked here too: the XferLink (now a real loopback pair instead of a
// single-sided recorder) and the two stores (now backed by real SHA-256
// hashing via crypto.subtle instead of hand-fed fixtures). This file owns
// the plan's named carry-in test — see the (b) block below.
import { describe, expect, it } from "vitest";
import {
  EpisodeSender,
  EpisodeReceiver,
  type EpisodeSenderCallbacks,
  type EpisodeReceiverCallbacks,
  type SenderPhase,
  type ReceiverPhase,
  type SenderStore,
  type ReceiverStore,
  type SendProgress,
  type ReceiveProgress,
  type XferLink,
} from "@/lib/podcast/transfer";
import { HashMismatchError, type IncomingPart, type PartReader } from "@/lib/podcast/episodeStore";
import type { SidecarEntry } from "@/lib/podcast/vault";
import { XFER_CHUNK_BYTES, XFER_HEADER_BYTES, encodeChunk, encodeFrame, type FilePlan, type XferFrame } from "@/lib/podcast/xferProtocol";

// ---------------------------------------------------------------------------
// loopback link
// ---------------------------------------------------------------------------

/** Two of these, cross-wired via wireTo(), stand in for the cos-xfer data
 *  channel pair. Delivery is via queueMicrotask rather than a direct call
 *  into the peer's handleFrame() — the brief's "microtask queue,
 *  synchronous-ish, controllable": it keeps each side's call stack flat (no
 *  handleFrame -> send -> handleFrame recursion across the two engines) while
 *  still resolving well within a single macrotask tick, so tests can drive
 *  the whole exchange with a plain poll-until-settled helper (see waitFor
 *  below) instead of hand-counting ticks. corruptNextChunk lets case (c)
 *  flip a payload byte of the very next chunk IN TRANSIT, modeling wire
 *  corruption rather than a bad local read. */
class LoopbackLink implements XferLink {
  sent: Array<string | ArrayBuffer> = [];
  private buffered = 0;
  private sendOk = true;
  private peer: { handleFrame(from: string, data: string | ArrayBuffer): void } | null = null;
  corruptNextChunk = false;

  constructor(private readonly fromPeerId: string) {}

  wireTo(peer: { handleFrame(from: string, data: string | ArrayBuffer): void }): void {
    this.peer = peer;
  }

  send(data: string | ArrayBuffer): boolean {
    if (!this.sendOk) return false;
    this.sent.push(data);
    let payload = data;
    if (this.corruptNextChunk && data instanceof ArrayBuffer) {
      this.corruptNextChunk = false;
      const flipped = new Uint8Array(data.slice(0)); // copy — never mutate the sender's own buffer
      flipped[XFER_HEADER_BYTES] = (flipped[XFER_HEADER_BYTES] ?? 0) ^ 0xff; // flip the first payload byte
      payload = flipped.buffer;
    }
    const peer = this.peer;
    queueMicrotask(() => peer?.handleFrame(this.fromPeerId, payload));
    return true;
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
}

// ---------------------------------------------------------------------------
// in-memory stores (real SHA-256 via crypto.subtle; op-order recorded)
// ---------------------------------------------------------------------------

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

class MemorySenderStore implements SenderStore {
  ops: string[] = [];
  reads: Array<{ name: string; offset: number; length: number }> = [];
  private readonly pauseGates = new Map<string, { index: number; gate: Promise<void>; release: () => void }>();
  private readonly failGates = new Map<string, number>();

  constructor(
    private readonly plan: FilePlan[],
    private readonly bytes: Map<string, Uint8Array>,
  ) {}

  /** Freezes the zero-based `index`-th read() issued against a fresh reader
   *  for `name`, until releaseRead(name) is called — a one-shot gate,
   *  generalizing episode-sender.test.ts's FakePartReader.pauseNextRead() to
   *  a chosen chunk index so a multi-chunk part can be frozen strictly
   *  mid-stream (chunk 0 delivered, chunk 1 never sent). */
  pauseAtReadIndex(name: string, index: number): void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pauseGates.set(name, { index, gate, release });
  }
  releaseRead(name: string): void {
    this.pauseGates.get(name)?.release();
    this.pauseGates.delete(name);
  }

  /** Rejects the zero-based `index`-th read() issued against a fresh reader
   *  for `name` — the counterpart to pauseAtReadIndex above, driving the
   *  sender's real `read:` fault path (transfer.ts's pump()) instead of
   *  merely freezing it. One-shot: a later start() re-reads cleanly, so the
   *  same store can serve the resume half of a test. */
  failAtReadIndex(name: string, index: number): void {
    this.failGates.set(name, index);
  }

  async readSendPlan(episodeId: string): Promise<FilePlan[]> {
    this.ops.push(`plan:${episodeId}`);
    return this.plan;
  }

  async openPartReader(_episodeId: string, name: string): Promise<PartReader> {
    this.ops.push(`open:${name}`);
    const bytes = this.bytes.get(name);
    if (!bytes) throw new Error(`no fixture bytes for ${name}`);
    let readIndex = 0;
    return {
      size: bytes.length,
      read: async (offset: number, length: number): Promise<Uint8Array> => {
        const idx = readIndex++;
        this.reads.push({ name, offset, length });
        this.ops.push(`read:${name}:${offset}`);
        const failAt = this.failGates.get(name);
        if (failAt !== undefined && idx === failAt) {
          this.failGates.delete(name);
          throw new Error(`fixture read failure: ${name}#${idx}`);
        }
        const pending = this.pauseGates.get(name);
        if (pending && idx === pending.index) await pending.gate;
        return bytes.slice(offset, offset + length);
      },
    };
  }
}

interface ReceiverPartState {
  chunks: Uint8Array[];
  committed: boolean;
  abandoned: boolean;
}

class MemoryReceiverStore implements ReceiverStore {
  ops: string[] = [];
  committedNames = new Set<string>();
  manifestCalls: Array<{ episodeId: string; remote: { video: SidecarEntry[]; audio: SidecarEntry[] }; from: string | null }> = [];
  private readonly parts = new Map<string, ReceiverPartState>();

  async scanCommitted(episodeId: string): Promise<string[]> {
    this.ops.push(`scan:${episodeId}`);
    return [...this.committedNames];
  }

  async openIncomingPart(_episodeId: string, entry: SidecarEntry): Promise<IncomingPart> {
    this.ops.push(`open:${entry.name}`);
    // create:true semantics (episodeStore.openIncomingPart's real contract):
    // a re-open of the same name overwrites whatever temp state existed —
    // this is what makes a resend-after-park land cleanly.
    const state: ReceiverPartState = { chunks: [], committed: false, abandoned: false };
    this.parts.set(entry.name, state);
    return {
      append: async (bytes: Uint8Array) => {
        this.ops.push(`append:${entry.name}:${bytes.length}`);
        state.chunks.push(bytes);
      },
      commit: async () => {
        const total = state.chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of state.chunks) {
          merged.set(c, off);
          off += c.length;
        }
        const hex = toHex(await crypto.subtle.digest("SHA-256", merged));
        if (hex !== entry.sha256) {
          this.ops.push(`commit-fail:${entry.name}`);
          throw new HashMismatchError(entry.name);
        }
        this.ops.push(`commit:${entry.name}`);
        state.committed = true;
        this.committedNames.add(entry.name);
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
  }
}

// ---------------------------------------------------------------------------
// callback recorders
// ---------------------------------------------------------------------------

class RecordingSenderCallbacks implements EpisodeSenderCallbacks {
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

class RecordingReceiverCallbacks implements EpisodeReceiverCallbacks {
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

// ---------------------------------------------------------------------------
// fixtures — real SHA-256 via crypto.subtle
// ---------------------------------------------------------------------------

async function makePart(name: string, size: number, seed: number): Promise<{ entry: SidecarEntry; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (seed + i * 7) % 256;
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));
  return { entry: { name, size, sha256 }, bytes };
}

/** 2 files x 3 parts x a few KB, per the brief — except audio.part001, whose
 *  size is overridable: case (b)'s interruption point needs a genuine
 *  between-chunks moment to freeze at, which a single few-KB chunk (the
 *  default for every other part here) doesn't have. */
async function buildEpisodeFixture(opts?: { audio1Size?: number }) {
  const KB = 1024;
  const audio0 = await makePart("audio.part000", 3 * KB, 1);
  const audio1 = await makePart("audio.part001", opts?.audio1Size ?? 3 * KB, 50);
  const audio2 = await makePart("audio.part002", 4 * KB, 90);
  const video0 = await makePart("video.part000", 5 * KB, 130);
  const video1 = await makePart("video.part001", 2 * KB, 170);
  const video2 = await makePart("video.part002", 6 * KB, 210);
  const plan: FilePlan[] = [
    { base: "audio", parts: [audio0.entry, audio1.entry, audio2.entry] },
    { base: "video", parts: [video0.entry, video1.entry, video2.entry] },
  ];
  const bytes = new Map<string, Uint8Array>([
    [audio0.entry.name, audio0.bytes],
    [audio1.entry.name, audio1.bytes],
    [audio2.entry.name, audio2.bytes],
    [video0.entry.name, video0.bytes],
    [video1.entry.name, video1.bytes],
    [video2.entry.name, video2.bytes],
  ]);
  const allNames = [audio0, audio1, audio2, video0, video1, video2].map((p) => p.entry.name);
  return { plan, bytes, audio0, audio1, audio2, video0, video1, video2, allNames };
}

// ---------------------------------------------------------------------------
// harness plumbing
// ---------------------------------------------------------------------------

const SENDER_ID = "peer-sender";
const RECEIVER_ID = "peer-receiver";
const ROGUE_ID = "peer-rogue";

function makeExchange(senderStore: SenderStore, receiverStore: ReceiverStore) {
  const senderCb = new RecordingSenderCallbacks();
  const receiverCb = new RecordingReceiverCallbacks();
  // Each link is owned by the engine that SENDS over it, and stamps
  // deliveries with ITS OWN identity — the receiving engine only accepts
  // frames whose fromPeerId matches the constructor-bound peer it expects.
  const toReceiver = new LoopbackLink(SENDER_ID);
  const toSender = new LoopbackLink(RECEIVER_ID);
  const sender = new EpisodeSender(RECEIVER_ID, toReceiver, senderStore, senderCb);
  const receiver = new EpisodeReceiver(SENDER_ID, toSender, receiverStore, receiverCb);
  toReceiver.wireTo(receiver);
  toSender.wireTo(sender);
  return { sender, receiver, senderCb, receiverCb, toReceiver, toSender };
}

/** One real macrotask tick. Not merely a microtask flush: crypto.subtle's
 *  digest() resolves through Node's real async crypto machinery, which is
 *  not guaranteed to settle within the same microtask turn the way a plain
 *  Promise chain would — so drains need at least one genuine event-loop
 *  tick per hop, not just queueMicrotask draining. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Polls `predicate` once per real tick until it's true, or throws with a
 *  diagnostic if it never is — a stall fails fast and loud instead of the
 *  suite hanging or a fixed tick count silently under- or over-shooting a
 *  multi-part, multi-hash exchange. */
async function waitFor(predicate: () => boolean, maxTicks = 300): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("waitFor: condition not met within maxTicks");
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("episode exchange loopback (real EpisodeSender <-> real EpisodeReceiver)", () => {
  // -- (a) full exchange -----------------------------------------------------
  it("(a) a full exchange: all six parts commit, audio completes before any video, manifest lands after the final commit, both engines end done", async () => {
    const fixture = await buildEpisodeFixture();
    const senderStore = new MemorySenderStore(fixture.plan, fixture.bytes);
    const receiverStore = new MemoryReceiverStore();
    const { sender, senderCb, receiverCb } = makeExchange(senderStore, receiverStore);

    sender.start("ep-full", "static-otter");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    expect(receiverStore.committedNames).toEqual(new Set(fixture.allNames));

    const opsOrder = receiverStore.ops;
    const lastAudioCommitIdx = Math.max(
      ...["audio.part000", "audio.part001", "audio.part002"].map((n) => opsOrder.indexOf(`commit:${n}`)),
    );
    const firstVideoCommitIdx = Math.min(
      ...["video.part000", "video.part001", "video.part002"].map((n) => opsOrder.indexOf(`commit:${n}`)),
    );
    expect(lastAudioCommitIdx).toBeGreaterThanOrEqual(0);
    expect(firstVideoCommitIdx).toBeGreaterThan(lastAudioCommitIdx); // audio done before any video

    const manifestIdx = opsOrder.indexOf("manifest:ep-full");
    for (const name of fixture.allNames) {
      expect(manifestIdx).toBeGreaterThan(opsOrder.indexOf(`commit:${name}`));
    }
    expect(receiverStore.manifestCalls).toEqual([
      {
        episodeId: "ep-full",
        remote: {
          audio: [fixture.audio0.entry, fixture.audio1.entry, fixture.audio2.entry],
          video: [fixture.video0.entry, fixture.video1.entry, fixture.video2.entry],
        },
        from: "static-otter",
      },
    ]);
  });

  // -- (b) NAMED (carry-in 3) -------------------------------------------------
  it("a Phase-4C link rebuild mid-transfer parks the transfer resumable", async () => {
    // audio.part001 is sized to span two chunks (XFER_CHUNK_BYTES + a few
    // KB) specifically so there is a real between-chunks moment to freeze
    // at — every other part in the fixture is "a few KB" (one chunk), which
    // has no such moment.
    const fixture = await buildEpisodeFixture({ audio1Size: XFER_CHUNK_BYTES + 3000 });
    const senderStore = new MemorySenderStore(fixture.plan, fixture.bytes);
    const receiverStore = new MemoryReceiverStore();
    senderStore.pauseAtReadIndex("audio.part001", 1); // let chunk 0 through; freeze before chunk 1's read

    const { sender, receiver, senderCb, receiverCb, toSender } = makeExchange(senderStore, receiverStore);

    sender.start("ep-rebuild", "static-otter");
    // audio.part000 fully commits; audio.part001 gets its first chunk
    // appended and then the pump freezes on the gated second read — a
    // genuine "after >=1 part committed, in the middle of another".
    await waitFor(() => receiverStore.ops.filter((o) => o.startsWith("append:audio.part001")).length >= 1);
    await flush(); // let the pump's next-iteration checks settle before we snapshot

    expect(receiverStore.committedNames.has("audio.part000")).toBe(true);
    expect(receiverStore.ops.filter((o) => o.startsWith("commit:"))).toEqual(["commit:audio.part000"]);
    expect(receiverStore.ops.filter((o) => o.startsWith("append:audio.part001"))).toHaveLength(1);
    expect(senderCb.lastPhase()).toBe("sending");
    expect(receiverCb.lastPhase()).toBe("receiving");

    // Exactly what the Task 2 mesh emits on rebuildLink: BOTH engines get
    // handleChannelClosed(), independently, same tick.
    sender.handleChannelClosed();
    receiver.handleChannelClosed();
    await flush();

    expect(senderCb.lastPhase()).toBe("parked");
    expect(receiverCb.lastPhase()).toBe("parked");

    // Release the frozen read now (hygiene — nothing should come of it: the
    // sender is superseded/parked so its own pump loop must not resume) and
    // confirm the in-flight part really was abandoned, never committed,
    // never renamed.
    senderStore.releaseRead("audio.part001");
    await flush();
    await flush();

    expect(receiverStore.committedNames.has("audio.part001")).toBe(false);
    expect(receiverStore.ops.filter((o) => o.startsWith("commit:"))).toEqual(["commit:audio.part000"]);
    expect(receiverStore.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:audio.part001"]);

    // -- rebuilt channel: fresh sender, SAME parked receiver. -----------
    // A Phase-4C rebuildLink keeps the same peerId — it is a new data
    // channel between the same two participants, not a new participant.
    // Task 11 builds EpisodeReceiver lazily on first offer and keeps it for
    // the room's lifetime, so the real resume path is this SAME parked
    // receiver instance adopting a fresh offer, not a brand new receiver.
    // The engines' `link` fields ARE constructor-bound `readonly` (re-read
    // both constructors above), so the receiver's own link object never
    // moves — but LoopbackLink.wireTo() (a method on the LINK, not the
    // engine) is mutable, so the SAME `toSender` link the receiver has
    // always held is simply re-pointed at the fresh sender below. Only the
    // sender side is reconstructed: Task 11's real wiring constructs a
    // fresh EpisodeSender per send()/resend() call, and the OLD sender is
    // dispose()'d first, mirroring that a superseded sender is done, not
    // reused.
    sender.dispose();

    const opsBeforeResume = receiverStore.ops.length;
    const readsBeforeResume = senderStore.reads.length;
    toSender.sent = []; // isolate the resumed session's frames for the have-frame assertion below

    const freshToReceiver = new LoopbackLink(SENDER_ID);
    const senderCb2 = new RecordingSenderCallbacks();
    const sender2 = new EpisodeSender(RECEIVER_ID, freshToReceiver, senderStore, senderCb2);
    freshToReceiver.wireTo(receiver); // sender2 talks directly to the SAME receiver instance
    toSender.wireTo(sender2); // the receiver's existing outbound link now targets sender2

    sender2.start("ep-rebuild", "static-otter");
    await waitFor(() => senderCb2.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    // The reused receiver's adopt() rescans its own (stale, from before the
    // park) committedNames and chain — proving that resume path, not a
    // fresh scan from empty state, is what reports audio.part000 as done.
    const haveFrames = toSender.frames().filter((f) => f.t === "xfr/have");
    expect(haveFrames).toEqual([{ t: "xfr/have", v: 1, episodeId: "ep-rebuild", committed: ["audio.part000"] }]);

    // audio.part000 was never touched again — the receiver's `have`
    // authoritatively told the sender it was already committed.
    const newOps = receiverStore.ops.slice(opsBeforeResume);
    expect(newOps.some((o) => o.includes("audio.part000"))).toBe(false);
    const newReads = senderStore.reads.slice(readsBeforeResume);
    expect(newReads.some((r) => r.name === "audio.part000")).toBe(false);

    // audio.part001 re-sent from chunk 0, not from wherever it left off.
    const audio1ResumeReads = newReads.filter((r) => r.name === "audio.part001");
    expect(audio1ResumeReads[0]?.offset).toBe(0);

    // Full completion, manifest written exactly once, strictly the last op.
    expect(receiverStore.committedNames).toEqual(new Set(fixture.allNames));
    expect(receiverStore.manifestCalls).toHaveLength(1);
    expect(receiverStore.ops.at(-1)).toBe("manifest:ep-rebuild");
    const manifestIdx = receiverStore.ops.indexOf("manifest:ep-rebuild");
    for (const name of fixture.allNames) {
      expect(manifestIdx).toBeGreaterThan(receiverStore.ops.lastIndexOf(`commit:${name}`));
    }
  });

  // -- (c) corrupt chunk in flight ---------------------------------------
  it("(c) a corrupted chunk in flight faults that part with no rename; a later start() re-sends it and completes", async () => {
    const fixture = await buildEpisodeFixture();
    const senderStore = new MemorySenderStore(fixture.plan, fixture.bytes);
    const receiverStore = new MemoryReceiverStore();
    const { sender, senderCb, receiverCb, toReceiver } = makeExchange(senderStore, receiverStore);

    // Flips a payload byte of the very next chunk delivered sender->receiver
    // — the first (and only, at this size) chunk of audio.part000, the
    // first part the sender ever announces.
    toReceiver.corruptNextChunk = true;

    sender.start("ep-corrupt", "static-otter");
    await waitFor(() => receiverCb.lastPhase() === "fault");

    expect(receiverStore.committedNames.has("audio.part000")).toBe(false);
    expect(receiverStore.ops).toContain("commit-fail:audio.part000");
    expect(receiverStore.ops).not.toContain("commit:audio.part000");
    expect(receiverStore.ops).toContain("abandon:audio.part000"); // temp cleaned up, not just left un-renamed
    const manifestCallsSoFar = receiverStore.manifestCalls; // manifest must never have been reached
    expect(manifestCallsSoFar).toEqual([]);

    // The receiver's xfr/fault reaches the sender. Per the engines as
    // actually shipped (EpisodeSender.onPeerFault sets phase "fault", never
    // "parked" — confirmed by reading transfer.ts's onPeerFault and by
    // episode-sender.test.ts case (f), which asserts the identical
    // transition), the sender's phase here is "fault". This task's brief
    // says "sender parks on the fault frame", which contradicts the shipped
    // contract; asserting the real behavior here (not weakening either
    // side) and flagging the mismatch in the task report per this task's
    // own instruction.
    await waitFor(() => senderCb.lastPhase() === "fault");
    expect(senderCb.phases.at(-1)?.detail).toBe("hash-mismatch:audio.part000");

    // start() again re-offers; the receiver's have (still missing
    // audio.part000) makes the sender re-send that exact part from chunk 0,
    // and this time — uncorrupted — it completes.
    sender.start("ep-corrupt", "static-otter");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    expect(receiverStore.committedNames).toEqual(new Set(fixture.allNames));
    expect(receiverStore.manifestCalls).toHaveLength(1);
  });

  // -- (d) third peer injection changes nothing (carry-in 1) ---------------
  it("(d) a third peerId injecting both frames and chunks into both engines mid-exchange changes nothing", async () => {
    const fixture = await buildEpisodeFixture();
    const senderStore = new MemorySenderStore(fixture.plan, fixture.bytes);
    const receiverStore = new MemoryReceiverStore();
    // Freeze right after audio.part000 commits and before audio.part001's
    // only read, to get a stable mid-exchange window to inject into.
    senderStore.pauseAtReadIndex("audio.part001", 0);
    const { sender, receiver, senderCb, receiverCb } = makeExchange(senderStore, receiverStore);

    sender.start("ep-rogue", "static-otter");
    await waitFor(() => receiverStore.committedNames.has("audio.part000"));
    await flush();

    expect(senderCb.lastPhase()).toBe("sending");
    expect(receiverCb.lastPhase()).toBe("receiving");
    const opsBefore = [...receiverStore.ops];
    const sentToSenderBefore = senderCb.phases.length;
    const sentToReceiverBefore = receiverCb.phases.length;

    // A rogue third peer injects a bogus offer straight at the receiver and
    // a bogus have/chunk straight at the sender, bypassing the loopback
    // links entirely — exactly how carry-in 1 is framed in
    // episode-sender.test.ts (g) / episode-receiver.test.ts (h). The
    // engines are constructor-bound to SENDER_ID/RECEIVER_ID respectively,
    // so ROGUE_ID frames must never even reach the state machine.
    const rogueOffer = encodeFrame({ t: "xfr/offer", v: 1, episodeId: "ep-rogue", from: null, files: fixture.plan });
    const rogueHave = encodeFrame({ t: "xfr/have", v: 1, episodeId: "ep-rogue", committed: [] });
    const rogueChunk = encodeChunk(0, new Uint8Array([9, 9, 9, 9]));
    expect(() => receiver.handleFrame(ROGUE_ID, rogueOffer)).not.toThrow();
    expect(() => sender.handleFrame(ROGUE_ID, rogueHave)).not.toThrow();
    expect(() => receiver.handleFrame(ROGUE_ID, rogueChunk)).not.toThrow();
    expect(() => sender.handleFrame(ROGUE_ID, rogueChunk)).not.toThrow();
    await flush();
    await flush();

    expect(senderCb.lastPhase()).toBe("sending"); // unaffected
    expect(receiverCb.lastPhase()).toBe("receiving"); // unaffected
    expect(senderCb.phases.length).toBe(sentToSenderBefore); // no new phase callbacks at all
    expect(receiverCb.phases.length).toBe(sentToReceiverBefore);
    expect(receiverStore.ops).toEqual(opsBefore); // no scan/open/append/commit/abandon triggered

    // release the real interruption and let the (unaffected) exchange finish
    senderStore.releaseRead("audio.part001");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    expect(receiverStore.committedNames).toEqual(new Set(fixture.allNames));
  });

  // -- (e) a SENDER-side fault mid-transfer parks the receiver ---------------
  it("(e) a sender-side fault mid-transfer parks the receiver resumable, and a later re-offer resumes from the committed parts", async () => {
    // A three-chunk audio.part001, frozen at chunk 1's read exactly like
    // case (b) — that pause is only there to make the mid-part state
    // deterministic and assertable; the FAULT itself comes from the gate on
    // chunk 2, i.e. the sender's real `read:` path. That is the state that
    // used to wedge the receiver in "receiving" forever (busy true,
    // holdRolls blocking every future take) because inbound xfr/fault was
    // dropped on the floor.
    const fixture = await buildEpisodeFixture({ audio1Size: 2 * XFER_CHUNK_BYTES + 3000 });
    const senderStore = new MemorySenderStore(fixture.plan, fixture.bytes);
    const receiverStore = new MemoryReceiverStore();
    senderStore.pauseAtReadIndex("audio.part001", 1);
    senderStore.failAtReadIndex("audio.part001", 2);

    const { sender, senderCb, receiverCb, toSender } = makeExchange(senderStore, receiverStore);

    sender.start("ep-peer-fault", "static-otter");
    // audio.part000 fully commits; audio.part001 has its first chunk
    // appended and is genuinely half-written when the pump freezes.
    await waitFor(() => receiverStore.ops.filter((o) => o.startsWith("append:audio.part001")).length >= 1);
    await flush();
    expect(receiverStore.committedNames.has("audio.part000")).toBe(true);
    expect(receiverStore.ops.filter((o) => o.startsWith("commit:"))).toEqual(["commit:audio.part000"]);
    expect(receiverCb.lastPhase()).toBe("receiving");

    // Release: chunk 1 goes out, chunk 2's read rejects, the sender faults
    // for real and sends xfr/fault while the receiver still holds an open
    // temp for audio.part001.
    senderStore.releaseRead("audio.part001");
    await waitFor(() => senderCb.lastPhase() === "fault");
    expect(senderCb.phases.at(-1)?.detail).toContain("read:");

    // PARKED, not stuck receiving and not faulted: resumable (disk state is
    // authoritative) and dismissible (Task 11 maps parked -> the
    // xfer-interrupted card, which Stand Down clears).
    await waitFor(() => receiverCb.lastPhase() === "parked");
    expect(receiverCb.phases.at(-1)?.detail).toContain("read:"); // the sender's own reason, reflected

    // The half-written part was abandoned, never committed, never renamed.
    await flush();
    expect(receiverStore.committedNames.has("audio.part001")).toBe(false);
    expect(receiverStore.ops.filter((o) => o.startsWith("commit:"))).toEqual(["commit:audio.part000"]);
    expect(receiverStore.ops.filter((o) => o.startsWith("abandon:"))).toEqual(["abandon:audio.part001"]);
    expect(receiverStore.manifestCalls).toEqual([]);

    // -- a later re-offer resumes from exactly what committed -------------
    toSender.sent = []; // isolate the resumed session's frames for the have assertion
    sender.start("ep-peer-fault", "static-otter");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    const haveFrames = toSender.frames().filter((f) => f.t === "xfr/have");
    expect(haveFrames).toEqual([{ t: "xfr/have", v: 1, episodeId: "ep-peer-fault", committed: ["audio.part000"] }]);
    expect(receiverStore.committedNames).toEqual(new Set(fixture.allNames));
    expect(receiverStore.manifestCalls).toHaveLength(1);
  });

  // -- (f) a zero-byte part ------------------------------------------------
  it("(f) a zero-byte part in the plan commits with no chunks at all and the exchange completes", async () => {
    // Takes recorded before the recorder's empty-blob drop (commit f54d893)
    // can still carry a zero-size sidecar entry, and lastTakeId persists —
    // so a real plan can contain a 0-byte part. chunks: 0 means the receiver
    // never sees an onChunk for it, which is the only place `isLast` fires.
    const audio0 = await makePart("audio.part000", 2048, 11);
    const audioEmpty = await makePart("audio.part001", 0, 0); // sha256 of zero bytes
    const video0 = await makePart("video.part000", 1024, 33);
    const plan: FilePlan[] = [
      { base: "audio", parts: [audio0.entry, audioEmpty.entry] },
      { base: "video", parts: [video0.entry] },
    ];
    const bytes = new Map<string, Uint8Array>([
      [audio0.entry.name, audio0.bytes],
      [audioEmpty.entry.name, audioEmpty.bytes],
      [video0.entry.name, video0.bytes],
    ]);
    const senderStore = new MemorySenderStore(plan, bytes);
    const receiverStore = new MemoryReceiverStore();
    const { sender, senderCb, receiverCb, toReceiver } = makeExchange(senderStore, receiverStore);

    sender.start("ep-zero", "static-otter");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    expect(receiverStore.committedNames).toEqual(new Set(["audio.part000", "audio.part001", "video.part000"]));
    // The empty part was announced with chunks: 0 and no chunk ever followed
    // — it commits on the strength of the announcement alone.
    const emptyPartFrame = toReceiver.frames().find((f) => f.t === "xfr/part" && f.name === "audio.part001");
    expect(emptyPartFrame).toMatchObject({ chunks: 0, size: 0 });
    expect(receiverStore.ops.filter((o) => o.startsWith("append:audio.part001"))).toEqual([]);
    expect(receiverStore.ops).toContain("open:audio.part001");
    expect(receiverStore.ops).toContain("commit:audio.part001");
    // Its xfr/part-committed really did unblock the next part — the sender
    // announces one part at a time and waits for the ack.
    expect(receiverStore.ops.indexOf("commit:video.part000")).toBeGreaterThan(receiverStore.ops.indexOf("commit:audio.part001"));
    expect(receiverStore.manifestCalls).toHaveLength(1);
  });
});
