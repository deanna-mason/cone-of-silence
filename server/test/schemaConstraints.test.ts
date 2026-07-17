import { randomUUID } from "node:crypto";
import ws from "ws";
import { createClient, type WebSocketLikeConstructor } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Networked test — runs ONLY when explicitly pointed at a project:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx vitest run test/schemaConstraints.test.ts
//
// The DB is the last line of defense: token_hash columns hold SHA-256 hex and
// nothing else, enforced by CHECK so a future code bug can't store raw tokens.
if (url && key) {
  const client = createClient(url, key, {
    auth: { persistSession: false },
    // Node 20 lacks native WebSocket; supabase-js's constructor requires one even though this store never uses realtime. Remove when the runtime is Node >= 22.
    realtime: { transport: ws as WebSocketLikeConstructor },
  });

  describe("token_hash format CHECKs", () => {
    it("creation_tokens rejects a non-SHA-256-hex token_hash", async () => {
      const junk = `junk-${randomUUID()}`;
      const { error } = await client
        .from("creation_tokens")
        .insert({ label: "schema-check-probe", token_hash: junk });
      // If the insert slipped through, the constraint is missing — clean up.
      if (!error) await client.from("creation_tokens").delete().eq("token_hash", junk);
      expect(error?.message ?? "").toMatch(/check|violat/i);
    });

    it("sessions rejects a non-SHA-256-hex token_hash", async () => {
      const junk = `junk-${randomUUID()}`;
      const username = `schemaprobe${randomUUID().slice(0, 6).replaceAll("-", "")}`;
      const { data: user, error: userErr } = await client
        .from("users")
        .insert({ username, password_hash: "x" })
        .select()
        .single<{ id: string }>();
      expect(userErr).toBeNull();
      try {
        const { error } = await client.from("sessions").insert({
          user_id: user!.id,
          token_hash: junk,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(error?.message ?? "").toMatch(/check|violat/i);
      } finally {
        // cascades to any session row that slipped through
        await client.from("users").delete().eq("id", user!.id);
      }
    });
  });
} else {
  describe("token_hash format CHECKs (skipped)", () => {
    it.skip("set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run", () => {});
  });
}
