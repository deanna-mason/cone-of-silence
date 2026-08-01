// Episode-exchange engines, driven over the cos-xfer data channel via
// xferProtocol.ts's frames/envelope. This half (Task 6) is the RECEIVER:
// EpisodeReceiver. Task 7 adds the sender counterpart to this same file.
//
// scanCommitted() IS the resume state (episodeStore.ts) — `committedNames`
// below is just an in-memory mirror of it, used to detect "last part of the
// last file" so the manifest (the 5C darkroom's trigger) writes strictly
// after every commit.
import { HashMismatchError, type IncomingPart } from "./episodeStore";
import type { SidecarEntry } from "./vault";
import { decodeChunk, encodeFrame, parseXferFrame, type FilePlan, type XferFrame } from "./xferProtocol";

/** Narrow per-peer slice of the XferPort, injectable for tests. */
export interface XferLink {
  send(data: string | ArrayBuffer): boolean;
  bufferedAmount(): number;
}

export interface ReceiverStore {
  scanCommitted(episodeId: string): Promise<string[]>;
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
 */
export class EpisodeReceiver {
  private phase: ReceiverPhase = "idle";
  private episodeId: string | null = null;
  private files: FilePlan[] | null = null;
  private fromCodename: string | null = null;
  private committedNames = new Set<string>();
  private activePart: ActiveSlot | null = null;
  private disposed = false;
  /** Bumped on every adopt() so a scan/have from a superseded offer is dropped silently. */
  private epoch = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly peerId: string,
    private readonly link: XferLink,
    private readonly store: ReceiverStore,
    private readonly cb: EpisodeReceiverCallbacks,
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
      // xfr/have, xfr/part-committed, xfr/done, xfr/fault are frames THIS
      // class sends, never receives in a well-formed exchange — ignored.
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
      try {
        const part = await slot.partPromise;
        await part.abandon();
      } catch {
        // best-effort — the part may never have finished opening
      }
    });
  }

  // -- outbound frames ---------------------------------------------------

  private send(frame: XferFrame): void {
    if (this.disposed) return;
    this.link.send(encodeFrame(frame));
  }

  private enterFault(episodeId: string, reason: string): void {
    if (this.disposed) return;
    this.phase = "fault";
    this.activePart = null;
    this.send({ t: "xfr/fault", v: 1, episodeId, reason });
    this.cb.onPhase("fault", reason);
  }

  /** A protocol fault tied to the currently in-flight part: sends xfr/fault
   *  and abandons that part (never re-committed, never mistaken for done). */
  private faultAbandoningActive(reason: string): void {
    const slot = this.activePart;
    const episodeId = this.episodeId ?? "";
    this.enterFault(episodeId, reason);
    this.abandonSlot(slot);
  }

  // -- xfr/offer -----------------------------------------------------------

  private onOffer(raw: Record<string, unknown>): void {
    if (!isValidOffer(raw)) {
      const episodeId = typeof raw.episodeId === "string" ? raw.episodeId : (this.episodeId ?? "");
      this.enterFault(episodeId, "malformed offer");
      return;
    }
    const { episodeId, from, files } = raw;

    // Actively receiving a DIFFERENT episode: ignored entirely (the
    // sender's OFFER_TIMEOUT_MS handles the stalled proposer on its side).
    if (this.phase === "receiving" && this.episodeId !== episodeId) return;

    this.adopt(episodeId, from, files);
  }

  /** idle/parked/done/fault -> fresh adopt; receiving the SAME episode ->
   *  clean restart (abandon in-flight part, rescan, re-have). */
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
      if (this.disposed || epoch !== this.epoch) return;
      try {
        const committed = await this.store.scanCommitted(episodeId);
        if (this.disposed || epoch !== this.epoch) return;
        this.committedNames = new Set(committed);
        this.send({ t: "xfr/have", v: 1, episodeId, committed });
      } catch (err) {
        if (this.disposed || epoch !== this.epoch) return;
        this.enterFault(episodeId, `scan:${errMessage(err)}`);
      }
    });
  }

  // -- xfr/part + chunks -----------------------------------------------------

  private onPart(raw: Record<string, unknown>): void {
    if (this.phase !== "receiving") return; // stray part frame outside an active receive
    if (!isValidPartFrame(raw)) {
      this.faultAbandoningActive("malformed part frame");
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
    };
    slot.partPromise = this.enqueue(() => this.store.openIncomingPart(episodeId, entry));
    this.activePart = slot;
  }

  private onChunk(buf: ArrayBuffer): void {
    if (this.phase !== "receiving") return; // stray/late binary frame — quietly dropped

    const envelope = decodeChunk(buf);
    if (!envelope) {
      this.faultAbandoningActive("malformed chunk");
      return;
    }
    if (!this.activePart) {
      this.faultAbandoningActive("chunk with no announced part");
      return;
    }
    if (envelope.enc !== 0) {
      this.faultAbandoningActive(`unexpected enc=${envelope.enc}`); // 5B always plaintext; 5D will accept enc=1
      return;
    }
    const slot = this.activePart;
    if (envelope.seq !== slot.nextSeq) {
      this.faultAbandoningActive(`chunk seq ${envelope.seq}, expected ${slot.nextSeq}`);
      return;
    }

    slot.nextSeq += 1;
    const isLast = slot.nextSeq === slot.chunksExpected;
    const payload = envelope.payload;

    this.enqueue(async () => {
      if (this.activePart !== slot) return; // superseded by fault/park/restart/dispose while queued
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
        this.faultAbandoningActive(`append:${errMessage(err)}`);
      }
    });
  }

  private async commitPart(slot: ActiveSlot): Promise<void> {
    const part = await slot.partPromise;
    try {
      await part.commit();
    } catch (err) {
      if (this.disposed) return;
      // The store already deleted the temp on a hash mismatch (episodeStore
      // contract) — no abandon() needed; a future re-offer re-sends it,
      // that IS the recovery.
      const reason = err instanceof HashMismatchError ? `hash-mismatch:${err.partName}` : `commit:${errMessage(err)}`;
      this.enterFault(this.episodeId ?? "", reason);
      return;
    }
    if (this.activePart === slot) this.activePart = null;
    this.committedNames.add(slot.entry.name);
    if (this.disposed) return;
    this.send({ t: "xfr/part-committed", v: 1, episodeId: this.episodeId ?? "", name: slot.entry.name });
    if (this.allPartsCommitted()) await this.finishEpisode();
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
   *  committed, and retries the manifest — that IS the recovery. */
  private async finishEpisode(): Promise<void> {
    const remote = this.buildRemoteLists();
    try {
      await this.store.writeManifest(this.episodeId ?? "", remote, this.fromCodename);
    } catch (err) {
      if (this.disposed) return;
      this.enterFault(this.episodeId ?? "", `manifest:${errMessage(err)}`);
      return;
    }
    if (this.disposed) return;
    this.phase = "done";
    this.send({ t: "xfr/done", v: 1, episodeId: this.episodeId ?? "" });
    this.cb.onPhase("done");
  }
}
