import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { FakeAccountStore } from "./fakes.js";

const SECRET = "correct-horse-battery-staple";

async function makeApp() {
  const dir = await mkdtemp(join(tmpdir(), "cos-auth-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  return createApp({ store, accounts: new FakeAccountStore(), adminSecret: SECRET, allowedOrigins: [] });
}

describe("admin auth", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects a missing Authorization header", async () => {
    const app = await makeApp();
    const res = await request(app).get("/admin/tokens");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "denied" });
  });

  it("rejects a wrong secret with the same generic denial", async () => {
    const app = await makeApp();
    const res = await request(app)
      .get("/admin/tokens")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "denied" });
  });

  it("accepts the correct secret", async () => {
    const app = await makeApp();
    const res = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ grants: [] });
  });

  it("locks out after 5 consecutive failures, then recovers", async () => {
    const app = await makeApp();
    for (let i = 0; i < 5; i++) {
      await request(app).get("/admin/tokens").set("Authorization", "Bearer wrong");
    }
    // even the CORRECT secret is refused while locked
    const locked = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(locked.status).toBe(429);

    vi.advanceTimersByTime(61_000);
    const after = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(after.status).toBe(200);
  });
});
