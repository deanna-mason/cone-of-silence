// Episode-exchange engines, driven over the cos-xfer data channel via
// xferProtocol.ts's frames/envelope. Task 6 is the RECEIVER (EpisodeReceiver,
// below); Task 7 adds the SENDER counterpart (EpisodeSender, further down)
// to this same file.
//
// scanCommitted() IS the resume state (episodeStore.ts) — `committedNames`
// below is just an in-memory mirror of it, used to detect "last part of the
// last file" so the manifest (the 5C darkroom's trigger) writes strictly
// after every commit. The sender's mirror image of that resume state is
// `xfr/have`: it never trusts its own sent-count, only what the receiver
// reports as committed.
import { HashMismatchError, type IncomingPart, type PartReader } from "./episodeStore";
import type { SidecarEntry } from "./vault";
import { XFER_HIGH_WATER } from "../webrtc/peer";
import { IvState, decryptFrame, encryptFrame } from "../crypto/frameCipher";
import {
  decodeChunk,
  encodeChunk,
  encodeFrame,
  parseXferFrame,
  OFFER_TIMEOUT_MS,
  XFER_CHUNK_BYTES,
  type FilePlan,
  type XferFrame,
} from "./xferProtocol";

/** Narrow per-peer slice of the XferPort, injectable for tests. */
export interface XferLink {
  send(data: string | ArrayBuffer): boolean;
  bufferedAmount(): number;
}

export interface ReceiverStore {
  /** `expected` is the offer's flattened {name, size} plan — the store uses
   *  it to refuse (and delete) size-mismatched crash artifacts so they never
   *  enter xfr/have as resume state (see episodeStore.scanCommitted). */
  scanCommitted(episodeId: string, expected: ReadonlyArray<{ name: string; size: number }>): Promise<string[]>;
  openIncomingPart(episodeId: string, entry: SidecarEntry): Promise<IncomingPart>;
  writeManifest(episodeId: string, remote: { video: SidecarEntry[]; audio: SidecarEntry[] }, from: string | null): Promise<void>;
}

export type ReceiverPhase = "idle" | "receiving" | "parked" | "done" | "fault";

export interface ReceiveProgress {
  file: string;
  committedBytes: number;
  totalBytes: number;
  fromCodename: string | null;
}

export interface EpisodeReceiverCallbacks {
  onPhase(phase: ReceiverPhase, detail?: string): void;
  onProgress(p: ReceiveProgress): void; // throttled to >=1 per committed chunk batch; the hook rates it
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reassembles the [12-byte IV][ciphertext+tag] buffer decryptFrame expects
 *  from the envelope's separately-carried `iv` + `payload` fields — the
 *  envelope never duplicates the IV inside `payload` (xferProtocol.ts's D17
 *  note: the header already has a dedicated 12-byte IV slot). */
function ivAndCiphertext(iv: Uint8Array, ciphertext: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out.buffer;
}

// parseXferFrame only guards the "xfr/" t-prefix (Task 4 advisory) — these
// validate the BODIES of the two frame types the receiver actually acts on,
// so a buggy/adversarial peer faults cleanly instead of throwing mid-handler.
function isValidEntry(p: unknown): p is SidecarEntry {
  if (!p || typeof p !== "object") return false;
  const e = p as Record<string, unknown>;
  return typeof e.name === "string" && typeof e.size === "number" && typeof e.sha256 === "string";
}

function isValidOffer(x: Record<string, unknown>): x is { episodeId: string; from: string | null; files: FilePlan[] } {
  if (typeof x.episodeId !== "string") return false;
  if (x.from !== null && typeof x.from !== "string") return false;
  if (!Array.isArray(x.files)) return false;
  return x.files.every((f) => {
    if (!f || typeof f !== "object") return false;
    const rec = f as Record<string, unknown>;
    return (rec.base === "audio" || rec.base === "video") && Array.isArray(rec.parts) && rec.parts.every(isValidEntry);
  });
}

function isValidPartFrame(
  x: Record<string, unknown>,
): x is { episodeId: string; name: string; size: number; sha256: string; chunks: number } {
  return (
    typeof x.episodeId === "string" &&
    typeof x.name === "string" &&
    typeof x.size === "number" &&
    typeof x.sha256 === "string" &&
    typeof x.chunks === "number" &&
    Number.isFinite(x.chunks)
  );
}

interface ActiveSlot {
  entry: SidecarEntry;
  chunksExpected: number;
  nextSeq: number;
  bytesWritten: number;
  partPromise: Promise<IncomingPart>;
  /** Set once commit() resolves. Disk truth from then on: commit and
   *  abandon are mutually exclusive per part (Task 5 advisory) — this flag
   *  makes that structural instead of an accident of episodeStore's
   *  abandon() happening to target only the temp name. */
  committed: boolean;
}

/**
 * Receives one episode at a time over a peerId-scoped slice of the xfer
 * channel. Disk ops (open/append/commit/abandon/scan/manifest) all funnel
 * through a single private promise chain — the PartWriter `enqueue` idiom
 * (lib/podcast/vault.ts): DataChannel `onmessage` is synchronous while disk
 * ops are async, so without serialization chunk N+1's append could
 * interleave with chunk N's, or a commit could race a park's abandon of the
 * same part. One chain also gives manifest-after-every-commit and
 * abandon-before-rescan ordering for free.
 *
 * Every state transition (adopt, park, fault, dispose) nulls or reassigns
 * `activePart` in the SAME synchronous step it changes `phase`/`epoch` — so
 * a part-level continuation can check `this.activePart === slot` as a
 * complete "has anything superseded me?" test. Episode-level continuations
 * (no slot to compare) instead pin the `epoch` they started under and
 * re-check it via `superseded()`.
 */
export class EpisodeReceiver {
  private phase: ReceiverPhase = "idle";
  private episodeId: string | null = null;
  private files: FilePlan[] | null = null;
  private fromCodename: string | null = null;
  private committedNames = new Set<string>();
  private activePart: ActiveSlot | null = null;
  private disposed = false;
  /** Bumped on every adopt() so an episode-level continuation from a
   *  superseded generation (a park/restart/dispose raced it) can detect it
   *  and drop itself via superseded(). */
  private epoch = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly peerId: string,
    private readonly link: XferLink,
    private readonly store: ReceiverStore,
    private readonly cb: EpisodeReceiverCallbacks,
    // Task 6 (5D): every caller now derives this from the room's never-sent
    // secret (D15 — every call has one) and passes it in; there is no
    // keyless mode any more, which is exactly what makes the enc=0 refusal
    // below unconditional rather than a "keys present" runtime check.
    private readonly xferKey: CryptoKey,
  ) {}

  /** Frames from any OTHER peerId are ignored — the transfer protocol is
   *  peerId-scoped (ledger carry-in; the room seats four). */
  handleFrame(fromPeerId: string, data: string | ArrayBuffer): void {
    if (this.disposed || fromPeerId !== this.peerId) return;
    if (typeof data === "string") {
      const frame = parseXferFrame(data);
      if (!frame) return; // foreign "t" or unparseable JSON — silently ignored, mirrors takeProtocol
      if (frame.t === "xfr/offer") this.onOffer(frame as unknown as Record<string, unknown>);
      else if (frame.t === "xfr/part") this.onPart(frame as unknown as Record<string, unknown>);
      else if (frame.t === "xfr/fault") this.onPeerFault(frame as unknown as Record<string, unknown>);
      // xfr/have, xfr/part-committed and xfr/done are frames THIS class
      // sends, never receives in a well-formed exchange — ignored.
    } else {
      this.onChunk(data);
    }
  }

  /** cos-xfer closed/error mid-transfer -> park (first-class, not an error screen). */
  handleChannelClosed(): void {
    if (this.disposed || this.phase !== "receiving") return;
    const slot = this.activePart;
    this.activePart = null;
    this.phase = "parked";
    this.abandonSlot(slot);
    this.cb.onPhase("parked");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const slot = this.activePart;
    this.activePart = null;
    this.abandonSlot(slot);
  }

  // -- disk-op chain ---------------------------------------------------------

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op); // run regardless of the prior op's outcome
    this.chain = run.then(
      () => undefined,
      () => undefined,
    ); // never rejects — the chain itself must not wedge
    return run;
  }

  private abandonSlot(slot: ActiveSlot | null): void {
    if (!slot) return;
    this.enqueue(async () => {
      if (slot.committed) return; // commit already won the race — never abandon a committed part
      try {
        const part = await slot.partPromise;
        await part.abandon();
      } catch {
        // best-effort — the part may never have finished opening
      }
    });
  }

  /** True once a park/restart/dispose has superseded the episode-level
   *  generation `epoch` was pinned to. */
  private superseded(epoch: number): boolean {
    return this.disposed || this.phase !== "receiving" || epoch !== this.epoch;
  }

  // -- outbound frames ---------------------------------------------------

  private send(frame: XferFrame): void {
    if (this.disposed) return;
    this.link.send(encodeFrame(frame));
  }

  /** The one path to "fault": sends xfr/fault and abandons whatever part is
   *  currently in flight — no fault can ever leak an in-flight temp. */
  private fault(reason: string, episodeId: string = this.episodeId ?? ""): void {
    if (this.disposed) return;
    const slot = this.activePart;
    this.phase = "fault";
    this.activePart = null;
    this.abandonSlot(slot);
    this.send({ t: "xfr/fault", v: 1, episodeId, reason });
    this.cb.onPhase("fault", reason);
  }

  // -- xfr/offer -----------------------------------------------------------

  private onOffer(raw: Record<string, unknown>): void {
    if (!isValidOffer(raw)) {
      const episodeId = typeof raw.episodeId === "string" ? raw.episodeId : (this.episodeId ?? "");
      this.fault("malformed offer", episodeId);
      return;
    }
    const { episodeId, from, files } = raw;

    // Actively receiving a DIFFERENT episode: ignored entirely (the
    // sender's OFFER_TIMEOUT_MS handles the stalled proposer on its side).
    if (this.phase === "receiving" && this.episodeId !== episodeId) return;

    this.adopt(episodeId, from, files);
  }

  /** idle/parked/done/fault -> fresh adopt; receiving the SAME episode ->
   *  clean restart (abandon in-flight part, rescan, re-have). A resumed
   *  episode that turns out to already have every part committed (e.g. a
   *  prior manifest write faulted after every commit had already landed)
   *  finishes right here too — allPartsCommitted() isn't only reachable
   *  from commitPart(). */
  private adopt(episodeId: string, from: string | null, files: FilePlan[]): void {
    const epoch = ++this.epoch;
    const priorSlot = this.activePart;
    this.activePart = null;
    this.episodeId = episodeId;
    this.files = files;
    this.fromCodename = from;
    this.committedNames = new Set();
    this.phase = "receiving";
    this.cb.onPhase("receiving");

    this.abandonSlot(priorSlot);
    this.enqueue(async () => {
      if (this.superseded(epoch)) return;
      try {
        const expected = files.flatMap((f) => f.parts.map((p) => ({ name: p.name, size: p.size })));
        const committed = await this.store.scanCommitted(episodeId, expected);
        if (this.superseded(epoch)) return;
        this.committedNames = new Set(committed);
        this.send({ t: "xfr/have", v: 1, episodeId, committed });
        if (this.allPartsCommitted()) await this.finishEpisode(epoch);
      } catch (err) {
        if (this.superseded(epoch)) return;
        this.fault(`scan:${errMessage(err)}`);
      }
    });
  }

  // -- xfr/fault (inbound) ---------------------------------------------------

  /** `xfr/fault` FROM the sender — they gave up on this episode on their own
   *  side (plan:/open:/read: errors, or a malformed frame from us). PARK,
   *  don't fault: every part already committed is on disk and disk IS the
   *  resume state, so a later re-offer picks up from exactly there, and the
   *  card is dismissible meanwhile. Nothing is sent back — an xfr/fault
   *  reply would just ping-pong the two sides (mirrors
   *  EpisodeSender.onPeerFault). Same transition shape as
   *  handleChannelClosed(): `activePart` is nulled in the SAME synchronous
   *  step `phase` changes, so any queued part-level continuation sees itself
   *  superseded, and the in-flight temp is abandoned rather than leaked. */
  private onPeerFault(raw: Record<string, unknown>): void {
    if (this.disposed || this.phase !== "receiving") return;
    if (typeof raw.episodeId === "string" && raw.episodeId !== this.episodeId) return; // stray fault for a superseded/foreign episode
    const reason = typeof raw.reason === "string" ? raw.reason : "peer fault";
    const slot = this.activePart;
    this.activePart = null;
    this.phase = "parked";
    this.abandonSlot(slot);
    this.cb.onPhase("parked", reason);
  }

  // -- xfr/part + chunks -----------------------------------------------------

  private onPart(raw: Record<string, unknown>): void {
    if (this.phase !== "receiving") return; // stray part frame outside an active receive
    if (!isValidPartFrame(raw)) {
      this.fault("malformed part frame");
      return;
    }
    if (raw.episodeId !== this.episodeId) return; // stray frame for a superseded/foreign episode

    // Sender paces one part at a time (waits for xfr/part-committed before
    // the next xfr/part), so this is defensive rather than an expected path:
    // never leak a temp if it ever does overlap.
    this.abandonSlot(this.activePart);

    const entry: SidecarEntry = { name: raw.name, size: raw.size, sha256: raw.sha256 };
    const episodeId = this.episodeId;
    const slot: ActiveSlot = {
      entry,
      chunksExpected: raw.chunks,
      nextSeq: 0,
      bytesWritten: 0,
      partPromise: null as unknown as Promise<IncomingPart>,
      committed: false,
    };
    slot.partPromise = this.enqueue(() => this.store.openIncomingPart(episodeId, entry));
    this.activePart = slot;

    // A ZERO-CHUNK part has no chunk to ride to completion: `isLast` only
    // ever fires inside onChunk(), so without this the part would never
    // commit, no xfr/part-committed would go out, and BOTH engines would
    // wait forever (the sender's pump has nothing to send either). Real
    // plans can contain one — the recorder's empty-blob drop is
    // forward-only, so a take recorded before it still carries a zero-size
    // sidecar entry, and lastTakeId persists. Committing straight from the
    // announcement is safe rather than trusting: commit() verifies the
    // written bytes against `entry.sha256`, and SHA-256 of zero bytes is a
    // perfectly ordinary hash — a part that claims chunks: 0 but a nonzero
    // size simply fails that check and faults, exactly like any other
    // mismatch. Queued behind the open above (one chain, so ordering is
    // free) and slot-identity-checked like every other continuation.
    if (slot.chunksExpected === 0) {
      this.enqueue(async () => {
        if (this.activePart !== slot) return; // superseded by fault/park/restart/dispose while queued
        try {
          await this.commitPart(slot);
        } catch (err) {
          if (this.activePart !== slot || this.disposed) return;
          this.fault(`open:${errMessage(err)}`); // only reachable if the open itself rejected — commitPart faults on its own for commit errors
        }
      });
    }
  }

  private onChunk(buf: ArrayBuffer): void {
    if (this.phase !== "receiving") return; // stray/late binary frame — quietly dropped

    const envelope = decodeChunk(buf);
    if (!envelope) {
      this.fault("malformed chunk");
      return;
    }
    if (!this.activePart) {
      this.fault("chunk with no announced part");
      return;
    }
    // 5D: xferKey is a mandatory constructor dep now (no keyless mode), so
    // "keys are present" is always true — enc=0 is unconditionally a
    // plaintext-downgrade attempt, never a legitimate frame. Same fault path
    // as any other malformed/adversarial chunk (named fault, park semantics
    // untouched); it fails BEFORE the seq/count checks below so a downgrade
    // attempt can never be laundered through the ordering logic first.
    if (envelope.enc !== 1) {
      this.fault(`unexpected enc=${envelope.enc}`);
      return;
    }
    const slot = this.activePart;
    // Bounded strictly by the announced count, not merely by matching
    // nextSeq: once every expected chunk has arrived, ANY further chunk
    // must fault immediately — a straggler whose seq happens to equal
    // nextSeq must never silently slip through while the commit it trails
    // is still in flight (it would only be caught by accident, and only
    // sometimes, depending on how far that commit had gotten).
    if (slot.nextSeq >= slot.chunksExpected) {
      this.fault("chunk past announced count");
      return;
    }
    if (envelope.seq !== slot.nextSeq) {
      this.fault(`chunk seq ${envelope.seq}, expected ${slot.nextSeq}`);
      return;
    }

    slot.nextSeq += 1;
    const isLast = slot.nextSeq === slot.chunksExpected;
    const iv = envelope.iv;
    const ciphertext = envelope.payload;

    this.enqueue(async () => {
      if (this.activePart !== slot) return; // superseded by fault/park/restart/dispose while queued
      // Decrypt BEFORE the existing verify/commit path — sidecar hashes stay
      // hashes of PLAINTEXT bytes, so this must happen first and unwrap
      // completely; a bad tag (tamper, wrong key, truncation) yields null
      // and faults here rather than ever reaching append()/commit().
      const plain = await decryptFrame(this.xferKey, ivAndCiphertext(iv, ciphertext));
      if (plain === null) {
        if (this.activePart !== slot || this.disposed) return; // superseded while decrypting
        this.fault("decrypt failed");
        return;
      }
      const payload = new Uint8Array(plain);
      try {
        const part = await slot.partPromise;
        await part.append(payload);
        slot.bytesWritten += payload.length;
        if (this.disposed) return;
        this.cb.onProgress({
          file: slot.entry.name,
          committedBytes: slot.bytesWritten,
          totalBytes: slot.entry.size,
          fromCodename: this.fromCodename,
        });
        if (isLast) await this.commitPart(slot);
      } catch (err) {
        if (this.activePart !== slot || this.disposed) return;
        this.fault(`append:${errMessage(err)}`);
      }
    });
  }

  private async commitPart(slot: ActiveSlot): Promise<void> {
    const part = await slot.partPromise;
    try {
      await part.commit();
    } catch (err) {
      if (this.activePart !== slot || this.disposed) return; // superseded while the commit was in flight
      const reason = err instanceof HashMismatchError ? `hash-mismatch:${err.partName}` : `commit:${errMessage(err)}`;
      this.fault(reason);
      return;
    }
    // Disk truth from here regardless of what raced it: never abandon this
    // part again (Task 5 advisory — commit and abandon are mutually
    // exclusive), set BEFORE the supersession check below so a concurrently
    // queued abandon (from whatever superseded us) sees it once its turn
    // on the chain comes up.
    slot.committed = true;
    this.committedNames.add(slot.entry.name);
    if (this.activePart !== slot || this.disposed) return; // a park/restart/dispose raced the commit to the finish line — disk is correct, nothing more to send for this generation
    this.activePart = null;
    this.send({ t: "xfr/part-committed", v: 1, episodeId: this.episodeId ?? "", name: slot.entry.name });
    if (this.allPartsCommitted()) await this.finishEpisode(this.epoch);
  }

  private allPartsCommitted(): boolean {
    if (!this.files) return false;
    for (const f of this.files) {
      for (const p of f.parts) {
        if (!this.committedNames.has(p.name)) return false;
      }
    }
    return true;
  }

  private buildRemoteLists(): { video: SidecarEntry[]; audio: SidecarEntry[] } {
    const video = this.files?.find((f) => f.base === "video")?.parts ?? [];
    const audio = this.files?.find((f) => f.base === "audio")?.parts ?? [];
    return { video, audio };
  }

  /** Manifest strictly after every commit — it is the 5C darkroom's
   *  trigger. A rejection (e.g. a corrupt local sidecar propagating per
   *  episodeStore's writeManifest contract) is a fault, not a crash: a
   *  later re-offer of the same episode rescans, finds all parts already
   *  committed, and adopt()'s own allPartsCommitted() check retries the
   *  manifest right there — that IS the recovery. `epoch` pins this call to
   *  the generation that earned it, so a park/restart racing the
   *  writeManifest() await can't resurrect a done/fault frame for a
   *  generation that has already moved on. */
  private async finishEpisode(epoch: number): Promise<void> {
    const remote = this.buildRemoteLists();
    const episodeId = this.episodeId ?? "";
    try {
      await this.store.writeManifest(episodeId, remote, this.fromCodename);
    } catch (err) {
      if (this.superseded(epoch)) return;
      this.fault(`manifest:${errMessage(err)}`, episodeId);
      return;
    }
    if (this.superseded(epoch)) return;
    this.phase = "done";
    this.send({ t: "xfr/done", v: 1, episodeId });
    this.cb.onPhase("done");
  }
}

// ---------------------------------------------------------------------------
// SENDER (Task 7)
// ---------------------------------------------------------------------------

export interface SenderStore {
  readSendPlan(episodeId: string): Promise<FilePlan[]>;
  openPartReader(episodeId: string, name: string): Promise<PartReader>;
}

export type SenderPhase = "idle" | "offering" | "sending" | "parked" | "done" | "fault";

export interface SendProgress {
  file: string;
  sentBytes: number;
  totalBytes: number;
  resumedParts: number;
}

export interface EpisodeSenderCallbacks {
  onPhase(phase: SenderPhase, detail?: string): void;
  onProgress(p: SendProgress): void;
}

function isValidHave(x: Record<string, unknown>): x is { episodeId: string; committed: string[] } {
  return typeof x.episodeId === "string" && Array.isArray(x.committed) && x.committed.every((c) => typeof c === "string");
}

function isValidPartCommitted(x: Record<string, unknown>): x is { episodeId: string; name: string } {
  return typeof x.episodeId === "string" && typeof x.name === "string";
}

/** Reorders `files` audio-first — a wire contract, so enforced here rather
 *  than trusted from the store (readSendPlan already promises this order,
 *  but defensively). */
function orderAudioFirst(files: FilePlan[]): FilePlan[] {
  const audio = files.find((f) => f.base === "audio");
  const video = files.find((f) => f.base === "video");
  return [audio, video].filter((f): f is FilePlan => f !== undefined);
}

/** Every part of every plan file, audio file first, parts in sidecar order —
 *  the full-episode part list the offer's ordering rule and the send queue
 *  are both built from. */
function flattenParts(files: FilePlan[]): SidecarEntry[] {
  return orderAudioFirst(files).flatMap((f) => f.parts);
}

interface SenderSlot {
  entry: SidecarEntry;
  reader: PartReader;
  chunksExpected: number;
  nextSeq: number;
}

/**
 * Sends one episode at a time over a peerId-scoped slice of the xfer
 * channel. Exactly one part is ever in flight: the next `xfr/part` is
 * announced only after the current one's `xfr/part-committed` ack arrives —
 * NOT merely after every chunk has been pumped. This is LOAD-BEARING, not
 * just flow control: EpisodeReceiver suppresses a superseded part's
 * `part-committed` if a new `xfr/part` arrives before its ack goes out, so
 * announcing the next part early can silently drop an ack the resume state
 * depends on.
 *
 * The receiver's `have` list is the ONLY resume state (mirrors
 * EpisodeReceiver's scanCommitted() on the wire) — this class never trusts
 * its own prior sent-count; every `start()` rebuilds the send queue purely
 * from whatever `have` comes back.
 *
 * Same epoch/identity discipline as EpisodeReceiver: every state transition
 * nulls or reassigns `activeSlot` in the same synchronous step it changes
 * `phase`/`epoch`, so `pump()` can check `this.activeSlot === slot` after
 * an `await` as a complete "was I superseded?" test; episode-level
 * continuations (no slot to compare) pin `epoch` instead and re-check it
 * via `superseded()`.
 */
export class EpisodeSender {
  private phase: SenderPhase = "idle";
  private episodeId: string | null = null;
  private fromCodename: string | null = null;
  private files: FilePlan[] | null = null;
  private queue: SidecarEntry[] = [];
  private activeSlot: SenderSlot | null = null;
  private disposed = false;
  /** Bumped on every start() so an episode-level continuation from a
   *  superseded generation (a fault/park/restart raced it) can detect it
   *  and drop itself via superseded(). */
  private epoch = 0;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-entrancy guard for pump() — see pump()'s own comment. */
  private pumping = false;
  /** Set when a pump() call arrives while another is in flight — the
   *  in-flight call reruns the drain loop before releasing the guard, so a
   *  swallowed call is never LOST (see pump()'s own comment: the swallowed
   *  call may have been the only one coming for a brand-new generation). */
  private pumpQueued = false;
  /** One IvState per sender CONSTRUCTION — where "construction" means each
   *  start() call, not just the class instance: start() is the manual-resume
   *  entry point ("pressing SEND again re-offers", spec verbatim) and this
   *  engine instance survives a park/resume cycle (Task 11 keeps one sender
   *  per send()/resend() call, but within a single instance start() can also
   *  be re-invoked directly, e.g. after a peer-side xfr/fault — see
   *  episode-sender.test.ts case (f)). Rebuilding it fresh in start() is
   *  what gives every resume a fresh 32-bit prefix — reusing the prior
   *  instance's counter+prefix across a resume would be a nonce reuse
   *  (Global Constraints, load-bearing). Assigned a throwaway instance here
   *  only so TS sees a definite value before the first start(); pump() is
   *  never reachable before start() runs. */
  private ivState = new IvState();

  // Progress accounting: sentBytes = bytes pumped over the wire this
  // session + committed-part sizes reported via `have` on resume; totalBytes
  // is the whole episode's size, not just the active part's.
  private resumedParts = 0;
  private totalBytes = 0;
  private baseSentBytes = 0;
  private sentBytesThisSession = 0;

  /** deps.now parity with other podcast state machines; unused today — the
   *  offer timeout is a real setTimeout, faked via vi.useFakeTimers. */
  private readonly nowFn: () => number;

  constructor(
    private readonly peerId: string,
    private readonly link: XferLink,
    private readonly store: SenderStore,
    private readonly cb: EpisodeSenderCallbacks,
    // Task 6 (5D): mandatory now — see EpisodeReceiver's constructor comment.
    private readonly xferKey: CryptoKey,
    deps?: { now?: () => number },
  ) {
    this.nowFn = deps?.now ?? Date.now;
  }

  /** SEND EPISODE. Reads the plan, sends xfr/offer, arms OFFER_TIMEOUT_MS →
   *  parked if unanswered. Re-invocable from ANY phase — including
   *  mid-transfer — since bumping `epoch` cleanly supersedes whatever
   *  generation was active; this is the manual resume ("pressing SEND
   *  again re-offers", spec verbatim) from parked/done/fault alike. */
  start(episodeId: string, fromCodename: string | null): void {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.clearOfferTimer();
    this.activeSlot = null; // no disk resource to release on the sender side — just drop the reference
    // Fresh IvState EVERY start() — see the field's own comment: this is the
    // resume path, and a resume that reused the prior instance's counter
    // under the same 32-bit prefix would be a nonce-reuse break.
    this.ivState = new IvState();
    this.episodeId = episodeId;
    this.fromCodename = fromCodename;
    this.files = null;
    this.queue = [];
    this.resumedParts = 0;
    this.totalBytes = 0;
    this.baseSentBytes = 0;
    this.sentBytesThisSession = 0;
    this.phase = "offering";
    this.cb.onPhase("offering");

    this.store.readSendPlan(episodeId).then(
      (files) => {
        if (this.superseded(epoch)) return;
        const ordered = orderAudioFirst(files);
        this.files = ordered;
        this.send({ t: "xfr/offer", v: 1, episodeId, from: fromCodename, files: ordered });
        this.armOfferTimeout(epoch);
      },
      (err) => {
        if (this.superseded(epoch)) return;
        this.fault(`plan:${errMessage(err)}`);
      },
    );
  }

  /** Frames from any OTHER peerId are ignored — mirrors EpisodeReceiver
   *  (the transfer protocol is peerId-scoped). */
  handleFrame(fromPeerId: string, data: string | ArrayBuffer): void {
    if (this.disposed || fromPeerId !== this.peerId) return;
    if (typeof data !== "string") return; // no binary frame is ever sent TO the sender in 5B — chunks flow sender -> receiver only
    const frame = parseXferFrame(data);
    if (!frame) return; // foreign "t" or unparseable JSON — silently ignored, mirrors EpisodeReceiver
    if (frame.t === "xfr/have") this.onHave(frame as unknown as Record<string, unknown>);
    else if (frame.t === "xfr/part-committed") this.onPartCommitted(frame as unknown as Record<string, unknown>);
    else if (frame.t === "xfr/fault") this.onPeerFault(frame as unknown as Record<string, unknown>);
    else if (frame.t === "xfr/done") this.onDone(frame as unknown as Record<string, unknown>);
    // xfr/offer, xfr/part are frames THIS class sends, never receives.
  }

  /** bufferedamountlow -> resume the pump. */
  handleDrain(): void {
    void this.pump();
  }

  /** cos-xfer closed/error mid-transfer -> park (first-class, not an error screen). */
  handleChannelClosed(): void {
    if (this.disposed) return;
    if (this.phase !== "offering" && this.phase !== "sending") return;
    this.park();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearOfferTimer();
    this.activeSlot = null;
  }

  // -- outbound frames / shared helpers --------------------------------------

  private send(frame: XferFrame): void {
    if (this.disposed) return;
    this.link.send(encodeFrame(frame));
  }

  /** True once a fault/park/restart/dispose has superseded the generation
   *  `epoch` was pinned to. Checks `phase` as well as `epoch` (mirrors
   *  EpisodeReceiver's `superseded()`) — park()/fault() don't bump `epoch`
   *  themselves, so a pending continuation from the SAME start() call (not
   *  just a later one) must still be caught: a park mid-readSendPlan or
   *  mid-openPartReader must not resurrect an xfr/offer, an offer-timeout
   *  arm, or an xfr/fault once the channel is already gone. */
  private superseded(epoch: number): boolean {
    return this.disposed || (this.phase !== "offering" && this.phase !== "sending") || epoch !== this.epoch;
  }

  private clearOfferTimer(): void {
    if (this.offerTimer !== null) {
      clearTimeout(this.offerTimer);
      this.offerTimer = null;
    }
  }

  private armOfferTimeout(epoch: number): void {
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null;
      if (this.superseded(epoch) || this.phase !== "offering") return; // xfr/have already arrived
      this.phase = "parked";
      this.cb.onPhase("parked", "offer timeout");
    }, OFFER_TIMEOUT_MS);
  }

  /** The one path to a SENDER-initiated fault: sends xfr/fault to the peer,
   *  then enters the fault phase — no in-flight temp to abandon on this
   *  side (that's the receiver's concern), just drop the active slot. A
   *  later start() re-offers. */
  private fault(reason: string): void {
    if (this.disposed) return;
    this.clearOfferTimer();
    this.activeSlot = null;
    this.phase = "fault";
    this.send({ t: "xfr/fault", v: 1, episodeId: this.episodeId ?? "", reason });
    this.cb.onPhase("fault", reason);
  }

  private park(): void {
    if (this.disposed) return;
    this.clearOfferTimer();
    this.activeSlot = null;
    this.phase = "parked";
    this.cb.onPhase("parked");
  }

  private progressSnapshot(file: string): SendProgress {
    return {
      file,
      sentBytes: this.baseSentBytes + this.sentBytesThisSession,
      totalBytes: this.totalBytes,
      resumedParts: this.resumedParts,
    };
  }

  // -- xfr/have ----------------------------------------------------------

  private onHave(raw: Record<string, unknown>): void {
    // Phase gate FIRST, body validation second (mirrors EpisodeReceiver's
    // onPart) — a `have` outside an active offer is just a stray/late frame,
    // and a GARBAGE one must never be able to fault a transfer that has
    // already moved on to sending/parked/done: faulting here would send
    // xfr/fault to a peer that may have already written its manifest.
    if (this.phase !== "offering") return;
    if (!isValidHave(raw)) {
      this.fault("malformed have");
      return;
    }
    if (raw.episodeId !== this.episodeId) return; // stray for a superseded/foreign episode
    const files = this.files;
    if (!files) return; // have can't legitimately precede our own offer resolving — defensive only

    this.clearOfferTimer();

    // Task 5 advisory (binding): treat `have` defensively — send queue =
    // plan MINUS have via set difference (an unknown name, e.g. a stray
    // .DS_Store, drops out of the filter below); resumedParts is the
    // INTERSECTION count (|have ∩ plan|), never have.length.
    const haveSet = new Set(raw.committed);
    const flat = flattenParts(files);
    let resumedParts = 0;
    let baseSentBytes = 0;
    for (const part of flat) {
      if (haveSet.has(part.name)) {
        resumedParts += 1;
        baseSentBytes += part.size; // guarded by name — only sizes for parts actually in the plan count
      }
    }
    this.resumedParts = resumedParts;
    this.baseSentBytes = baseSentBytes;
    this.totalBytes = flat.reduce((sum, p) => sum + p.size, 0);
    this.sentBytesThisSession = 0;
    this.queue = flat.filter((p) => !haveSet.has(p.name));

    this.phase = "sending";
    this.cb.onPhase("sending");
    void this.announceNextPart();
  }

  // -- xfr/part + backpressure pump ---------------------------------------

  private async announceNextPart(): Promise<void> {
    const epoch = this.epoch;
    if (this.queue.length === 0) return; // nothing left to send from here — the receiver's own commit-completion sends xfr/done
    const entry = this.queue.shift()!;
    const episodeId = this.episodeId;
    if (episodeId === null) return;

    let reader: PartReader;
    try {
      reader = await this.store.openPartReader(episodeId, entry.name);
    } catch (err) {
      if (this.superseded(epoch)) return;
      this.fault(`open:${errMessage(err)}`);
      return;
    }
    if (this.superseded(epoch) || this.phase !== "sending") return;

    const chunksExpected = Math.ceil(entry.size / XFER_CHUNK_BYTES);
    const slot: SenderSlot = { entry, reader, chunksExpected, nextSeq: 0 };
    this.activeSlot = slot;
    this.send({ t: "xfr/part", v: 1, episodeId, name: entry.name, size: entry.size, sha256: entry.sha256, chunks: chunksExpected });
    this.cb.onProgress(this.progressSnapshot(entry.name));
    void this.pump();
  }

  /** Drains as many chunks of the announced part as backpressure allows in
   *  one go — "loop until blocked". Re-entrancy-safe: `bufferedamountlow`
   *  (handleDrain) can fire while a PREVIOUS call's `reader.read()` is
   *  still in flight (both are async DC events), so a second concurrent
   *  call would otherwise race the first and double-send. The `pumping`
   *  flag guards that — but it COALESCES rather than swallows: a re-entrant
   *  call sets `pumpQueued` and the in-flight call reruns the drain loop
   *  before releasing the guard. Swallowing outright was the ledgered
   *  stuck-in-sending bug — a mid-flight start() (manual re-offer) both
   *  supersedes the in-flight pump AND issues the new generation's only
   *  pump() call while the guard is still held; the superseded pump then
   *  exits without sending anything, and with the channel buffer already
   *  below the low-water mark no bufferedamountlow ever comes to rescue
   *  the new slot. The rerun re-reads `activeSlot`/`phase` fresh, so it
   *  drains whatever generation is CURRENT (or exits immediately if the
   *  queued call is stale — same checks the loop always made). */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpQueued = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpQueued = false;
        await this.drainLoop();
      } while (this.pumpQueued);
    } finally {
      this.pumping = false;
    }
  }

  /** pump()'s body — one full "loop until blocked" pass. Only ever called
   *  with the `pumping` guard held. */
  private async drainLoop(): Promise<void> {
    for (;;) {
      const slot = this.activeSlot;
      if (!slot || this.phase !== "sending" || this.disposed) return;
      if (slot.nextSeq >= slot.chunksExpected) return; // part fully sent; now awaiting xfr/part-committed
      if (this.link.bufferedAmount() >= XFER_HIGH_WATER) return; // handleDrain resumes

      const seq = slot.nextSeq;
      const offset = seq * XFER_CHUNK_BYTES;
      const length = Math.min(XFER_CHUNK_BYTES, slot.entry.size - offset);
      let payload: Uint8Array;
      try {
        payload = await slot.reader.read(offset, length);
      } catch (err) {
        if (this.activeSlot !== slot || this.phase !== "sending" || this.disposed) return;
        this.fault(`read:${errMessage(err)}`);
        return;
      }
      if (this.activeSlot !== slot || this.phase !== "sending" || this.disposed) return; // superseded while the read was in flight

      // D17: encrypt before sending — the envelope's `iv` slot carries the
      // frame cipher's own IV, so the leading 12 bytes of encryptFrame's
      // output are split off into the envelope header rather than
      // duplicated inside the payload (see xferProtocol.ts's encodeChunk).
      let encrypted: ArrayBuffer;
      try {
        // `payload` is typed as bare `Uint8Array` (TS default:
        // `Uint8Array<ArrayBufferLike>`) per PartReader's public interface,
        // so `.buffer.slice(...)` widens to `ArrayBuffer | SharedArrayBuffer`
        // under TS 5.7's typed-array generics. Real readers always hand back
        // ArrayBuffer-backed views (disk reads are never SharedArrayBuffer)
        // — same idiom as episodeStore.ts's append() cast.
        const bytes = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
        encrypted = await encryptFrame(this.xferKey, this.ivState, bytes);
      } catch (err) {
        if (this.activeSlot !== slot || this.phase !== "sending" || this.disposed) return;
        this.fault(`encrypt:${errMessage(err)}`);
        return;
      }
      if (this.activeSlot !== slot || this.phase !== "sending" || this.disposed) return; // superseded while encrypting
      const iv = new Uint8Array(encrypted, 0, 12);
      const ciphertext = new Uint8Array(encrypted, 12);

      const ok = this.link.send(encodeChunk(seq, ciphertext, iv));
      if (!ok) {
        this.park(); // the channel died between events
        return;
      }
      slot.nextSeq += 1;
      this.sentBytesThisSession += payload.length;
      this.cb.onProgress(this.progressSnapshot(slot.entry.name));
    }
  }

  // -- xfr/part-committed / xfr/fault / xfr/done --------------------------

  private onPartCommitted(raw: Record<string, unknown>): void {
    // Phase gate FIRST — same reasoning as onHave above.
    if (this.phase !== "sending") return;
    if (!isValidPartCommitted(raw)) {
      this.fault("malformed part-committed");
      return;
    }
    if (raw.episodeId !== this.episodeId) return;
    const slot = this.activeSlot;
    if (!slot || raw.name !== slot.entry.name) return; // stray/late ack for a part we're not actively awaiting — ignored defensively
    if (slot.nextSeq < slot.chunksExpected) return; // ack for a part we haven't finished pumping — protocol anomaly, ignored rather than trusted
    this.activeSlot = null; // next part announced ONLY now — see the class comment (load-bearing)
    void this.announceNextPart();
  }

  /** `xfr/fault` FROM the receiver — reflects their reason into our own
   *  fault phase and sends nothing back (an internal fault() reply here
   *  would just ping-pong the two sides). */
  private onPeerFault(raw: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.phase !== "offering" && this.phase !== "sending") return;
    if (typeof raw.episodeId === "string" && raw.episodeId !== this.episodeId) return;
    const reason = typeof raw.reason === "string" ? raw.reason : "peer fault";
    this.clearOfferTimer();
    this.activeSlot = null;
    this.phase = "fault";
    this.cb.onPhase("fault", reason);
  }

  private onDone(raw: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.phase !== "sending") return;
    if (typeof raw.episodeId === "string" && raw.episodeId !== this.episodeId) return;
    this.clearOfferTimer();
    this.activeSlot = null;
    this.phase = "done";
    this.cb.onPhase("done");
  }
}
