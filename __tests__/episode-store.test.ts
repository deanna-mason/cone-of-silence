import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseVault, openTakeDir, type SidecarEntry } from "@/lib/podcast/vault";
import {
  HashMismatchError,
  INCOMING_PREFIX,
  MANIFEST_NAME,
  REMOTE_DIR,
  openIncomingPart,
  openPartReader,
  readSendPlan,
  scanCommitted,
  writeManifest,
} from "@/lib/podcast/episodeStore";

// Same jsdom/Node WebCrypto realm quirk vault.test.ts documents and
// polyfills: jsdom's Blob.arrayBuffer() satisfies `instanceof ArrayBuffer`
// but fails Node's WebCrypto digest() validation. structuredClone() fixes
// it up. Test-environment-only; episodeStore.ts's hashing code is untouched.
// Each Vitest test FILE gets its own fresh module registry, so this must be
// re-applied here rather than assumed from vault.test.ts's copy.
const realBlobArrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = async function (this: Blob): Promise<ArrayBuffer> {
  return structuredClone(await realBlobArrayBuffer.call(this));
};

// ---------------------------------------------------------------------------
// In-memory File System Access fakes, mirrored from (and extended per) the
// fakes in __tests__/vault.test.ts rather than imported from it — importing
// a Vitest test file re-runs its describe() blocks as part of the importing
// file, which this repo's tests avoid (see e.g. xfer-channel.test.ts
// mirroring peer-ice.test.ts's FakePC instead of importing it).
// ---------------------------------------------------------------------------

class FakeWritable {
  private chunks: Uint8Array[] = [];
  constructor(
    private readonly file: FakeFileHandle,
    private readonly shouldFailWrite: () => boolean,
  ) {}

  async write(data: Uint8Array | Blob | string): Promise<void> {
    if (this.shouldFailWrite()) throw new Error("disk full");
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (ArrayBuffer.isView(data)) {
      // `instanceof Uint8Array` is unreliable here: TextEncoder().encode()
      // can hand back a Uint8Array from a different realm than this file's
      // global under jsdom (same family of quirk vault.test.ts documents
      // for Blob.arrayBuffer()). ArrayBuffer.isView() is realm-agnostic.
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      bytes = new Uint8Array(await data.arrayBuffer());
    }
    this.chunks.push(bytes);
  }

  async close(): Promise<void> {
    // A close() can fail too (disk-full-at-flush) — exercised by the
    // abandon()-must-never-throw-even-when-close-fails case (f).
    if (this.shouldFailWrite()) throw new Error("disk full");
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const committed = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      committed.set(c, offset);
      offset += c.length;
    }
    this.file.committed = committed;
  }
}

class FakeFileHandle {
  // Explicitly widened to bare `Uint8Array` (TS default `Uint8Array<ArrayBufferLike>`):
  // seedFile()/seedJson() assign in externally-typed (bare) bytes, which
  // would otherwise mismatch the narrower `Uint8Array<ArrayBuffer>` TS
  // infers from the `new Uint8Array(0)` initializer (TS 5.7 typed-array
  // generics — see episodeStore.ts's append() for the same family of fix).
  committed: Uint8Array = new Uint8Array(0);
  createWritableCalls: Array<{ keepExistingData?: boolean } | undefined> = [];
  constructor(
    public name: string,
    private readonly shouldFailWrite: () => boolean,
    private readonly parent: FakeDirHandle,
  ) {}

  async createWritable(opts?: { keepExistingData?: boolean }): Promise<FakeWritable> {
    if (opts?.keepExistingData) {
      throw new Error("episodeStore must never pass keepExistingData — parts commit only via close()");
    }
    this.createWritableCalls.push(opts);
    return new FakeWritable(this, this.shouldFailWrite);
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.committed as Uint8Array<ArrayBuffer>]);
  }

  // Atomic: the entry appears under the new name and vanishes under the old
  // one in the SAME synchronous step (no `await` between the delete and the
  // set), so nothing can observe an in-between state.
  //
  // moveNotAllowed mirrors the real LOCAL file system: Chrome ships move()
  // only inside OPFS — on a picker-granted directory it throws a
  // DOMException named "NotAllowedError" (chromestatus 6271579653144576),
  // which is exactly what the 2026-08-03 two-Mac drill hit.
  async move(newName: string): Promise<void> {
    if (this.parent.moveNotAllowed) {
      this.parent.ops.push(`move-refused:${this.name}`);
      throw new DOMException(
        "The request is not allowed by the user agent or the platform in the current context.",
        "NotAllowedError",
      );
    }
    this.parent.ops.push(`move:${this.name}->${newName}`);
    this.parent.files.delete(this.name);
    this.name = newName;
    this.parent.files.set(newName, this);
  }
}

class FakeDirHandle {
  files = new Map<string, FakeFileHandle>();
  dirs = new Map<string, FakeDirHandle>();
  failWriteFor = new Set<string>();
  /** Local-file-system mode: move() throws NotAllowedError (see FakeFileHandle.move).
   *  Inherited by subdirectories at creation time. */
  moveNotAllowed = false;
  /** Records getFileHandle(create:true) and move() calls, in order. */
  ops: string[] = [];

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let fh = this.files.get(name);
    if (!fh) {
      if (!opts?.create) throw notFoundError(name);
      this.ops.push(`create:${name}`);
      fh = new FakeFileHandle(name, () => this.failWriteFor.has(name), this);
      this.files.set(name, fh);
    }
    return fh;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw notFoundError(name);
      d = new FakeDirHandle();
      d.moveNotAllowed = this.moveNotAllowed;
      this.dirs.set(name, d);
    }
    return d;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw notFoundError(name);
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of this.files.keys()) yield name;
  }
}

// Mirrors the real File System Access API: a missing-entry lookup throws a
// DOMException named "NotFoundError" — episodeStore.ts's absence-detection
// (vs. any OTHER failure, which must propagate) keys off `.name`.
function notFoundError(name: string): DOMException {
  return new DOMException(`not found: ${name}`, "NotFoundError");
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function asFsDir(dir: FakeDirHandle): FileSystemDirectoryHandle {
  return dir as unknown as FileSystemDirectoryHandle;
}

function asFake(dir: FileSystemDirectoryHandle): FakeDirHandle {
  return dir as unknown as FakeDirHandle;
}

function seedFile(dir: FakeDirHandle, name: string, bytes: Uint8Array): FakeFileHandle {
  const fh = new FakeFileHandle(name, () => dir.failWriteFor.has(name), dir);
  fh.committed = bytes;
  dir.files.set(name, fh);
  return fh;
}

function seedJson(dir: FakeDirHandle, name: string, obj: unknown): FakeFileHandle {
  return seedFile(dir, name, new TextEncoder().encode(JSON.stringify(obj)));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB shim — mirrored from vault.test.ts, only the
// calls vault.ts's idbGet/idbSet actually use.
// ---------------------------------------------------------------------------

class FakeIDBRequest<T> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: T | undefined = undefined;
  error: unknown = null;
}

function makeFakeIndexedDB() {
  const store = new Map<string, unknown>();
  let storeCreated = false;

  const db = {
    createObjectStore() {
      storeCreated = true;
    },
    transaction(_storeName: string, _mode: string) {
      let oncompleteFn: (() => void) | null = null;
      return {
        objectStore: () => ({
          get(key: string) {
            const req = new FakeIDBRequest<unknown>();
            queueMicrotask(() => {
              req.result = store.get(key);
              req.onsuccess?.();
            });
            return req;
          },
          put(value: unknown, key: string) {
            store.set(key, value);
          },
        }),
        get oncomplete() {
          return oncompleteFn;
        },
        set oncomplete(fn: (() => void) | null) {
          oncompleteFn = fn;
          queueMicrotask(() => oncompleteFn?.());
        },
        onerror: null,
      };
    },
  };

  return {
    open(_name: string, _version: number) {
      const req = new FakeIDBRequest<typeof db>();
      queueMicrotask(() => {
        req.result = db;
        if (!storeCreated) (req as unknown as { onupgradeneeded?: () => void }).onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as FakeIDBRequest<typeof db> & { onupgradeneeded: (() => void) | null };
    },
  };
}

/** Stubs indexedDB + window.showDirectoryPicker, then chooses a fresh fake
 *  vault root — mirrors the flow vault.test.ts's own tests use. */
async function makeVaultRoot(): Promise<FakeDirHandle> {
  vi.unstubAllGlobals();
  vi.stubGlobal("indexedDB", makeFakeIndexedDB());
  const root = new FakeDirHandle();
  vi.stubGlobal("window", { ...window, showDirectoryPicker: vi.fn(async () => asFsDir(root)) });
  await chooseVault();
  return root;
}

let takeCounter = 0;
async function freshTakeDir(
  opts?: { moveNotAllowed?: boolean },
): Promise<{ root: FakeDirHandle; takeId: string; dir: FakeDirHandle }> {
  const root = await makeVaultRoot();
  if (opts?.moveNotAllowed) root.moveNotAllowed = true;
  const takeId = `take-${++takeCounter}`;
  const dir = asFake(await openTakeDir(takeId));
  return { root, takeId, dir };
}

describe("episodeStore", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  // -- (a) readSendPlan --------------------------------------------------
  it("(a) readSendPlan returns [audio, video] verbatim, audio first", async () => {
    const { dir, takeId } = await freshTakeDir();
    const audioParts: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "aa" }];
    const videoParts: SidecarEntry[] = [
      { name: "video.part000", size: 5, sha256: "bb" },
      { name: "video.part001", size: 2, sha256: "cc" },
    ];
    seedJson(dir, "audio.sidecar.json", { base: "audio", parts: audioParts });
    seedJson(dir, "video.sidecar.json", { base: "video", parts: videoParts });

    const plan = await readSendPlan(takeId);
    expect(plan).toEqual([
      { base: "audio", parts: audioParts },
      { base: "video", parts: videoParts },
    ]);
  });

  it("(a) readSendPlan tolerates extra top-level sidecar fields (echo-guard provenance)", async () => {
    // 5A's echo-guard stamps `echoGuard` into the audio sidecar; the exchange
    // reads only base/parts and must never choke on a stamped tape.
    const { dir, takeId } = await freshTakeDir();
    const audioParts: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "aa" }];
    seedJson(dir, "audio.sidecar.json", { echoGuard: true, base: "audio", parts: audioParts });
    seedJson(dir, "video.sidecar.json", { base: "video", parts: [] });

    const plan = await readSendPlan(takeId);
    expect(plan[0]).toEqual({ base: "audio", parts: audioParts });
  });

  it("(a) readSendPlan rejects when a sidecar is missing", async () => {
    const { dir, takeId } = await freshTakeDir();
    seedJson(dir, "audio.sidecar.json", { base: "audio", parts: [] });
    // video.sidecar.json never seeded — readSidecarPlan's getFileHandle
    // (no create:true) rejects with the real File System Access API's
    // DOMException for a missing entry, propagated verbatim (readSendPlan
    // has no try/catch of its own around it).
    await expect(readSendPlan(takeId)).rejects.toBeInstanceOf(DOMException);
    await expect(readSendPlan(takeId)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  // -- (b) openPartReader --------------------------------------------------
  it("(b) openPartReader.read(offset, len) returns the exact slice; one getFile total", async () => {
    const { dir, takeId } = await freshTakeDir();
    const bytes = new TextEncoder().encode("0123456789");
    seedFile(dir, "audio.part000", bytes);
    const fh = dir.files.get("audio.part000")!;
    const getFileSpy = vi.spyOn(fh, "getFile");

    const reader = await openPartReader(takeId, "audio.part000");
    expect(reader.size).toBe(10);

    const slice1 = await reader.read(3, 4);
    expect(Array.from(slice1)).toEqual(Array.from(bytes.slice(3, 7)));
    const slice2 = await reader.read(0, 2);
    expect(Array.from(slice2)).toEqual(Array.from(bytes.slice(0, 2)));

    expect(getFileSpy).toHaveBeenCalledTimes(1);
  });

  // -- (c) openIncomingPart + commit ---------------------------------------
  it("(c) openIncomingPart writes to remote/.incoming-<name>; commit() renames to remote/<name>, temp gone, bytes match", async () => {
    const { dir, takeId } = await freshTakeDir();
    const bytes = new TextEncoder().encode("hello world");
    const entry: SidecarEntry = { name: "video.part000", size: bytes.length, sha256: await sha256(bytes) };

    const part = await openIncomingPart(takeId, entry);
    const remote = dir.dirs.get(REMOTE_DIR)!;
    expect(remote.files.has(`${INCOMING_PREFIX}video.part000`)).toBe(true);
    expect(remote.files.has("video.part000")).toBe(false);

    await part.append(bytes);
    await part.commit();

    expect(remote.files.has(`${INCOMING_PREFIX}video.part000`)).toBe(false);
    expect(remote.files.has("video.part000")).toBe(true);
    expect(Array.from(remote.files.get("video.part000")!.committed)).toEqual(Array.from(bytes));
  });

  // -- (d) hash gate --------------------------------------------------------
  it("(d) commit() with corrupted bytes throws HashMismatchError, no committed file, temp deleted", async () => {
    const { dir, takeId } = await freshTakeDir();
    const goodBytes = new TextEncoder().encode("good bytes");
    const entry: SidecarEntry = {
      name: "audio.part000",
      size: goodBytes.length,
      sha256: await sha256(goodBytes),
    };

    const part = await openIncomingPart(takeId, entry);
    await part.append(new TextEncoder().encode("corrupted!!")); // wrong bytes, same length

    await expect(part.commit()).rejects.toBeInstanceOf(HashMismatchError);

    const remote = dir.dirs.get(REMOTE_DIR)!;
    expect(remote.files.has("audio.part000")).toBe(false);
    expect(remote.files.has(`${INCOMING_PREFIX}audio.part000`)).toBe(false);
  });

  it("(d) HashMismatchError carries the part name", async () => {
    const { takeId } = await freshTakeDir();
    const entry: SidecarEntry = { name: "audio.part000", size: 4, sha256: "0".repeat(64) };
    const part = await openIncomingPart(takeId, entry);
    await part.append(new Uint8Array([1, 2, 3, 4]));
    try {
      await part.commit();
      throw new Error("expected commit() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HashMismatchError);
      expect((err as InstanceType<typeof HashMismatchError>).partName).toBe("audio.part000");
    }
  });

  // -- (e) scanCommitted ------------------------------------------------
  it("(e) scanCommitted lists committed names only, never .incoming-* temps", async () => {
    const { dir, takeId } = await freshTakeDir();
    const remote = asFake(await asFsDir(dir).getDirectoryHandle(REMOTE_DIR, { create: true }));
    seedFile(remote, "audio.part000", new Uint8Array([1]));
    seedFile(remote, "video.part000", new Uint8Array([2]));
    seedFile(remote, `${INCOMING_PREFIX}video.part001`, new Uint8Array([3]));
    seedFile(remote, `${INCOMING_PREFIX}${MANIFEST_NAME}`, new Uint8Array([4]));

    const names = await scanCommitted(takeId);
    expect(names.sort()).toEqual(["audio.part000", "video.part000"]);
  });

  // -- (f) abandon --------------------------------------------------------
  it("(f) abandon() deletes the temp and never throws, even when close() itself fails", async () => {
    const { dir, takeId } = await freshTakeDir();
    const entry: SidecarEntry = { name: "audio.part000", size: 3, sha256: "irrelevant" };

    const part = await openIncomingPart(takeId, entry);
    await part.append(new Uint8Array([1, 2, 3]));

    const remote = dir.dirs.get(REMOTE_DIR)!;
    remote.failWriteFor.add(`${INCOMING_PREFIX}audio.part000`); // close() will now throw too

    await expect(part.abandon()).resolves.toBeUndefined();
    expect(remote.files.has(`${INCOMING_PREFIX}audio.part000`)).toBe(false);
  });

  it("(f) abandon() on an already-committed (renamed-away) temp still never throws", async () => {
    const { takeId } = await freshTakeDir();
    const bytes = new Uint8Array([9, 9, 9]);
    const entry: SidecarEntry = { name: "audio.part000", size: bytes.length, sha256: await sha256(bytes) };
    const part = await openIncomingPart(takeId, entry);
    await part.append(bytes);
    await part.commit(); // temp already renamed away

    await expect(part.abandon()).resolves.toBeUndefined();
  });

  // -- (g) manifest LAST + atomic -------------------------------------------
  it("(g) writeManifest parses to the exact EpisodeManifest shape; local from seeded sidecars", async () => {
    const { dir, takeId } = await freshTakeDir();
    const audioParts: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "aa" }];
    const videoParts: SidecarEntry[] = [{ name: "video.part000", size: 5, sha256: "bb" }];
    seedJson(dir, "audio.sidecar.json", { base: "audio", parts: audioParts });
    seedJson(dir, "video.sidecar.json", { base: "video", parts: videoParts });

    const remoteVideo: SidecarEntry[] = [{ name: "video.part000", size: 5, sha256: "cc" }];
    const remoteAudio: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "dd" }];
    const fixedNowMs = Date.UTC(2026, 6, 31, 12, 0, 0);

    await writeManifest(takeId, { video: remoteVideo, audio: remoteAudio }, "partner-codename", {
      now: () => fixedNowMs,
    });

    expect(dir.files.has(MANIFEST_NAME)).toBe(true);
    expect(dir.files.has(`${INCOMING_PREFIX}${MANIFEST_NAME}`)).toBe(false);

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get(MANIFEST_NAME)!.committed));
    expect(parsed).toEqual({
      version: 1,
      episodeId: takeId,
      receivedFrom: "partner-codename",
      completedAt: new Date(fixedNowMs).toISOString(),
      local: { video: videoParts, audio: audioParts },
      remote: { video: remoteVideo, audio: remoteAudio },
    });
  });

  it("(g) writeManifest: no local sidecars -> local: null, manifest still written", async () => {
    const { dir, takeId } = await freshTakeDir();
    const remoteVideo: SidecarEntry[] = [{ name: "video.part000", size: 5, sha256: "cc" }];
    const remoteAudio: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "dd" }];

    await writeManifest(takeId, { video: remoteVideo, audio: remoteAudio }, null, { now: () => 1000 });

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get(MANIFEST_NAME)!.committed));
    expect(parsed.local).toBeNull();
    expect(parsed.receivedFrom).toBeNull();
  });

  it("(g) manifest never exists under its real name until the final move — op order asserts it", async () => {
    const { dir, takeId } = await freshTakeDir();
    await writeManifest(takeId, { video: [], audio: [] }, null, { now: () => 1000 });

    expect(dir.ops).toEqual([
      `create:${INCOMING_PREFIX}${MANIFEST_NAME}`,
      `move:${INCOMING_PREFIX}${MANIFEST_NAME}->${MANIFEST_NAME}`,
    ]);
  });

  // -- (g-i) one sidecar present (crashed-take: one encoder died, the other's
  // finishWriter() still landed — 5A's Promise.allSettled contract) ---------
  it("(g-i) exactly one local sidecar present -> local has that stream's entries verbatim, [] for the other", async () => {
    const { dir, takeId } = await freshTakeDir();
    const audioParts: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "aa" }];
    seedJson(dir, "audio.sidecar.json", { base: "audio", parts: audioParts });
    // video.sidecar.json never seeded — that encoder died before finish().

    const remoteVideo: SidecarEntry[] = [{ name: "video.part000", size: 5, sha256: "cc" }];
    const remoteAudio: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "dd" }];

    await writeManifest(takeId, { video: remoteVideo, audio: remoteAudio }, null, { now: () => 1000 });

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get(MANIFEST_NAME)!.committed));
    expect(parsed.local).toEqual({ audio: audioParts, video: [] });
  });

  it("(g-i) exactly one local sidecar present, the OTHER stream missing -> local has [] for audio", async () => {
    const { dir, takeId } = await freshTakeDir();
    const videoParts: SidecarEntry[] = [{ name: "video.part000", size: 5, sha256: "bb" }];
    seedJson(dir, "video.sidecar.json", { base: "video", parts: videoParts });
    // audio.sidecar.json never seeded.

    await writeManifest(takeId, { video: [], audio: [] }, null, { now: () => 1000 });

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get(MANIFEST_NAME)!.committed));
    expect(parsed.local).toEqual({ audio: [], video: videoParts });
  });

  // -- (g-ii) a corrupt/unparseable sidecar must fault the write, not lie ---
  it("(g-ii) unparseable local sidecar JSON -> writeManifest rejects, no episode.json under its real name", async () => {
    const { dir, takeId } = await freshTakeDir();
    seedFile(dir, "audio.sidecar.json", new TextEncoder().encode("{not valid json"));
    seedJson(dir, "video.sidecar.json", { base: "video", parts: [] });

    // readLocalSidecarParts has no try/catch around JSON.parse — only around
    // the getFileHandle absence check — so an unparseable sidecar propagates
    // the native SyntaxError verbatim rather than being papered over.
    await expect(
      writeManifest(takeId, { video: [], audio: [] }, null, { now: () => 1000 }),
    ).rejects.toBeInstanceOf(SyntaxError);

    expect(dir.files.has(MANIFEST_NAME)).toBe(false);
  });

  // -- (g-iii) both absent -> null, unchanged from the pre-fix behavior -----
  it("(g-iii) neither local sidecar present -> local: null (unchanged)", async () => {
    const { dir, takeId } = await freshTakeDir();
    await writeManifest(takeId, { video: [], audio: [] }, null, { now: () => 1000 });

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get(MANIFEST_NAME)!.committed));
    expect(parsed.local).toBeNull();
  });

  // -- (h) stale temp overwrite ---------------------------------------------
  it("(h) a stale .incoming-* from a crashed run is silently overwritten by a fresh openIncomingPart", async () => {
    const { dir, takeId } = await freshTakeDir();
    const remote = asFake(await asFsDir(dir).getDirectoryHandle(REMOTE_DIR, { create: true }));
    seedFile(remote, `${INCOMING_PREFIX}audio.part000`, new TextEncoder().encode("STALE-CRASHED-DATA"));
    const staleHandle = remote.files.get(`${INCOMING_PREFIX}audio.part000`)!;
    const createWritableSpy = vi.spyOn(staleHandle, "createWritable");

    const freshBytes = new TextEncoder().encode("fresh");
    const entry: SidecarEntry = { name: "audio.part000", size: freshBytes.length, sha256: await sha256(freshBytes) };

    const part = await openIncomingPart(takeId, entry);
    expect(createWritableSpy).toHaveBeenCalledTimes(1);
    expect(createWritableSpy).toHaveBeenCalledWith(); // never keepExistingData
    expect(staleHandle.createWritableCalls).toEqual([undefined]);

    await part.append(freshBytes);
    await part.commit();

    expect(Array.from(remote.files.get("audio.part000")!.committed)).toEqual(Array.from(freshBytes));
  });

  // -- (i) local file system: move() unavailable ----------------------------
  // Chrome ships FileSystemFileHandle.move() only inside OPFS; on a real
  // picker-granted vault it throws NotAllowedError (hit live, 2026-08-03
  // two-Mac drill: zero inbound parts ever committed). commit() and
  // writeManifest() must fall back to copy-into-place — the platform's own
  // swap-file close() keeps the final name atomic.
  it("(i) commit() falls back to copy+delete-temp when move() throws NotAllowedError — final bytes land, temp gone", async () => {
    const { dir, takeId } = await freshTakeDir({ moveNotAllowed: true });
    const bytes = new TextEncoder().encode("real vault bytes");
    const entry: SidecarEntry = { name: "video.part000", size: bytes.length, sha256: await sha256(bytes) };

    const part = await openIncomingPart(takeId, entry);
    await part.append(bytes);
    await part.commit();

    const remote = dir.dirs.get(REMOTE_DIR)!;
    expect(remote.files.has(`${INCOMING_PREFIX}video.part000`)).toBe(false);
    expect(remote.files.has("video.part000")).toBe(true);
    expect(Array.from(remote.files.get("video.part000")!.committed)).toEqual(Array.from(bytes));
  });

  it("(i) hash mismatch on a move-less vault: HashMismatchError, the final name is NEVER created, temp gone", async () => {
    const { dir, takeId } = await freshTakeDir({ moveNotAllowed: true });
    const goodBytes = new TextEncoder().encode("good bytes");
    const entry: SidecarEntry = { name: "audio.part000", size: goodBytes.length, sha256: await sha256(goodBytes) };

    const part = await openIncomingPart(takeId, entry);
    await part.append(new TextEncoder().encode("corrupted!!"));
    await expect(part.commit()).rejects.toBeInstanceOf(HashMismatchError);

    const remote = dir.dirs.get(REMOTE_DIR)!;
    expect(remote.files.has("audio.part000")).toBe(false);
    expect(remote.files.has(`${INCOMING_PREFIX}audio.part000`)).toBe(false);
    // The verify-BEFORE-final-name order is the invariant: a refused move
    // must not tempt the fallback into creating the final early.
    expect(remote.ops).not.toContain("create:audio.part000");
  });

  it("(i) writeManifest falls back on a move-less vault — episode.json lands complete, temp gone, final created only after the temp was fully written", async () => {
    const { dir, takeId } = await freshTakeDir({ moveNotAllowed: true });
    const remoteVideo: SidecarEntry[] = [{ name: "video.part000", size: 5, sha256: "cc" }];
    const remoteAudio: SidecarEntry[] = [{ name: "audio.part000", size: 3, sha256: "dd" }];

    await writeManifest(takeId, { video: remoteVideo, audio: remoteAudio }, null, { now: () => 1000 });

    expect(dir.files.has(`${INCOMING_PREFIX}${MANIFEST_NAME}`)).toBe(false);
    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get(MANIFEST_NAME)!.committed));
    expect(parsed.remote).toEqual({ video: remoteVideo, audio: remoteAudio });
    expect(dir.ops).toEqual([
      `create:${INCOMING_PREFIX}${MANIFEST_NAME}`,
      `move-refused:${INCOMING_PREFIX}${MANIFEST_NAME}`,
      `create:${MANIFEST_NAME}`,
    ]);
  });

  // The copy fallback opens one crash window rename never had: die between
  // getFileHandle(create:true) and close() and a 0-byte file wears the final
  // name. Name-only scanning would report it as committed and the sender
  // would never re-send it — silent corruption. The expected-size gate is
  // the counter: wrong size -> deleted from disk AND absent from the scan.
  it("(i) scanCommitted with an expected-size plan deletes a size-mismatched crash artifact and keeps true matches", async () => {
    const { dir, takeId } = await freshTakeDir({ moveNotAllowed: true });
    const remote = asFake(await asFsDir(dir).getDirectoryHandle(REMOTE_DIR, { create: true }));
    seedFile(remote, "audio.part000", new Uint8Array(0)); // crash artifact: created, never closed
    seedFile(remote, "video.part000", new Uint8Array([7])); // genuinely committed
    seedFile(remote, `${INCOMING_PREFIX}video.part001`, new Uint8Array([3]));
    seedFile(remote, "stray.bin", new Uint8Array([9])); // not in the plan: untouched, still listed

    const names = await scanCommitted(takeId, [
      { name: "audio.part000", size: 5 },
      { name: "video.part000", size: 1 },
    ]);

    expect(names.sort()).toEqual(["stray.bin", "video.part000"]);
    expect(remote.files.has("audio.part000")).toBe(false);
    expect(remote.files.has("video.part000")).toBe(true);
    expect(remote.files.has("stray.bin")).toBe(true);
  });
});
