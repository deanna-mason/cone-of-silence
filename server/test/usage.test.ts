import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dirSizeBytes } from "../src/studio/usage.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cos-usage-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("dirSizeBytes", () => {
  it("reports 0 for a directory that does not exist (user has never uploaded)", async () => {
    const dir = await tempDir();
    expect(await dirSizeBytes(join(dir, "no-such-user"))).toBe(0);
  });

  it("sums file sizes across nested directories, ignoring the directory entries themselves", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "top.bin"), Buffer.alloc(10));
    await mkdir(join(dir, "rec", "deep"), { recursive: true });
    await writeFile(join(dir, "rec", "source.bin"), Buffer.alloc(100));
    await writeFile(join(dir, "rec", "deep", "enhanced.bin"), Buffer.alloc(1_000));
    expect(await dirSizeBytes(dir)).toBe(1_110);
  });

  it("returns 0 for an empty directory", async () => {
    expect(await dirSizeBytes(await tempDir())).toBe(0);
  });

  it("propagates a non-ENOENT fs error so the quota check fails CLOSED", async () => {
    // A plain file where a directory is expected → ENOTDIR, not ENOENT. Must
    // NOT be swallowed as "0 bytes used", which would hand out unlimited quota.
    const dir = await tempDir();
    const notADir = join(dir, "regular-file");
    await writeFile(notADir, "x");
    await expect(dirSizeBytes(notADir)).rejects.toThrow();
    await expect(dirSizeBytes(notADir)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
