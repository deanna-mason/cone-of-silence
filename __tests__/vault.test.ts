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

class FakeWritable {
  private chunks: Uint8Array[] = [];
  constructor(private readonly file: FakeFileHandle, private readonly failWrite: boolean) {}

  async write(data: Blob | string): Promise<void> {
    if (this.failWrite) throw new Error("disk full");
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
    this.chunks.push(bytes);
  }

  async close(): Promise<void> {
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
  committed = new Uint8Array(0);
  constructor(public readonly name: string, private readonly failWrite: boolean) {}

  async createWritable(opts?: { keepExistingData?: boolean }): Promise<FakeWritable> {
    if (opts?.keepExistingData) {
      throw new Error("PartWriter must never pass keepExistingData — parts commit only via close()");
    }
    return new FakeWritable(this, this.failWrite);
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.committed]);
  }
}

class FakeDirHandle {
  files = new Map<string, FakeFileHandle>();
  failWriteFor = new Set<string>();

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let fh = this.files.get(name);
    if (!fh) {
      if (!opts?.create) throw new Error(`not found: ${name}`);
      fh = new FakeFileHandle(name, this.failWriteFor.has(name));
      this.files.set(name, fh);
    }
    return fh;
  }
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function asDir(dir: FakeDirHandle): FileSystemDirectoryHandle {
  return dir as unknown as FileSystemDirectoryHandle;
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

  it("propagates a write() rejection out of append()", async () => {
    const dir = new FakeDirHandle();
    dir.failWriteFor.add("audio.part000");
    const writer = new PartWriter(asDir(dir), "audio");

    await expect(writer.append(new Blob([new Uint8Array(10)]))).rejects.toThrow("disk full");
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
