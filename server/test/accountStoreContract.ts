import { expect, it } from "vitest";
import type { AccountStore } from "../src/accounts/types.js";
import { UsernameTakenError } from "../src/accounts/types.js";
import { hashToken } from "../src/tokens/crypto.js";

export function accountStoreContract(makeStore: () => Promise<AccountStore>) {
  it("creates a user and finds their credentials", async () => {
    const store = await makeStore();
    const user = await store.createUser("deanna", "hash123");
    expect(user.username).toBe("deanna");
    const creds = await store.getCredentials("deanna");
    expect(creds?.passwordHash).toBe("hash123");
    expect(creds?.user.id).toBe(user.id);
    expect(await store.getCredentials("nobody")).toBeNull();
  });

  it("refuses a duplicate username", async () => {
    const store = await makeStore();
    await store.createUser("taken", "h1");
    await expect(store.createUser("taken", "h2")).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it("round-trips a session and honors expiry", async () => {
    const store = await makeStore();
    const user = await store.createUser("sess", "h");
    const live = hashToken("live-token");
    await store.createSession(user.id, live, new Date(Date.now() + 60_000).toISOString());
    expect((await store.getSession(live))?.username).toBe("sess");

    const dead = hashToken("dead-token");
    await store.createSession(user.id, dead, new Date(Date.now() - 1_000).toISOString());
    expect(await store.getSession(dead)).toBeNull(); // expired ⇒ null

    await store.deleteSession(live);
    expect(await store.getSession(live)).toBeNull(); // logged out ⇒ null
  });
}
