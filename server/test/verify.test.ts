import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cos-verify-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  const app = createApp({ store, adminSecret: "s".repeat(32), allowedOrigins: [] });
  return { app, store };
}

describe("POST /tokens/verify", () => {
  it("confirms a valid token WITHOUT touching lastUsedAt, and returns its label", async () => {
    const { app, store } = await setup();
    const { token, grant } = await store.mint("alice");
    const res = await request(app).post("/tokens/verify").send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, label: "alice" });
    const after = (await store.list()).find((g) => g.id === grant.id);
    expect(after?.lastUsedAt).toBeNull(); // lobby check ≠ room creation
  });

  it("reports revoked tokens", async () => {
    const { app, store } = await setup();
    const { token, grant } = await store.mint("bob");
    await store.revoke(grant.id);
    const res = await request(app).post("/tokens/verify").send({ token });
    expect(res.body).toEqual({ valid: false, reason: "revoked" });
  });

  it("rejects malformed tokens without consulting the store", async () => {
    const { app } = await setup();
    const res = await request(app).post("/tokens/verify").send({ token: "short" });
    expect(res.body).toEqual({ valid: false, reason: "invalid" });
  });

  it("requires no Authorization header (it is the lobby's endpoint)", async () => {
    const { app, store } = await setup();
    const { token } = await store.mint("carol");
    const res = await request(app).post("/tokens/verify").send({ token });
    expect(res.status).toBe(200);
  });
});
