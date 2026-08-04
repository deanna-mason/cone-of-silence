import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/tokens/createStore.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { SupabaseTokenStore } from "../src/tokens/supabaseStore.js";

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cos-createstore-"));
  return join(dir, "tokens.json");
}

// Every case passes an explicit env object, so nothing here reads (or depends
// on) the ambient process environment.
describe("createStore", () => {
  it("defaults to the file store when TOKEN_STORE is unset", async () => {
    const store = await createStore({ TOKEN_FILE: await freshPath() });
    expect(store).toBeInstanceOf(FileTokenStore);
  });

  it("reads the file store's path from TOKEN_FILE", async () => {
    const path = await freshPath();
    await writeFile(path, "{ not json"); // only the chosen path can produce this failure
    await expect(createStore({ TOKEN_STORE: "file", TOKEN_FILE: path })).rejects.toThrow(path);
  });

  it("builds a Supabase-backed store when TOKEN_STORE=supabase and credentials are present", async () => {
    const store = await createStore({
      TOKEN_STORE: "supabase",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });
    expect(store).toBeInstanceOf(SupabaseTokenStore);
  });

  it("turns a missing Supabase credential into an actionable boot error", async () => {
    await expect(createStore({ TOKEN_STORE: "supabase" })).rejects.toThrow(
      "TOKEN_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
    await expect(
      createStore({ TOKEN_STORE: "supabase", SUPABASE_URL: "https://example.supabase.co" }),
    ).rejects.toThrow("TOKEN_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  });

  it("throws on an unknown TOKEN_STORE rather than silently falling back to a file", async () => {
    await expect(createStore({ TOKEN_STORE: "postgres" })).rejects.toThrow(
      "unknown TOKEN_STORE: postgres",
    );
  });
});
