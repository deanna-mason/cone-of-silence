import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { FakeAccountStore, FakeRecordingStore } from "./fakes.js";

const SECRET = "correct-horse-battery-staple";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cos-list-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  const uploadDir = await mkdtemp(join(tmpdir(), "cos-list-uploads-"));
  const app = createApp({
    store,
    accounts: new FakeAccountStore(),
    adminSecret: SECRET,
    allowedOrigins: ["http://localhost:3000"],
    recordings: new FakeRecordingStore(),
    uploadDir,
    runner: { kick() {} },
  });
  return { app, store };
}

describe("GET /admin/tokens", () => {
  it("lists grants without hashes or plaintext tokens", async () => {
    const { app, store } = await setup();
    const { token } = await store.mint("alice");
    const res = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(1);
    expect(res.body.grants[0].label).toBe("alice");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(token);
    expect(raw).not.toMatch(/tokenHash|token_hash/);
  });

  it("answers CORS preflight for an allowed origin only", async () => {
    const { app } = await setup();
    const ok = await request(app)
      .options("/admin/tokens")
      .set("Origin", "http://localhost:3000");
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    const bad = await request(app)
      .options("/admin/tokens")
      .set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
