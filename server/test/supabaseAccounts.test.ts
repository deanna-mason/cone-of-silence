import ws from "ws";
import { createClient, type WebSocketLikeConstructor } from "@supabase/supabase-js";
import { describe, it } from "vitest";
import { SupabaseAccountStore } from "../src/accounts/supabaseAccounts.js";
import { accountStoreContract } from "./accountStoreContract.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Networked test — runs ONLY when explicitly pointed at a project:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx vitest run test/supabaseAccounts.test.ts
if (url && key) {
  const client = createClient(url, key, {
    auth: { persistSession: false },
    // Node 20 lacks native WebSocket; supabase-js's constructor requires one even though this store never uses realtime. Remove when the runtime is Node >= 22.
    realtime: { transport: ws as WebSocketLikeConstructor },
  });
  // Every username the contract creates carries this marker, so cleanup can be
  // scoped to rows these tests own — a blanket delete would wipe whatever
  // project the creds happen to point at. No SQL LIKE wildcards ("%", "_") in
  // it, or the pattern below would widen past the test rows.
  const TEST_PREFIX = "costest";

  describe("SupabaseAccountStore (contract)", () => {
    accountStoreContract(async () => {
      // isolate runs: wipe only this suite's rows, including any left by a
      // crashed prior run (service role bypasses RLS).
      // sessions cascade-delete via users' FK, so clearing users is sufficient.
      await client.from("users").delete().like("username", `${TEST_PREFIX}%`);
      return new SupabaseAccountStore(client);
    }, TEST_PREFIX);
  });
} else {
  describe("SupabaseAccountStore (skipped)", () => {
    it.skip("set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run", () => {});
  });
}
