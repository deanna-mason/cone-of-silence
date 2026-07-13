import { describe, expect, it } from "vitest";
import type { TokenStore } from "../src/tokens/types.js";
import { GrantNotFoundError } from "../src/tokens/types.js";

/** Every TokenStore implementation must pass this exact suite. */
export function runTokenStoreContract(
  name: string,
  makeStore: () => Promise<TokenStore>,
) {
  describe(`TokenStore contract: ${name}`, () => {
    it("mints a grant and returns the plaintext token once", async () => {
      const store = await makeStore();
      const { token, grant } = await store.mint("alice");
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(grant.label).toBe("alice");
      expect(grant.revokedAt).toBeNull();
      expect(grant.lastUsedAt).toBeNull();
      const listed = await store.list();
      expect(listed.map((g) => g.id)).toContain(grant.id);
      // plaintext token must not appear anywhere in the listing
      expect(JSON.stringify(listed)).not.toContain(token);
    });

    it("verifies a minted token and touches lastUsedAt", async () => {
      const store = await makeStore();
      const { token, grant } = await store.mint("bob");
      const result = await store.verify(token);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.grant.id).toBe(grant.id);
      const after = (await store.list()).find((g) => g.id === grant.id);
      expect(after?.lastUsedAt).not.toBeNull();
    });

    it("verify with touch:false does not update lastUsedAt", async () => {
      const store = await makeStore();
      const { token, grant } = await store.mint("carol");
      const result = await store.verify(token, { touch: false });
      expect(result.ok).toBe(true);
      const after = (await store.list()).find((g) => g.id === grant.id);
      expect(after?.lastUsedAt).toBeNull();
    });

    it("rejects an unknown token as invalid", async () => {
      const store = await makeStore();
      await store.mint("dave");
      const result = await store.verify("AAAAAAAAAAAAAAAAAAAAAA");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("records a minted event", async () => {
      const store = await makeStore();
      const { grant } = await store.mint("eve");
      const events = await store.listEvents(grant.id);
      expect(events.map((e) => e.event)).toEqual(["minted"]);
    });

    it("relabels and records the change", async () => {
      const store = await makeStore();
      const { grant } = await store.mint("frank");
      const updated = await store.relabel(grant.id, "frank-laptop");
      expect(updated.label).toBe("frank-laptop");
      const events = await store.listEvents(grant.id);
      expect(events.map((e) => e.event)).toEqual(["minted", "relabeled"]);
      expect(events[1]?.detail).toEqual({ from: "frank", to: "frank-laptop" });
    });

    it("revoked tokens fail verify with reason revoked; restore reactivates", async () => {
      const store = await makeStore();
      const { token, grant } = await store.mint("grace");
      await store.revoke(grant.id);
      expect(await store.verify(token)).toEqual({ ok: false, reason: "revoked" });
      const restored = await store.restore(grant.id);
      expect(restored.revokedAt).toBeNull();
      const again = await store.verify(token);
      expect(again.ok).toBe(true);
      const events = await store.listEvents(grant.id);
      expect(events.map((e) => e.event)).toEqual(["minted", "revoked", "restored"]);
    });

    it("purge removes the grant and its events", async () => {
      const store = await makeStore();
      const { token, grant } = await store.mint("heidi");
      await store.purge(grant.id);
      expect((await store.list()).map((g) => g.id)).not.toContain(grant.id);
      expect(await store.verify(token)).toEqual({ ok: false, reason: "invalid" });
    });

    it("relabel/revoke/restore/purge on unknown id throw GrantNotFoundError", async () => {
      const store = await makeStore();
      await expect(store.relabel("nope", "x")).rejects.toBeInstanceOf(GrantNotFoundError);
      await expect(store.revoke("nope")).rejects.toBeInstanceOf(GrantNotFoundError);
      await expect(store.restore("nope")).rejects.toBeInstanceOf(GrantNotFoundError);
      await expect(store.purge("nope")).rejects.toBeInstanceOf(GrantNotFoundError);
    });
  });
}
