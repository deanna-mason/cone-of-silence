import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTokenStore } from "../src/tokens/fileStore.js";
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
