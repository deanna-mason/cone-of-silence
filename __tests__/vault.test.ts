import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PartWriter,
  chooseVault,
  openTakeDir,
  requestVaultAccess,
  vaultPermission,
} from "@/lib/podcast/vault";

// jsdom's Blob.arrayBuffer() returns an ArrayBuffer that satisfies
// `instanceof ArrayBuffer` and `.constructor === ArrayBuffer` but still fails
// Node's WebCrypto digest() validation (a jsdom/Node realm quirk — real
// browsers, where PartWriter actually runs, don't split this way).
// structuredClone() produces a plain ArrayBuffer WebCrypto accepts. This is a
// test-environment polyfill only — vault.ts's hashing code is untouched.
const realBlobArrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = async function (this: Blob): Promise<ArrayBuffer> {
  return structuredClone(await realBlobArrayBuffer.call(this));
};

// ---------------------------------------------------------------------------
// In-memory File System Access fakes. A real FileSystemWritableFileStream
// only commits bytes at close() (atomic swap) — these fakes mirror that: the
// backing file's `committed` bytes are populated ONLY by close(), so
// getFile() before close() would see nothing (never exercised here, but the
// shape matters for the rollover/hash assertions below).
// ---------------------------------------------------------------------------

// `failWriteFor`/`failOpenFor` are checked LIVE (at write()/getFileHandle()
// time), not captured once at construction — so a test can flip a fault off
// mid-test to prove a chain recovers rather than staying wedged.
class FakeWritable {
  private chunks: Uint8Array[] = [];
  private gateConsumed = false;
  constructor(
    private readonly file: FakeFileHandle,
    private readonly shouldFailWrite: () => boolean,
    private readonly gate?: Promise<void>,
  ) {}

  async write(data: Blob | string): Promise<void> {
    // Mirrors a slow disk write: the FIRST write on a gated writable blocks
    // until the test releases it, so overlapping append() calls can be
    // observed mid-flight.
    if (this.gate && !this.gateConsumed) {
      this.gateConsumed = true;
      await this.gate;
    }
    if (this.shouldFailWrite()) throw new Error("disk full");
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
    this.chunks.push(bytes);
  }

  async close(): Promise<void> {
    // A close() can fail too (disk-full-at-flush is a real failure mode) —
    // exercised by episodeStore's abandon()-must-never-throw tests.
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

// Phase 5B (episodeStore.ts) extends this fake with atomic move() (renamed
// entry appears under the new name and vanishes under the old in the SAME
// synchronous step — no `await` between the delete and the set, so nothing
// can observe an in-between state) and read-only directory listing
// (getDirectoryHandle/removeEntry/keys), mirrored into
// __tests__/episode-store.test.ts rather than imported — importing this
// FILE would re-run its own describe() blocks as part of the importing
// file, per this repo's existing "mirror the fake, don't import the test
// file" pattern (see xfer-channel.test.ts mirroring peer-ice.test.ts's FakePC).
class FakeFileHandle {
  committed = new Uint8Array(0);
  createWritableCallCount = 0;
  constructor(
    public name: string,
    private readonly shouldFailWrite: () => boolean,
    private readonly gate: Promise<void> | undefined,
    private readonly parent: FakeDirHandle,
  ) {}

  async createWritable(opts?: { keepExistingData?: boolean }): Promise<FakeWritable> {
    if (opts?.keepExistingData) {
      throw new Error("PartWriter must never pass keepExistingData — parts commit only via close()");
    }
    this.createWritableCallCount += 1;
    // Only the first writable ever opened on this file is gated — a second
    // (buggy, racing) writable must proceed immediately so its bytes would
    // land out of order instead of being masked by the gate too.
    const gate = this.createWritableCallCount === 1 ? this.gate : undefined;
    return new FakeWritable(this, this.shouldFailWrite, gate);
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.committed]);
  }

  async move(newName: string): Promise<void> {
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
  failOpenFor = new Set<string>();
  gateFor = new Map<string, Promise<void>>();
  /** Records getFileHandle(create:true) and move() calls, in order — lets
   *  episodeStore.ts's tests assert a name never exists under its real
   *  identity until the final move (manifest-last, hash-gated commits). */
  ops: string[] = [];

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    if (this.failOpenFor.has(name)) throw new Error("disk full opening part");
    let fh = this.files.get(name);
    if (!fh) {
      if (!opts?.create) throw notFoundError(name);
      this.ops.push(`create:${name}`);
      fh = new FakeFileHandle(name, () => this.failWriteFor.has(name), this.gateFor.get(name), this);
      this.files.set(name, fh);
    }
    return fh;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw notFoundError(name);
      d = new FakeDirHandle();
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
// (vs. any OTHER failure, which must propagate) keys off `.name`, so the
// fake must be faithful here, not just "any Error".
function notFoundError(name: string): DOMException {
  return new DOMException(`not found: ${name}`, "NotFoundError");
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function asDir(dir: FakeDirHandle): FileSystemDirectoryHandle {
  return dir as unknown as FileSystemDirectoryHandle;
}

/** A promise plus its resolve(), for tests that need to control timing by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("PartWriter", () => {
  it("rolls parts on append COUNT, not wall time: 61 appends @ default 1000ms timeslice -> 60/1 split", async () => {
    const dir = new FakeDirHandle();
    const writer = new PartWriter(asDir(dir), "audio");
    const blob = new Blob([new Uint8Array(10).fill(9)]);

    for (let i = 0; i < 61; i++) await writer.append(blob);
    expect(writer.bytesWritten).toBe(610);

    await writer.finish();

    expect(dir.files.get("audio.part000")!.committed.length).toBe(600);
    expect(dir.files.get("audio.part001")!.committed.length).toBe(10);
    expect(dir.files.has("audio.part002")).toBe(false);
  });

  it("honors a custom timesliceMs quota (500ms -> 120 appends/part)", async () => {
    const dir = new FakeDirHandle();
    const writer = new PartWriter(asDir(dir), "video", 500);
    const blob = new Blob([new Uint8Array(1)]);

    for (let i = 0; i < 121; i++) await writer.append(blob);
    await writer.finish();

    expect(dir.files.get("video.part000")!.committed.length).toBe(120);
    expect(dir.files.get("video.part001")!.committed.length).toBe(1);
  });

  it("finish() returns sidecar entries whose size and sha256 match an independently computed digest", async () => {
    const dir = new FakeDirHandle();
    const writer = new PartWriter(asDir(dir), "audio", 1000);
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7]), new Uint8Array([8])];
    for (const c of chunks) await writer.append(new Blob([c]));

    const entries = await writer.finish();
    expect(entries).toHaveLength(1);

    const expectedBytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      expectedBytes.set(c, off);
      off += c.length;
    }
    const expectedDigest = toHex(await crypto.subtle.digest("SHA-256", expectedBytes));

    expect(entries[0]!.name).toBe("audio.part000");
    expect(entries[0]!.size).toBe(expectedBytes.length);
    expect(entries[0]!.sha256).toBe(expectedDigest);
  });

  it("writes <base>.sidecar.json with all parts listed in order", async () => {
    const dir = new FakeDirHandle();
    // timesliceMs = 30_000 -> quota = ceil(60_000 / 30_000) = 2 appends/part
    const writer = new PartWriter(asDir(dir), "video", 30_000);
    for (let i = 0; i < 5; i++) await writer.append(new Blob([new Uint8Array([i])]));

    const entries = await writer.finish();
    expect(entries.map((e) => e.name)).toEqual(["video.part000", "video.part001", "video.part002"]);

    const sidecar = dir.files.get("video.sidecar.json");
    expect(sidecar).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(sidecar!.committed));
    expect(parsed.base).toBe("video");
    expect(parsed.parts).toEqual(entries);
  });

  it("finish() writes sidecarExtra keys into the sidecar JSON", async () => {
    const dir = new FakeDirHandle();
    const writer = new PartWriter(asDir(dir), "audio", 1000, { phones: "speakers" });
    await writer.append(new Blob([new Uint8Array(10)]));
    await writer.finish();

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get("audio.sidecar.json")!.committed));
    expect(parsed.phones).toBe("speakers");
    expect(parsed.base).toBe("audio");
    expect(Array.isArray(parsed.parts)).toBe(true);
  });

  it("sidecarExtra can never clobber base or parts", async () => {
    const dir = new FakeDirHandle();
    const writer = new PartWriter(asDir(dir), "audio", 1000, { base: "video", parts: "x" } as never);
    await writer.finish();

    const parsed = JSON.parse(new TextDecoder().decode(dir.files.get("audio.sidecar.json")!.committed));
    expect(parsed.base).toBe("audio");
    expect(Array.isArray(parsed.parts)).toBe(true);
  });

  it("propagates a write() rejection out of append()", async () => {
    const dir = new FakeDirHandle();
    dir.failWriteFor.add("audio.part000");
    const writer = new PartWriter(asDir(dir), "audio");

    await expect(writer.append(new Blob([new Uint8Array(10)]))).rejects.toThrow("disk full");
  });

  it("serializes overlapping append() calls: a second append issued before a slow write settles never opens its own writable", async () => {
    const dir = new FakeDirHandle();
    const gate = deferred();
    dir.gateFor.set("audio.part000", gate.promise);
    const writer = new PartWriter(asDir(dir), "audio");

    const blobA = new Blob([new TextEncoder().encode("AAAAA")]); // 5 bytes
    const blobB = new Blob([new TextEncoder().encode("BB")]); // 2 bytes

    const p1 = writer.append(blobA); // opens the part's writable; write() blocks on the gate
    const p2 = writer.append(blobB); // must NOT start its own operation until p1 settles

    // Let pending microtasks run without releasing the gate.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const fh = dir.files.get("audio.part000")!;
    expect(fh.createWritableCallCount).toBe(1); // p2 hasn't opened a second writable

    gate.resolve();
    await p1;
    await p2;

    expect(fh.createWritableCallCount).toBe(1); // still only ever the one writable

    await writer.finish();
    expect(new TextDecoder().decode(dir.files.get("audio.part000")!.committed)).toBe("AAAAABB"); // call order preserved
  });

  it("finish() issued while an append is pending waits for it, and the sidecar includes its bytes", async () => {
    const dir = new FakeDirHandle();
    const gate = deferred();
    dir.gateFor.set("audio.part000", gate.promise);
    const writer = new PartWriter(asDir(dir), "audio");

    const appendPromise = writer.append(new Blob([new TextEncoder().encode("hello")]));
    const finishPromise = writer.finish(); // issued before the append's write resolves

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve();

    await appendPromise;
    const entries = await finishPromise;

    expect(entries).toHaveLength(1);
    expect(entries[0]!.size).toBe(5);
    const sidecar = dir.files.get("audio.sidecar.json")!;
    const parsed = JSON.parse(new TextDecoder().decode(sidecar.committed));
    expect(parsed.parts).toEqual(entries);
  });

  it("a rejected append() propagates to its own caller, and a later append() is still attempted (chain not wedged)", async () => {
    const dir = new FakeDirHandle();
    dir.failOpenFor.add("audio.part000"); // first attempt to open the part fails
    const writer = new PartWriter(asDir(dir), "audio");

    await expect(writer.append(new Blob([new Uint8Array(10)]))).rejects.toThrow("disk full opening part");
    expect(writer.bytesWritten).toBe(0);

    dir.failOpenFor.delete("audio.part000"); // disk recovers
    await writer.append(new Blob([new TextEncoder().encode("ok")])); // chain must not be wedged

    expect(writer.bytesWritten).toBe(2);
    await writer.finish();
    expect(new TextDecoder().decode(dir.files.get("audio.part000")!.committed)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB shim — only the calls vault.ts's idbGet/idbSet
// actually use: open (with onupgradeneeded/onsuccess/onerror), a
// readonly/readwrite transaction, and objectStore().get()/put().
// ---------------------------------------------------------------------------

class FakeIDBRequest<T> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: T | undefined = undefined;
  error: unknown = null;
}

interface FakeDb {
  createObjectStore(name: string): void;
  transaction(storeName: string, mode: string): FakeTx;
}

interface FakeTx {
  objectStore(name: string): { get(key: string): FakeIDBRequest<unknown>; put(value: unknown, key: string): void };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
}

function makeFakeIndexedDB() {
  const store = new Map<string, unknown>();
  let storeCreated = false;

  const db: FakeDb = {
    createObjectStore() {
      storeCreated = true;
    },
    transaction(_storeName: string, _mode: string) {
      let oncompleteFn: (() => void) | null = null;
      const tx: FakeTx = {
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
      return tx;
    },
  };

  return {
    open(_name: string, _version: number) {
      const req = new FakeIDBRequest<FakeDb>();
      queueMicrotask(() => {
        req.result = db;
        if (!storeCreated) (req as unknown as { onupgradeneeded?: () => void }).onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as FakeIDBRequest<FakeDb> & { onupgradeneeded: (() => void) | null };
    },
  };
}

describe("vault permission flow", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("indexedDB", makeFakeIndexedDB());
  });

  it("is 'unset' when no handle has ever been chosen", async () => {
    await expect(vaultPermission()).resolves.toBe("unset");
  });

  it("reflects a stored handle's queryPermission, and requestVaultAccess() re-maps after granting", async () => {
    let granted = false;
    const fakeHandle = {
      queryPermission: vi.fn(async () => (granted ? "granted" : "prompt")),
      requestPermission: vi.fn(async () => {
        granted = true;
        return "granted";
      }),
      getDirectoryHandle: vi.fn(),
    };
    const showDirectoryPicker = vi.fn(async () => fakeHandle);
    vi.stubGlobal("window", { ...window, showDirectoryPicker });

    await chooseVault();
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "readwrite" });

    await expect(vaultPermission()).resolves.toBe("prompt");
    expect(fakeHandle.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });

    const result = await requestVaultAccess();
    expect(fakeHandle.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(result).toBe("granted");

    await expect(vaultPermission()).resolves.toBe("granted");
  });

  it("openTakeDir() creates/returns the take's subdirectory under the stored handle", async () => {
    const takeDir = { name: "take-1" };
    const fakeHandle = {
      queryPermission: vi.fn(),
      requestPermission: vi.fn(),
      getDirectoryHandle: vi.fn(async (id: string, opts?: { create?: boolean }) => {
        expect(id).toBe("take-1");
        expect(opts).toEqual({ create: true });
        return takeDir;
      }),
    };
    vi.stubGlobal("window", { ...window, showDirectoryPicker: vi.fn(async () => fakeHandle) });

    await chooseVault();
    const result = await openTakeDir("take-1");
    expect(result).toBe(takeDir);
    expect(fakeHandle.getDirectoryHandle).toHaveBeenCalledWith("take-1", { create: true });
  });
});
