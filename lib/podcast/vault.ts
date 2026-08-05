// Tape Vault: persists the user's chosen recording folder (a
// FileSystemDirectoryHandle, via IndexedDB) across reloads, and streams a
// browser recording to disk as ~60s part-files with SHA-256 sidecar hashes.
//
// A FileSystemWritableFileStream only commits bytes at close() (atomic
// swap) — THAT is why parts exist: each closed part is durable, so a crash
// loses at most the currently-open part. Never keepExistingData, never
// reopen a closed part.

const DB_NAME = "cos-podcast";
const DB_VERSION = 1;
const STORE = "vault";
const DIR_KEY = "dir";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export type VaultPermission = "granted" | "prompt" | "unset"; // unset = never chosen

async function storedHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  return idbGet<FileSystemDirectoryHandle>(DIR_KEY);
}

/** User gesture: opens the OS folder picker and persists the chosen handle. */
export async function chooseVault(): Promise<void> {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await idbSet(DIR_KEY, handle);
}

export async function vaultPermission(): Promise<VaultPermission> {
  const handle = await storedHandle();
  if (!handle) return "unset";
  const state = await handle.queryPermission({ mode: "readwrite" });
  return state === "granted" ? "granted" : "prompt";
}

/** User gesture: prompts for permission on the already-stored handle. */
export async function requestVaultAccess(): Promise<VaultPermission> {
  const handle = await storedHandle();
  if (!handle) return "unset";
  const state = await handle.requestPermission({ mode: "readwrite" });
  return state === "granted" ? "granted" : "prompt";
}

export async function openTakeDir(takeId: string): Promise<FileSystemDirectoryHandle> {
  const handle = await storedHandle();
  if (!handle) throw new Error("no recording vault has been chosen yet");
  return handle.getDirectoryHandle(takeId, { create: true });
}

export interface SidecarEntry {
  name: string;
  size: number;
  sha256: string;
}
export const PART_TARGET_MS = 60_000;

function partName(base: string, index: number): string {
  return `${base}.part${String(index).padStart(3, "0")}`;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class PartWriter {
  bytesWritten = 0; // committed + in-flight, feeds a live UI gauge

  private readonly quota: number; // appends per part
  private readonly parts: SidecarEntry[] = [];
  private partIndex = 0;
  private appendsInPart = 0;
  private writable: FileSystemWritableFileStream | null = null;

  // Serializes every append()/finish() call. MediaRecorder's ondataavailable
  // fires ~1/s regardless of how long the previous disk write took, so two
  // append() calls (or a finish() racing a pending append()) CAN overlap —
  // without this, both would see `writable` unset and each open their own
  // writable on the SAME part file, and the loser's bytes vanish silently.
  // Same per-entry `chain` idiom as lib/webrtc/mesh.ts's feed(), adapted so
  // each caller still gets ITS OWN rejection: `run` (returned to the caller)
  // carries the real outcome, while `this.chain` — what the NEXT call links
  // onto — is folded back to always-resolved, so one busted operation can't
  // permanently wedge the ones queued behind it.
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: FileSystemDirectoryHandle,
    private readonly base: "video" | "audio",
    timesliceMs = 1000,
    /** Extra top-level keys serialized into the sidecar JSON — provenance
     *  (e.g. echoGuard), never structural. base/parts always win. */
    private readonly sidecarExtra: Record<string, unknown> = {},
  ) {
    this.quota = Math.ceil(PART_TARGET_MS / timesliceMs);
  }

  /** Write into the open part; rolls over once this part has PART_TARGET_MS of appends. */
  async append(blob: Blob): Promise<void> {
    return this.enqueue(() => this.appendLocked(blob));
  }

  /** Closes the final part (if open), hashes every part, and writes the sidecar JSON. */
  async finish(): Promise<SidecarEntry[]> {
    return this.enqueue(() => this.finishLocked());
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op); // run regardless of the prior op's outcome
    this.chain = run.then(
      () => undefined,
      () => undefined,
    ); // never rejects — the chain itself must not wedge
    return run; // this call's own settlement, rejection included
  }

  private async appendLocked(blob: Blob): Promise<void> {
    if (!this.writable) {
      const fh = await this.dir.getFileHandle(partName(this.base, this.partIndex), { create: true });
      this.writable = await fh.createWritable(); // never keepExistingData — parts commit only via close()
    }
    await this.writable.write(blob);
    this.bytesWritten += blob.size;
    this.appendsInPart += 1;
    if (this.appendsInPart >= this.quota) {
      await this.closeCurrentPart();
    }
  }

  private async finishLocked(): Promise<SidecarEntry[]> {
    if (this.writable) await this.closeCurrentPart();
    const sidecar = await this.dir.getFileHandle(`${this.base}.sidecar.json`, { create: true });
    const writable = await sidecar.createWritable();
    await writable.write(JSON.stringify({ ...this.sidecarExtra, base: this.base, parts: this.parts }, null, 2));
    await writable.close();
    return this.parts;
  }

  private async closeCurrentPart(): Promise<void> {
    const writable = this.writable!;
    const name = partName(this.base, this.partIndex);
    await writable.close(); // atomic swap: bytes are durable from this point on
    const fh = await this.dir.getFileHandle(name, { create: true });
    const file = await fh.getFile();
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    this.parts.push({ name, size: file.size, sha256: toHex(digest) });
    this.writable = null;
    this.appendsInPart = 0;
    this.partIndex += 1;
  }
}
