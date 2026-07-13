import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { StoreUnavailableError, type TokenStore } from "../src/tokens/types.js";

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

  it("rejects non-string and missing tokens without consulting the store", async () => {
    const { app } = await setup();
    const numeric = await request(app).post("/tokens/verify").send({ token: 123 });
    expect(numeric.body).toEqual({ valid: false, reason: "invalid" });
    const missing = await request(app).post("/tokens/verify").send({});
    expect(missing.body).toEqual({ valid: false, reason: "invalid" });
  });

  it("store outage → 503 channel unavailable (fail closed)", async () => {
    const broken: TokenStore = {
      verify: async () => { throw new StoreUnavailableError("db down"); },
      mint: async () => { throw new StoreUnavailableError("db down"); },
      list: async () => { throw new StoreUnavailableError("db down"); },
      listEvents: async () => { throw new StoreUnavailableError("db down"); },
      relabel: async () => { throw new StoreUnavailableError("db down"); },
      revoke: async () => { throw new StoreUnavailableError("db down"); },
      restore: async () => { throw new StoreUnavailableError("db down"); },
      purge: async () => { throw new StoreUnavailableError("db down"); },
    };
    const app = createApp({ store: broken, adminSecret: "s".repeat(32), allowedOrigins: [] });
    const res = await request(app).post("/tokens/verify").send({ token: "a".repeat(22) });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "channel unavailable" });
  });
});
