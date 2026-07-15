import { randomUUID } from "node:crypto";
import ws from "ws";
import { createClient, type WebSocketLikeConstructor } from "@supabase/supabase-js";
import { afterAll, describe, it } from "vitest";
import { SupabaseRecordingStore } from "../src/studio/supabaseRecordings.js";
import { recordingStoreContract } from "./recordingStoreContract.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Networked test — runs ONLY when explicitly pointed at a project:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx vitest run test/supabaseRecordings.test.ts
if (url && key) {
  const client = createClient(url, key, {
    auth: { persistSession: false },
    // Node 20 lacks native WebSocket; supabase-js's constructor requires one even though this store never uses realtime. Remove when the runtime is Node >= 22.
    realtime: { transport: ws as WebSocketLikeConstructor },
  });

  // recordings.user_id has an FK to users — the contract's ids need real rows.
  // Fixed UUIDs generated up front so recordingStoreContract's synchronous
  // `ids` argument is available before any test/hook runs.
  const aliceId = randomUUID();
  const bobId = randomUUID();

  describe("SupabaseRecordingStore (contract)", () => {
    afterAll(async () => {
      // users delete cascades to recordings.
      await client.from("users").delete().in("id", [aliceId, bobId]);
    });

    recordingStoreContract(async (ids) => {
      // Idempotent: create the throwaway FK rows on first call, no-op after.
      await client.from("users").upsert(
        ids.map((id) => ({ id, username: `rec_${id.slice(0, 8)}`, password_hash: "x" })),
        { onConflict: "id", ignoreDuplicates: true },
      );
      // isolate runs: wipe recordings left by a prior test in this suite/run.
      await client.from("recordings").delete().in("user_id", ids);
      return new SupabaseRecordingStore(client);
    }, [aliceId, bobId]);
  });
} else {
  describe("SupabaseRecordingStore (skipped)", () => {
    it.skip("set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run", () => {});
  });
}
