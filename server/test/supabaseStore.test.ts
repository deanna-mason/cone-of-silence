import ws from "ws";
import { createClient, type WebSocketLikeConstructor } from "@supabase/supabase-js";
import { describe, it } from "vitest";
import { SupabaseTokenStore } from "../src/tokens/supabaseStore.js";
import { runTokenStoreContract } from "./tokenStoreContract.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Networked test — runs ONLY when explicitly pointed at a project:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx vitest run test/supabaseStore.test.ts
if (url && key) {
  const client = createClient(url, key, {
    auth: { persistSession: false },
    // Node 20 lacks native WebSocket; supabase-js's constructor requires one even though this store never uses realtime. Remove when the runtime is Node >= 22.
    realtime: { transport: ws as WebSocketLikeConstructor },
  });
  runTokenStoreContract("SupabaseTokenStore", async () => {
    // isolate runs: wipe rows from prior test runs (service role bypasses RLS)
    await client.from("creation_tokens").delete().neq("label", "");
    return new SupabaseTokenStore(client);
  });
} else {
  describe("SupabaseTokenStore (skipped)", () => {
    it.skip("set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run", () => {});
  });
}
