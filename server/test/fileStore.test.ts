import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { StoreUnavailableError } from "../src/tokens/types.js";
import { runTokenStoreContract } from "./tokenStoreContract.js";

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cos-tokens-"));
  return join(dir, "tokens.json");
}

runTokenStoreContract("FileTokenStore", async () =>
  FileTokenStore.open(await freshPath()),
);

describe("FileTokenStore persistence", () => {
  it("reloads grants and events from disk", async () => {
    const path = await freshPath();
    const store = await FileTokenStore.open(path);
    const { token, grant } = await store.mint("alice");
    await store.relabel(grant.id, "alice-2");

    const reloaded = await FileTokenStore.open(path);
    const grants = await reloaded.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.label).toBe("alice-2");
    expect((await reloaded.verify(token)).ok).toBe(true);
    expect((await reloaded.listEvents(grant.id)).map((e) => e.event)).toEqual([
      "minted",
      "relabeled",
    ]);
  });
});

describe("FileTokenStore corruption handling", () => {
  it("rejects with StoreUnavailableError when the file contains invalid JSON", async () => {
    const path = await freshPath();
    await writeFile(path, "{ not json");

    await expect(FileTokenStore.open(path)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
  });

  it("rejects with StoreUnavailableError when the file is valid JSON of the wrong shape", async () => {
    const path = await freshPath();
    await writeFile(path, "{}");

    await expect(FileTokenStore.open(path)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
  });

  it("starts a working empty store when the file is merely missing", async () => {
    const path = await freshPath();

    const store = await FileTokenStore.open(path);
    const { grant } = await store.mint("bob");

    expect((await store.list()).map((g) => g.id)).toEqual([grant.id]);
  });
});

describe("FileTokenStore legacy grant normalization", () => {
  it("normalizes legacy grants without kind field to room-creation", async () => {
    const path = await freshPath();
    const legacyGrant = {
      id: "test-grant-id",
      label: "legacy-token",
      tokenHash: "abc123hash",
      createdAt: "2026-01-01T00:00:00Z",
      lastUsedAt: null,
      revokedAt: null,
      // Note: no 'kind' field (legacy shape)
    };
    await writeFile(
      path,
      JSON.stringify({
        grants: [legacyGrant],
        events: [],
      }),
    );

    const store = await FileTokenStore.open(path);
    const grants = await store.list();

    expect(grants).toHaveLength(1);
    expect(grants[0]?.id).toBe("test-grant-id");
    expect(grants[0]?.kind).toBe("room-creation");
  });
});
