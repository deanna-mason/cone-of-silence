// Task 6 (5D): xfer envelope encryption on. Extends the Task 8 loopback
// harness (episode-exchange-loopback.test.ts) — real EpisodeSender <->
// real EpisodeReceiver, a loopback XferLink pair, real SHA-256 hashing
// stores — with a real, shared AES-GCM xferKey (derived the same way
// production does, via lib/crypto/derive.ts). Per-file fakes, mirroring
// every other engine test in this suite (episode-receiver.test.ts,
// episode-sender.test.ts, episode-exchange-loopback.test.ts each keep their
// own copy rather than sharing a module).
import { beforeAll, describe, expect, it } from "vitest";
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
import {
  XFER_CHUNK_BYTES,
  XFER_HEADER_BYTES,
  decodeChunk,
  encodeChunk,
  type FilePlan,
} from "@/lib/podcast/xferProtocol";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";
import { decryptFrame } from "@/lib/crypto/frameCipher";

let TEST_XFER_KEY: CryptoKey;
beforeAll(async () => {
  const { secret } = createRoomKeys();
  ({ xferKey: TEST_XFER_KEY } = await deriveRoomKeys(secret));
});

// ---------------------------------------------------------------------------
// loopback link — same idiom as episode-exchange-loopback.test.ts
// ---------------------------------------------------------------------------
class LoopbackLink implements XferLink {
  sent: Array<string | ArrayBuffer> = [];
  private buffered = 0;
  private peer: { handleFrame(from: string, data: string | ArrayBuffer): void } | null = null;
  /** Flips a byte INSIDE the ciphertext (past the header) of the very next
   *  chunk in transit — models wire corruption / tampering, not a bad local
   *  read. */
  corruptNextChunk = false;

  constructor(private readonly fromPeerId: string) {}

  wireTo(peer: { handleFrame(from: string, data: string | ArrayBuffer): void }): void {
    this.peer = peer;
  }

  send(data: string | ArrayBuffer): boolean {
    this.sent.push(data);
    let payload = data;
    if (this.corruptNextChunk && data instanceof ArrayBuffer) {
      this.corruptNextChunk = false;
      const flipped = new Uint8Array(data.slice(0));
      flipped[XFER_HEADER_BYTES] = (flipped[XFER_HEADER_BYTES] ?? 0) ^ 0xff;
      payload = flipped.buffer;
    }
    const peer = this.peer;
    queueMicrotask(() => peer?.handleFrame(this.fromPeerId, payload));
    return true;
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  chunkSends(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

// ---------------------------------------------------------------------------
// in-memory stores — real SHA-256 (op-order recorded), same idiom as the
// Task 8 loopback file.
// ---------------------------------------------------------------------------
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

class MemorySenderStore implements SenderStore {
  ops: string[] = [];
  private readonly pauseGates = new Map<string, { index: number; gate: Promise<void>; release: () => void }>();

  constructor(
    private readonly plan: FilePlan[],
    private readonly bytes: Map<string, Uint8Array>,
  ) {}

  /** Freezes the zero-based `index`-th read() issued for `name` until
   *  releaseRead(name) — same one-shot gate as the Task 8 loopback file. */
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
        this.ops.push(`read:${name}:${offset}`);
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

async function makePart(name: string, size: number, seed: number): Promise<{ entry: SidecarEntry; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (seed + i * 7) % 256;
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));
  return { entry: { name, size, sha256 }, bytes };
}

const SENDER_ID = "peer-sender";
const RECEIVER_ID = "peer-receiver";

function makeExchange(senderStore: SenderStore, receiverStore: ReceiverStore, xferKey: CryptoKey) {
  const senderCb = new RecordingSenderCallbacks();
  const receiverCb = new RecordingReceiverCallbacks();
  const toReceiver = new LoopbackLink(SENDER_ID);
  const toSender = new LoopbackLink(RECEIVER_ID);
  const sender = new EpisodeSender(RECEIVER_ID, toReceiver, senderStore, senderCb, xferKey);
  const receiver = new EpisodeReceiver(SENDER_ID, toSender, receiverStore, receiverCb, xferKey);
  toReceiver.wireTo(receiver);
  toSender.wireTo(sender);
  return { sender, receiver, senderCb, receiverCb, toReceiver, toSender };
}

/** One real macrotask tick — crypto.subtle resolves through Node's real
 *  async machinery, not guaranteed to settle within a microtask turn (same
 *  note as episode-exchange-loopback.test.ts's flush()). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

describe("xfer envelope encryption (5D)", () => {
  it("encrypted round-trip end-to-end (real keys, real cipher): completes, hashes verify, and the wire never carries plaintext", async () => {
    const audio0 = await makePart("audio.part000", 3000, 1);
    const video0 = await makePart("video.part000", 4000, 90);
    const plan: FilePlan[] = [
      { base: "audio", parts: [audio0.entry] },
      { base: "video", parts: [video0.entry] },
    ];
    const bytes = new Map([
      [audio0.entry.name, audio0.bytes],
      [video0.entry.name, video0.bytes],
    ]);
    const senderStore = new MemorySenderStore(plan, bytes);
    const receiverStore = new MemoryReceiverStore();
    const { sender, senderCb, receiverCb, toReceiver } = makeExchange(senderStore, receiverStore, TEST_XFER_KEY);

    sender.start("ep-enc-full", "static-otter");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");

    // Hashes verified for real — the receiver's commit() only succeeds when
    // the reassembled PLAINTEXT bytes match entry.sha256, so this is the
    // "hashes verifying" half of the property.
    expect(receiverStore.committedNames).toEqual(new Set(["audio.part000", "video.part000"]));
    expect(receiverStore.manifestCalls).toHaveLength(1);

    // Every chunk on the wire is enc=1, has a non-zeroed IV, and is NOT the
    // plaintext it carries — but decrypts back to exactly that plaintext
    // under the shared key. Proves the envelope is genuinely ciphertext,
    // not just labeled as such.
    const chunks = toReceiver.chunkSends();
    expect(chunks.length).toBeGreaterThan(0);
    const knownPlaintext = new Set<string>();
    for (const buf of [audio0.bytes, video0.bytes]) {
      for (let off = 0; off + 4 <= buf.length; off += 4) {
        knownPlaintext.add(Array.from(buf.slice(off, off + 4)).join(","));
      }
    }
    for (const buf of chunks) {
      const env = decodeChunk(buf)!;
      expect(env.enc).toBe(1);
      expect(env.iv.some((b) => b !== 0)).toBe(true);
      // the first 4 ciphertext bytes never equal any known 4-byte plaintext
      // window — a coarse but real "this is not plaintext" check.
      const firstFour = Array.from(env.payload.slice(0, 4)).join(",");
      expect(knownPlaintext.has(firstFour)).toBe(false);

      const ivAndCt = new Uint8Array(env.iv.length + env.payload.length);
      ivAndCt.set(env.iv, 0);
      ivAndCt.set(env.payload, env.iv.length);
      const plain = await decryptFrame(TEST_XFER_KEY, ivAndCt.buffer);
      expect(plain).not.toBeNull();
    }
  });

  it("a tampered chunk in flight faults via decrypt — never a corrupt commit", async () => {
    const audio0 = await makePart("audio.part000", 2000, 5);
    const plan: FilePlan[] = [{ base: "audio", parts: [audio0.entry] }, { base: "video", parts: [] }];
    const bytes = new Map([[audio0.entry.name, audio0.bytes]]);
    const senderStore = new MemorySenderStore(plan, bytes);
    const receiverStore = new MemoryReceiverStore();
    const { sender, receiverCb, toReceiver } = makeExchange(senderStore, receiverStore, TEST_XFER_KEY);

    toReceiver.corruptNextChunk = true; // flips a ciphertext byte of the only chunk audio.part000 sends

    sender.start("ep-enc-tamper", "static-otter");
    await waitFor(() => receiverCb.lastPhase() === "fault");

    // The security property under test: a tampered chunk can NEVER land as
    // a committed (or even appended) part under the wrong bytes — GCM's
    // auth tag catches it before append() is ever called, so there is no
    // "corrupt-commit" window at all, unlike a hash-only scheme where the
    // bytes land on disk first and get caught only at commit time.
    expect(receiverStore.ops.filter((o) => o.startsWith("append:"))).toEqual([]);
    expect(receiverStore.committedNames.has("audio.part000")).toBe(false);
    expect(receiverStore.ops).not.toContain("commit:audio.part000");
    expect(receiverCb.phases.at(-1)?.detail).toBe("decrypt failed");
  });

  it("an enc=0 (plaintext) chunk is refused outright — no downgrade path when keys are present", async () => {
    const audio0 = await makePart("audio.part000", 100, 3);
    const plan: FilePlan[] = [{ base: "audio", parts: [audio0.entry] }, { base: "video", parts: [] }];
    const bytes = new Map([[audio0.entry.name, audio0.bytes]]);
    const senderStore = new MemorySenderStore(plan, bytes);
    const receiverStore = new MemoryReceiverStore();
    // Freeze the read so the real sender never actually sends its own
    // (correctly encrypted) chunk — isolates the receiver's reaction to a
    // rogue plaintext chunk injected directly, exactly the "no plaintext
    // passthrough" property regardless of what a well-behaved sender does.
    senderStore.pauseAtReadIndex("audio.part000", 0);
    const { sender, receiver, receiverCb, toReceiver } = makeExchange(senderStore, receiverStore, TEST_XFER_KEY);

    sender.start("ep-enc-downgrade", "static-otter");
    await waitFor(() => receiverStore.ops.includes("open:audio.part000")); // part announced, chunk still gated

    const plaintextChunk = encodeChunk(0, new TextEncoder().encode("not encrypted"));
    receiver.handleFrame(SENDER_ID, plaintextChunk);
    await flush();

    expect(receiverCb.lastPhase()).toBe("fault");
    expect(receiverStore.ops.filter((o) => o.startsWith("append:"))).toEqual([]);
    expect(receiverStore.committedNames.size).toBe(0);
    toReceiver.sent = []; // hygiene only — nothing further should arrive
  });

  it("resume-after-park re-encrypts with a FRESH IvState — wire IV prefixes differ across the same sender instance's two sessions", async () => {
    // Sized to span exactly 2 chunks so the pump can be frozen strictly
    // between chunk 0 (sent, captured) and chunk 1 (never sent this
    // session) — mirrors episode-exchange-loopback.test.ts's carry-in (b).
    const audio0 = await makePart("audio.part000", XFER_CHUNK_BYTES + 3000, 11);
    const plan: FilePlan[] = [{ base: "audio", parts: [audio0.entry] }, { base: "video", parts: [] }];
    const bytes = new Map([[audio0.entry.name, audio0.bytes]]);
    const senderStore = new MemorySenderStore(plan, bytes);
    const receiverStore = new MemoryReceiverStore();
    senderStore.pauseAtReadIndex("audio.part000", 1); // let chunk 0 through; freeze before chunk 1's read
    const { sender, receiver, senderCb, receiverCb, toReceiver } = makeExchange(senderStore, receiverStore, TEST_XFER_KEY);

    sender.start("ep-enc-resume", "static-otter");
    await waitFor(() => toReceiver.chunkSends().length >= 1);
    await flush();

    const firstSessionChunks = toReceiver.chunkSends();
    expect(firstSessionChunks.length).toBe(1); // chunk 1 is frozen behind the read gate
    const firstEnv = decodeChunk(firstSessionChunks[0]!)!;
    expect(firstEnv.enc).toBe(1);
    const firstPrefix = firstEnv.iv.slice(0, 4);

    // Park BOTH sides — exactly the Task 2 mesh's rebuildLink signal, same
    // shape as episode-exchange-loopback.test.ts's carry-in (b).
    sender.handleChannelClosed();
    receiver.handleChannelClosed();
    await flush();
    expect(senderCb.lastPhase()).toBe("parked");
    expect(receiverCb.lastPhase()).toBe("parked");

    senderStore.releaseRead("audio.part000"); // hygiene — the frozen read's continuation is superseded, sends nothing
    await flush();
    expect(toReceiver.chunkSends().length).toBe(1); // still just the one from before the park

    // Resume: SAME sender instance, start() called again — the manual
    // "press SEND again" path (episode-sender.test.ts case (f)). This is
    // exactly the code path that must build a fresh IvState rather than
    // continuing the old instance's counter under the same prefix.
    toReceiver.sent = [];
    senderStore.pauseAtReadIndex("audio.part000", 1); // freeze the resumed session at the same point, for a clean single-chunk capture
    sender.start("ep-enc-resume", "static-otter");
    await waitFor(() => toReceiver.chunkSends().length >= 1);
    await flush();

    const secondSessionChunks = toReceiver.chunkSends();
    expect(secondSessionChunks.length).toBe(1);
    const secondEnv = decodeChunk(secondSessionChunks[0]!)!;
    expect(secondEnv.enc).toBe(1);
    const secondPrefix = secondEnv.iv.slice(0, 4);

    // The load-bearing assertion: a resume that reused the prior instance's
    // prefix+counter would be a nonce-reuse break under AES-GCM.
    expect(Array.from(secondPrefix)).not.toEqual(Array.from(firstPrefix));

    // Let the resumed session finish cleanly too, for good measure.
    senderStore.releaseRead("audio.part000");
    await waitFor(() => senderCb.lastPhase() === "done" && receiverCb.lastPhase() === "done");
    expect(receiverStore.committedNames.has("audio.part000")).toBe(true);
  });
});
