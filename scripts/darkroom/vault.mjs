// Tape Vault scan + manifest read + verification. Read-only: nothing here
// ever writes, deletes, or renames anything under a take dir — sources are
// sacred (see the plan's Global Constraints). fs + node:crypto only.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { DarkroomError } from "./errors.mjs";

const TAKE_DIR_RE = /^take-\d{8}-\d{4}-[0-9a-f]{4}$/;
const MANIFEST_NAME = "episode.json";
const REMOTE_DIR = "remote";
const BASES = ["audio", "video"];

/** Subdirs of `vaultDir` matching the take-dir pattern that contain an
 *  episode.json, sorted by takeId. Everything else (episodes/, junk dirs,
 *  a take dir with no manifest yet) is skipped silently. */
export async function scanVault(vaultDir) {
  const entries = await fsp.readdir(vaultDir, { withFileTypes: true });
  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TAKE_DIR_RE.test(entry.name)) continue;
    const dir = path.join(vaultDir, entry.name);
    const manifestPath = path.join(dir, MANIFEST_NAME);
    try {
      await fsp.access(manifestPath, fs.constants.F_OK);
    } catch {
      continue;
    }
    hits.push({ takeId: entry.name, dir, manifestPath });
  }
  hits.sort((a, b) => (a.takeId < b.takeId ? -1 : a.takeId > b.takeId ? 1 : 0));
  return hits;
}

function isSidecarEntry(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.sha256 === "string"
  );
}

function isSidecarEntryArray(value) {
  return Array.isArray(value) && value.every(isSidecarEntry);
}

function isStreamPair(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isSidecarEntryArray(value.audio) &&
    isSidecarEntryArray(value.video)
  );
}

/** Throws `manifest-invalid` on the first missing/mistyped field. `local:
 *  null` and empty entry lists (`audio: []` / `video: []`) are valid. */
function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== "object") {
    throw new DarkroomError("manifest-invalid", "manifest is not an object");
  }
  if (manifest.version !== 1) {
    throw new DarkroomError("manifest-invalid", "version must be 1");
  }
  if (typeof manifest.episodeId !== "string") {
    throw new DarkroomError("manifest-invalid", "episodeId must be a string");
  }
  if (manifest.receivedFrom !== null && typeof manifest.receivedFrom !== "string") {
    throw new DarkroomError("manifest-invalid", "receivedFrom must be a string or null");
  }
  if (typeof manifest.completedAt !== "string") {
    throw new DarkroomError("manifest-invalid", "completedAt must be a string");
  }
  if (manifest.local !== null && !isStreamPair(manifest.local)) {
    throw new DarkroomError("manifest-invalid", "local must be null or {audio,video} sidecar-entry arrays");
  }
  if (!isStreamPair(manifest.remote)) {
    throw new DarkroomError("manifest-invalid", "remote must be {audio,video} sidecar-entry arrays");
  }
}

/** Reads + shape-validates a take dir's episode.json. Local streams read
 *  from the manifest's `local` lists with dir = takeDir; remote streams
 *  from `remote` with dir = takeDir/remote. A stream with an empty entry
 *  list is omitted from the result entirely. */
export async function readEpisode(takeDir) {
  const manifestPath = path.join(takeDir, MANIFEST_NAME);
  let raw;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch (err) {
    if (err instanceof DarkroomError) throw err;
    throw new DarkroomError("manifest-invalid", `cannot read ${manifestPath}: ${err.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new DarkroomError("manifest-invalid", `${manifestPath} is not valid JSON: ${err.message}`);
  }

  validateManifest(manifest);

  const streams = [];
  if (manifest.local !== null) {
    for (const base of BASES) {
      const entries = manifest.local[base];
      if (entries.length > 0) {
        streams.push({ host: "local", base, dir: takeDir, entries });
      }
    }
  }
  const remoteDir = path.join(takeDir, REMOTE_DIR);
  for (const base of BASES) {
    const entries = manifest.remote[base];
    if (entries.length > 0) {
      streams.push({ host: "remote", base, dir: remoteDir, entries });
    }
  }

  return { manifest, streams };
}

function parsePartIndex(name) {
  const match = /\.part(\d+)$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Indices parsed from the entry names must be exactly 000..N-1 with no
 *  gap or duplicate. Pure list inspection — never touches disk. */
function checkNoGap(host, base, dir, entries) {
  const indices = entries.map((entry) => parsePartIndex(entry.name));
  if (indices.some((index) => index === null)) {
    throw new DarkroomError("part-gap", `${host}/${base} in ${dir}: unrecognized part name`);
  }
  const seen = new Set();
  for (const index of indices) {
    if (seen.has(index)) {
      throw new DarkroomError("part-gap", `${host}/${base} in ${dir}: duplicate part index ${index}`);
    }
    seen.add(index);
  }
  for (let expected = 0; expected < entries.length; expected += 1) {
    if (!seen.has(expected)) {
      const have = [...seen].sort((a, b) => a - b).join(",");
      throw new DarkroomError(
        "part-gap",
        `${host}/${base} in ${dir}: missing part index ${expected} (have ${have})`,
      );
    }
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Verifies every stream of an episode, in order: existence of every named
 *  part, no index gap/duplicate, byte size, then streamed SHA-256. Read-only
 *  — never writes anything, on success or failure. */
export async function verifyEpisode(episode) {
  for (const stream of episode.streams) {
    const { host, base, dir, entries } = stream;

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      try {
        await fsp.access(filePath, fs.constants.F_OK);
      } catch {
        throw new DarkroomError("part-missing", `${host}/${base}: ${filePath}`);
      }
    }

    checkNoGap(host, base, dir, entries);

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      const stat = await fsp.stat(filePath);
      if (stat.size !== entry.size) {
        throw new DarkroomError(
          "size-mismatch",
          `${host}/${base}/${entry.name}: expected ${entry.size} bytes, found ${stat.size}`,
        );
      }
      const actual = await sha256File(filePath);
      if (actual !== entry.sha256) {
        throw new DarkroomError("hash-mismatch", `${host}/${base}/${entry.name}: sha256 mismatch`);
      }
    }
  }
}
