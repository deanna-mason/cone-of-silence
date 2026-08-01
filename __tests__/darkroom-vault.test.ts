// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { DarkroomError } from "../scripts/darkroom/errors.mjs";
import { scanVault, readEpisode, verifyEpisode } from "../scripts/darkroom/vault.mjs";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// Computes size + SHA-256 the same way the vault does (independently of
// whatever vault.mjs does internally), and writes the bytes to disk.
async function writePart(
  dir: string,
  name: string,
  bytes: Buffer,
): Promise<{ name: string; size: number; sha256: string }> {
  await fsp.writeFile(path.join(dir, name), bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { name, size: bytes.length, sha256 };
}

interface SidecarEntry {
  name: string;
  size: number;
  sha256: string;
}

function manifestOf(opts: {
  episodeId: string;
  receivedFrom?: string | null;
  local?: { audio: SidecarEntry[]; video: SidecarEntry[] } | null;
  remote?: { audio: SidecarEntry[]; video: SidecarEntry[] };
}) {
  return {
    version: 1,
    episodeId: opts.episodeId,
    receivedFrom: opts.receivedFrom ?? null,
    completedAt: new Date(0).toISOString(),
    local: opts.local === undefined ? null : opts.local,
    remote: opts.remote ?? { audio: [], video: [] },
  };
}

async function writeManifestFile(dir: string, manifest: unknown): Promise<void> {
  await fsp.writeFile(path.join(dir, "episode.json"), JSON.stringify(manifest, null, 2));
}

describe("darkroom vault", () => {
  describe("scanVault", () => {
    it("finds only manifest-bearing take dirs, sorted, skipping episodes/", async () => {
      const withManifest = path.join(tmpRoot, "take-20260101-0000-aaaa");
      const noManifest = path.join(tmpRoot, "take-20260101-0001-bbbb");
      const episodesDir = path.join(tmpRoot, "episodes");
      const junkDir = path.join(tmpRoot, "junk-dir");
      await fsp.mkdir(withManifest, { recursive: true });
      await fsp.mkdir(noManifest, { recursive: true });
      await fsp.mkdir(episodesDir, { recursive: true });
      await fsp.mkdir(junkDir, { recursive: true });
      await writeManifestFile(withManifest, manifestOf({ episodeId: "take-20260101-0000-aaaa" }));

      const hits = await scanVault(tmpRoot);

      expect(hits).toEqual([
        {
          takeId: "take-20260101-0000-aaaa",
          dir: withManifest,
          manifestPath: path.join(withManifest, "episode.json"),
        },
      ]);
    });

    it("sorts multiple hits by takeId", async () => {
      const later = path.join(tmpRoot, "take-20260101-0100-cccc");
      const earlier = path.join(tmpRoot, "take-20260101-0000-aaaa");
      await fsp.mkdir(later, { recursive: true });
      await fsp.mkdir(earlier, { recursive: true });
      await writeManifestFile(later, manifestOf({ episodeId: "take-20260101-0100-cccc" }));
      await writeManifestFile(earlier, manifestOf({ episodeId: "take-20260101-0000-aaaa" }));

      const hits = await scanVault(tmpRoot);

      expect(hits.map((h) => h.takeId)).toEqual(["take-20260101-0000-aaaa", "take-20260101-0100-cccc"]);
    });
  });

  describe("readEpisode", () => {
    it("maps local root + remote/ dirs and omits empty streams", async () => {
      const takeDir = path.join(tmpRoot, "take-20260101-0000-aaaa");
      await fsp.mkdir(takeDir, { recursive: true });
      const localAudio: SidecarEntry = { name: "audio.part000", size: 10, sha256: "a".repeat(64) };
      const remoteAudio: SidecarEntry = { name: "audio.part000", size: 10, sha256: "b".repeat(64) };
      const remoteVideo: SidecarEntry = { name: "video.part000", size: 20, sha256: "c".repeat(64) };
      await writeManifestFile(
        takeDir,
        manifestOf({
          episodeId: "take-20260101-0000-aaaa",
          local: { audio: [localAudio], video: [] },
          remote: { audio: [remoteAudio], video: [remoteVideo] },
        }),
      );

      const episode = await readEpisode(takeDir);

      expect(episode.streams).toEqual([
        { host: "local", base: "audio", dir: takeDir, entries: [localAudio] },
        { host: "remote", base: "audio", dir: path.join(takeDir, "remote"), entries: [remoteAudio] },
        { host: "remote", base: "video", dir: path.join(takeDir, "remote"), entries: [remoteVideo] },
      ]);
    });

    it("treats local: null as valid and produces no local streams", async () => {
      const takeDir = path.join(tmpRoot, "take-20260101-0000-aaaa");
      await fsp.mkdir(takeDir, { recursive: true });
      const remoteAudio: SidecarEntry = { name: "audio.part000", size: 10, sha256: "b".repeat(64) };
      await writeManifestFile(
        takeDir,
        manifestOf({
          episodeId: "take-20260101-0000-aaaa",
          local: null,
          remote: { audio: [remoteAudio], video: [] },
        }),
      );

      const episode = await readEpisode(takeDir);

      expect(episode.streams).toEqual([
        { host: "remote", base: "audio", dir: path.join(takeDir, "remote"), entries: [remoteAudio] },
      ]);
    });

    it("rejects a manifest missing remote with manifest-invalid", async () => {
      const takeDir = path.join(tmpRoot, "take-20260101-0000-aaaa");
      await fsp.mkdir(takeDir, { recursive: true });
      const manifest = manifestOf({ episodeId: "take-20260101-0000-aaaa" }) as Record<string, unknown>;
      delete manifest.remote;
      await writeManifestFile(takeDir, manifest);

      await expect(readEpisode(takeDir)).rejects.toMatchObject({ code: "manifest-invalid" });
      await expect(readEpisode(takeDir)).rejects.toBeInstanceOf(DarkroomError);
    });
  });

  describe("verifyEpisode", () => {
    async function buildValidTwoHostEpisode() {
      const takeDir = path.join(tmpRoot, "take-20260101-0000-aaaa");
      const remoteDir = path.join(takeDir, "remote");
      await fsp.mkdir(remoteDir, { recursive: true });

      const localAudio000 = await writePart(takeDir, "audio.part000", crypto.randomBytes(128));
      const localAudio001 = await writePart(takeDir, "audio.part001", crypto.randomBytes(128));
      const remoteAudio000 = await writePart(remoteDir, "audio.part000", crypto.randomBytes(128));
      const remoteVideo000 = await writePart(remoteDir, "video.part000", crypto.randomBytes(256));

      const manifest = manifestOf({
        episodeId: "take-20260101-0000-aaaa",
        local: { audio: [localAudio000, localAudio001], video: [] },
        remote: { audio: [remoteAudio000], video: [remoteVideo000] },
      });
      await writeManifestFile(takeDir, manifest);

      return { takeDir, remoteDir };
    }

    it("passes a fully valid two-host episode", async () => {
      const { takeDir } = await buildValidTwoHostEpisode();
      const episode = await readEpisode(takeDir);

      await expect(verifyEpisode(episode)).resolves.toBeUndefined();
    });

    it("part listed but missing on disk → part-missing", async () => {
      const { takeDir, remoteDir } = await buildValidTwoHostEpisode();
      const episode = await readEpisode(takeDir);
      await fsp.rm(path.join(remoteDir, "audio.part000"));

      await expect(verifyEpisode(episode)).rejects.toMatchObject({ code: "part-missing" });
    });

    it("index list skips 001 (names 000,002) → part-gap", async () => {
      const takeDir = path.join(tmpRoot, "take-20260101-0000-aaaa");
      const remoteDir = path.join(takeDir, "remote");
      await fsp.mkdir(remoteDir, { recursive: true });

      const part000 = await writePart(remoteDir, "audio.part000", crypto.randomBytes(64));
      const part002 = await writePart(remoteDir, "audio.part002", crypto.randomBytes(64));

      const manifest = manifestOf({
        episodeId: "take-20260101-0000-aaaa",
        local: null,
        remote: { audio: [part000, part002], video: [] },
      });
      await writeManifestFile(takeDir, manifest);

      const episode = await readEpisode(takeDir);

      await expect(verifyEpisode(episode)).rejects.toMatchObject({ code: "part-gap" });
    });

    it("one flipped byte → hash-mismatch naming the part", async () => {
      const { takeDir, remoteDir } = await buildValidTwoHostEpisode();
      const episode = await readEpisode(takeDir);
      const filePath = path.join(remoteDir, "video.part000");
      const bytes = await fsp.readFile(filePath);
      bytes[0] = bytes[0] ^ 0xff;
      await fsp.writeFile(filePath, bytes);

      await expect(verifyEpisode(episode)).rejects.toMatchObject({ code: "hash-mismatch" });
    });

    it("truncated part → size-mismatch (checked before hash)", async () => {
      const { takeDir, remoteDir } = await buildValidTwoHostEpisode();
      const episode = await readEpisode(takeDir);
      const filePath = path.join(remoteDir, "video.part000");
      const bytes = await fsp.readFile(filePath);
      await fsp.writeFile(filePath, bytes.subarray(0, bytes.length - 10));

      await expect(verifyEpisode(episode)).rejects.toMatchObject({ code: "size-mismatch" });
    });

    it("mutates nothing (dir mtime snapshot before/after)", async () => {
      const { takeDir, remoteDir } = await buildValidTwoHostEpisode();
      const episode = await readEpisode(takeDir);

      const before = {
        takeDirMtime: (await fsp.stat(takeDir)).mtimeMs,
        remoteDirMtime: (await fsp.stat(remoteDir)).mtimeMs,
        takeDirEntries: (await fsp.readdir(takeDir)).sort(),
        remoteDirEntries: (await fsp.readdir(remoteDir)).sort(),
      };

      await verifyEpisode(episode);

      const after = {
        takeDirMtime: (await fsp.stat(takeDir)).mtimeMs,
        remoteDirMtime: (await fsp.stat(remoteDir)).mtimeMs,
        takeDirEntries: (await fsp.readdir(takeDir)).sort(),
        remoteDirEntries: (await fsp.readdir(remoteDir)).sort(),
      };

      expect(after).toEqual(before);
    });
  });
});
