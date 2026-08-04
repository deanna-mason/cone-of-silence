import { expect, it } from "vitest";
import type { AccountStore } from "../src/accounts/types.js";
import { UsernameTakenError } from "../src/accounts/types.js";
import { hashToken } from "../src/tokens/crypto.js";

/** Every AccountStore implementation must pass this exact suite.
 *
 * `prefix` is prepended to every username the suite creates so a store backed by
 * a shared database can scope its own cleanup to rows this suite owns. It must
 * keep the usernames valid (lowercase a-z0-9_, 3-20 chars total). */
export function accountStoreContract(makeStore: () => Promise<AccountStore>, prefix = "") {
  it("creates a user and finds their credentials", async () => {
    const store = await makeStore();
    const user = await store.createUser(`${prefix}deanna`, "hash123");
    expect(user.username).toBe(`${prefix}deanna`);
    const creds = await store.getCredentials(`${prefix}deanna`);
    expect(creds?.passwordHash).toBe("hash123");
    expect(creds?.user.id).toBe(user.id);
    expect(await store.getCredentials(`${prefix}nobody`)).toBeNull();
  });

  it("refuses a duplicate username", async () => {
    const store = await makeStore();
    await store.createUser(`${prefix}taken`, "h1");
    await expect(store.createUser(`${prefix}taken`, "h2")).rejects.toBeInstanceOf(
      UsernameTakenError,
    );
  });

  it("round-trips a session and honors expiry", async () => {
    const store = await makeStore();
    const user = await store.createUser(`${prefix}sess`, "h");
    const live = hashToken("live-token");
    await store.createSession(user.id, live, new Date(Date.now() + 60_000).toISOString());
    expect((await store.getSession(live))?.username).toBe(`${prefix}sess`);

    const dead = hashToken("dead-token");
    await store.createSession(user.id, dead, new Date(Date.now() - 1_000).toISOString());
    expect(await store.getSession(dead)).toBeNull(); // expired ⇒ null

    await store.deleteSession(live);
    expect(await store.getSession(live)).toBeNull(); // logged out ⇒ null
  });
}
