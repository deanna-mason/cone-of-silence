// Episode-exchange vault disk layer. Temp names + hash-gated atomic renames
// ARE the crash-safety story: a receiver's committed parts under
// <take>/remote/ are the ONLY persistent transfer state (scanCommitted() IS
// the resume state — no separate resume journal), and the episode manifest
// is written LAST because it is the 5C darkroom's trigger: a bare
// getFileHandle(create:true) makes an empty file visible before its
// writable closes, and an early-visible episode.json would false-trigger
// the darkroom watcher on an incomplete episode.
import { openTakeDir, type SidecarEntry } from "./vault";
import type { FilePlan } from "./xferProtocol";

export const REMOTE_DIR = "remote";
export const INCOMING_PREFIX = ".incoming-";
export const MANIFEST_NAME = "episode.json";

export class HashMismatchError extends Error {
  constructor(public partName: string) {
    super(`hash mismatch for ${partName}`);
  }
}

export interface EpisodeManifest {
  version: 1;
  episodeId: string;
  receivedFrom: string | null; // partner codename — zero PII
  completedAt: string; // ISO 8601
  local: { video: SidecarEntry[]; audio: SidecarEntry[] } | null; // null: this host never recorded this take
  remote: { video: SidecarEntry[]; audio: SidecarEntry[] }; // names resolve under remote/
}

// Copied from vault.ts's private lowercase-hex digest idiom — not worth
// exporting a privates-sharing surface for one call site each.
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function remoteDir(takeId: string): Promise<FileSystemDirectoryHandle> {
  const dir = await openTakeDir(takeId);
  return dir.getDirectoryHandle(REMOTE_DIR, { create: true });
}

// ---------------------------------------------------------------------------
// sender side
// ---------------------------------------------------------------------------

async function readSidecarPlan(dir: FileSystemDirectoryHandle, base: "audio" | "video"): Promise<FilePlan> {
  const fh = await dir.getFileHandle(`${base}.sidecar.json`);
  const text = await (await fh.getFile()).text();
  const parsed = JSON.parse(text) as { base: "audio" | "video"; parts: SidecarEntry[] };
  return { base: parsed.base, parts: parsed.parts };
}

/** Reads both sidecars of a recorded take; audio plan FIRST (spec: the audio
 *  product completes soonest). Throws if either sidecar is missing. */
export async function readSendPlan(takeId: string): Promise<FilePlan[]> {
  const dir = await openTakeDir(takeId);
  const audio = await readSidecarPlan(dir, "audio");
  const video = await readSidecarPlan(dir, "video");
  return [audio, video];
}

export interface PartReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** One getFile() per part; read() slices it — never re-opens per chunk. */
export async function openPartReader(takeId: string, name: string): Promise<PartReader> {
  const dir = await openTakeDir(takeId);
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return {
    size: file.size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const bytes = await file.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(bytes);
    },
  };
}

// ---------------------------------------------------------------------------
// receiver side
// ---------------------------------------------------------------------------

/** Committed = verified + renamed. Scans <take>/remote/, EXCLUDING any
 *  .incoming-* temp — an in-flight part is never resume state. */
export async function scanCommitted(takeId: string): Promise<string[]> {
  const dir = await remoteDir(takeId);
  const names: string[] = [];
  for await (const name of dir.keys()) {
    if (!name.startsWith(INCOMING_PREFIX)) names.push(name);
  }
  return names;
}

export interface IncomingPart {
  append(bytes: Uint8Array): Promise<void>;
  /** close → read back → SHA-256 → compare to the sidecar hash → move() to the
   *  real name. Mismatch: temp deleted, HashMismatchError thrown, NO rename —
   *  a corrupt part can never be mistaken for a committed one. */
  commit(): Promise<void>;
  /** Best-effort close + delete of the temp (parking path). Never throws. */
  abandon(): Promise<void>;
}

export async function openIncomingPart(takeId: string, entry: SidecarEntry): Promise<IncomingPart> {
  const dir = await remoteDir(takeId);
  const tempName = `${INCOMING_PREFIX}${entry.name}`;
  // create:true reuses (and silently overwrites) a stale temp left by a
  // crashed run — never keepExistingData, same 5A rule as PartWriter.
  const fh = await dir.getFileHandle(tempName, { create: true });
  const writable = await fh.createWritable();

  return {
    async append(bytes: Uint8Array): Promise<void> {
      // `bytes` is typed as bare `Uint8Array` (TS default: `Uint8Array<ArrayBufferLike>`)
      // per the public interface, but createWritable()'s write() wants the
      // stricter `Uint8Array<ArrayBuffer>` (TS 5.7 typed-array generics).
      // Real callers always hand in ArrayBuffer-backed views (WebRTC binary
      // messages are never SharedArrayBuffer) — this just corrects TS's
      // conservative default.
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
    },

    async commit(): Promise<void> {
      await writable.close(); // atomic swap: bytes are durable from this point on
      const file = await fh.getFile();
      const digest = await sha256Hex(await file.arrayBuffer());
      if (digest !== entry.sha256) {
        await dir.removeEntry(tempName);
        throw new HashMismatchError(entry.name);
      }
      await fh.move(entry.name);
    },

    async abandon(): Promise<void> {
      try {
        await writable.close();
      } catch {
        // best-effort — the writable may already be closed or broken
      }
      try {
        await dir.removeEntry(tempName);
      } catch {
        // best-effort — the temp may already be gone (committed or never opened)
      }
    },
  };
}

async function readLocalSidecarParts(
  dir: FileSystemDirectoryHandle,
  base: "audio" | "video",
): Promise<SidecarEntry[] | null> {
  try {
    const fh = await dir.getFileHandle(`${base}.sidecar.json`);
    const text = await (await fh.getFile()).text();
    const parsed = JSON.parse(text) as { parts: SidecarEntry[] };
    return parsed.parts;
  } catch {
    return null;
  }
}

/** Written LAST — the 5C trigger contract. Reads the local sidecars off disk
 *  (null if absent); writes .incoming-episode.json then move()s it into
 *  place, because getFileHandle(create:true) makes an empty file visible
 *  before the writable closes and a bare create would false-trigger the
 *  darkroom watcher. */
export async function writeManifest(
  takeId: string,
  remote: { video: SidecarEntry[]; audio: SidecarEntry[] },
  receivedFrom: string | null,
  deps?: { now?: () => number },
): Promise<void> {
  const now = deps?.now ?? Date.now;
  const dir = await openTakeDir(takeId);

  // Both-or-nothing: partial local sidecars would mean a torn recording,
  // not "this host never recorded" — the spec's stated null case.
  const audio = await readLocalSidecarParts(dir, "audio");
  const video = await readLocalSidecarParts(dir, "video");
  const local = audio && video ? { video, audio } : null;

  const manifest: EpisodeManifest = {
    version: 1,
    episodeId: takeId,
    receivedFrom,
    completedAt: new Date(now()).toISOString(),
    local,
    remote,
  };

  const tempName = `${INCOMING_PREFIX}${MANIFEST_NAME}`;
  const fh = await dir.getFileHandle(tempName, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(manifest, null, 2));
  await writable.close();
  await fh.move(MANIFEST_NAME);
}
