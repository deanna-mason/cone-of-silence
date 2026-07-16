import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { StoreUnavailableError, type TokenStore } from "../src/tokens/types.js";
import { FakeAccountStore, FakeRecordingStore } from "./fakes.js";

const SECRET = "correct-horse-battery-staple";
const auth = { Authorization: `Bearer ${SECRET}` };

async function setup(storeOverride?: TokenStore) {
  const dir = await mkdtemp(join(tmpdir(), "cos-crud-"));
  const store = storeOverride ?? (await FileTokenStore.open(join(dir, "tokens.json")));
  const uploadDir = await mkdtemp(join(tmpdir(), "cos-crud-uploads-"));
  const app = createApp({
    store,
    accounts: new FakeAccountStore(),
    adminSecret: SECRET,
    allowedOrigins: [],
    recordings: new FakeRecordingStore(),
    uploadDir,
    runner: { kick() {} },
  });
  return { app, store };
}

describe("admin CRUD", () => {
  it("mints: returns plaintext token once with the grant", async () => {
    const { app } = await setup();
    const res = await request(app).post("/admin/tokens").set(auth).send({ label: "alice" });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.body.grant.label).toBe("alice");
    const list = await request(app).get("/admin/tokens").set(auth);
    expect(JSON.stringify(list.body)).not.toContain(res.body.token);
  });

  it("mints a signup token when kind is given", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/admin/tokens")
      .set(auth)
      .send({ label: "invite", kind: "signup" });
    expect(res.status).toBe(201);
    expect(res.body.grant.kind).toBe("signup");
  });

  it("rejects a bogus kind with 400", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/admin/tokens")
      .set(auth)
      .send({ label: "invite", kind: "bogus" });
    expect(res.status).toBe(400);
  });

  it("defaults to room-creation when kind is omitted", async () => {
    const { app } = await setup();
    const res = await request(app).post("/admin/tokens").set(auth).send({ label: "alice2" });
    expect(res.status).toBe(201);
    expect(res.body.grant.kind).toBe("room-creation");
  });

  it("rejects bad labels and unknown fields with 400", async () => {
    const { app } = await setup();
    for (const body of [
      {},
      { label: "" },
      { label: "   " },
      { label: "x".repeat(65) },
      { label: "ok", extra: true },
      { label: "bad\x07bell" }, // embedded control character
    ]) {
      const res = await request(app).post("/admin/tokens").set(auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("relabels via PATCH {label}", async () => {
    const { app } = await setup();
    const minted = await request(app).post("/admin/tokens").set(auth).send({ label: "bob" });
    const res = await request(app)
      .patch(`/admin/tokens/${minted.body.grant.id}`)
      .set(auth)
      .send({ label: "bob-phone" });
    expect(res.status).toBe(200);
    expect(res.body.grant.label).toBe("bob-phone");
  });

  it("revokes and restores via PATCH {revoked}", async () => {
    const { app } = await setup();
    const minted = await request(app).post("/admin/tokens").set(auth).send({ label: "carol" });
    const id = minted.body.grant.id;
    const revoked = await request(app).patch(`/admin/tokens/${id}`).set(auth).send({ revoked: true });
    expect(revoked.body.grant.revokedAt).not.toBeNull();
    const restored = await request(app).patch(`/admin/tokens/${id}`).set(auth).send({ revoked: false });
    expect(restored.body.grant.revokedAt).toBeNull();
  });

  it("rejects a PATCH mixing label and revoked", async () => {
    const { app } = await setup();
    const minted = await request(app).post("/admin/tokens").set(auth).send({ label: "dave" });
    const res = await request(app)
      .patch(`/admin/tokens/${minted.body.grant.id}`)
      .set(auth)
      .send({ label: "x", revoked: true });
    expect(res.status).toBe(400);
  });

  it("purges via DELETE", async () => {
    const { app } = await setup();
    const minted = await request(app).post("/admin/tokens").set(auth).send({ label: "eve" });
    const res = await request(app).delete(`/admin/tokens/${minted.body.grant.id}`).set(auth);
    expect(res.status).toBe(204);
    const list = await request(app).get("/admin/tokens").set(auth);
    expect(list.body.grants).toHaveLength(0);
  });

  it("unknown ids → 404", async () => {
    const { app } = await setup();
    const patch = await request(app).patch("/admin/tokens/nope").set(auth).send({ revoked: true });
    expect(patch.status).toBe(404);
    const del = await request(app).delete("/admin/tokens/nope").set(auth);
    expect(del.status).toBe(404);
  });

  it("malformed JSON body → 400 invalid JSON", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/admin/tokens")
      .set(auth)
      .set("Content-Type", "application/json")
      .send("{ this is not json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid JSON" });
  });

  it("store outage → 503 channel unavailable (fail closed)", async () => {
    const broken: TokenStore = {
      verify: async () => { throw new StoreUnavailableError("db down"); },
      mint: async () => { throw new StoreUnavailableError("db down"); },
      redeem: async () => { throw new StoreUnavailableError("db down"); },
      list: async () => { throw new StoreUnavailableError("db down"); },
      listEvents: async () => { throw new StoreUnavailableError("db down"); },
      relabel: async () => { throw new StoreUnavailableError("db down"); },
      revoke: async () => { throw new StoreUnavailableError("db down"); },
      restore: async () => { throw new StoreUnavailableError("db down"); },
      purge: async () => { throw new StoreUnavailableError("db down"); },
    };
    const { app } = await setup(broken);
    const res = await request(app).post("/admin/tokens").set(auth).send({ label: "x" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "channel unavailable" });
  });
});
