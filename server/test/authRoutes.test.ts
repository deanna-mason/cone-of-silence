import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { FakeAccountStore, FakeRecordingStore } from "./fakes.js";

const ADMIN = "test-admin-secret-16chars";

async function makeApp() {
  const dir = await mkdtemp(join(tmpdir(), "cos-auth-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  const accounts = new FakeAccountStore();
  const uploadDir = await mkdtemp(join(tmpdir(), "cos-auth-uploads-"));
  const app = createApp({
    store,
    accounts,
    adminSecret: ADMIN,
    allowedOrigins: ["http://localhost:3000"],
    recordings: new FakeRecordingStore(),
    uploadDir,
    runner: { kick() {} },
  });
  return { app, store, accounts };
}

describe("auth routes", () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  async function signupToken(): Promise<string> {
    const { token } = await ctx.store.mint("invitee", "signup");
    return token;
  }

  it("signs up with a valid signup token, exactly once per token", async () => {
    const token = await signupToken();
    const res = await request(ctx.app)
      .post("/auth/signup")
      .send({ token, username: "deanna", password: "opensesame" });
    expect(res.status).toBe(201);
    expect(res.body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.username).toBe("deanna");

    const again = await request(ctx.app)
      .post("/auth/signup")
      .send({ token, username: "other", password: "opensesame" });
    expect(again.status).toBe(401); // token burned
  });

  it("rejects a room-creation token for signup", async () => {
    const { token } = await ctx.store.mint("room-token"); // default kind
    const res = await request(ctx.app)
      .post("/auth/signup")
      .send({ token, username: "deanna", password: "opensesame" });
    expect(res.status).toBe(401);
  });

  it("rejects bad usernames and short passwords with 400", async () => {
    const token = await signupToken();
    for (const bad of [
      { token, username: "Deanna", password: "opensesame" },
      { token, username: "ok_name", password: "short" },
      { username: "ok_name", password: "opensesame" }, // wrong keys
    ]) {
      const res = await request(ctx.app).post("/auth/signup").send(bad);
      expect(res.status).toBe(400);
    }
  });

  it("does not burn the token when the username is taken", async () => {
    const t1 = await signupToken();
    await request(ctx.app)
      .post("/auth/signup")
      .send({ token: t1, username: "deanna", password: "opensesame" });
    const t2 = await signupToken();
    const dupe = await request(ctx.app)
      .post("/auth/signup")
      .send({ token: t2, username: "deanna", password: "opensesame" });
    expect(dupe.status).toBe(409);
    // token t2 must still work for a different name:
    const retry = await request(ctx.app)
      .post("/auth/signup")
      .send({ token: t2, username: "deanna2", password: "opensesame" });
    expect(retry.status).toBe(201);
  });

  it("restores the token when createUser loses the race to UsernameTakenError", async () => {
    // "deanna" already exists.
    const t1 = await signupToken();
    await request(ctx.app)
      .post("/auth/signup")
      .send({ token: t1, username: "deanna", password: "opensesame" });

    // Force the pre-redeem check to (falsely) report the name free, so the
    // token gets burned and createUser is the one that discovers the clash.
    vi.spyOn(ctx.accounts, "getCredentials").mockResolvedValueOnce(null);

    const t2 = await signupToken();
    const race = await request(ctx.app)
      .post("/auth/signup")
      .send({ token: t2, username: "deanna", password: "opensesame" });
    expect(race.status).toBe(409);
    expect(race.body).toEqual({ error: "codename taken" });

    // The burn must have been compensated: t2 still works for a fresh name.
    const retry = await request(ctx.app)
      .post("/auth/signup")
      .send({ token: t2, username: "deanna3", password: "opensesame" });
    expect(retry.status).toBe(201);
  });

  it("logs in, reads /auth/me, logs out", async () => {
    const token = await signupToken();
    await request(ctx.app)
      .post("/auth/signup")
      .send({ token, username: "deanna", password: "opensesame" });

    const login = await request(ctx.app)
      .post("/auth/login")
      .send({ username: "deanna", password: "opensesame" });
    expect(login.status).toBe(200);
    const bearer = `Bearer ${login.body.session}`;

    const me = await request(ctx.app).get("/auth/me").set("Authorization", bearer);
    expect(me.body).toEqual({ username: "deanna" });

    const out = await request(ctx.app).post("/auth/logout").set("Authorization", bearer);
    expect(out.status).toBe(204);
    const after = await request(ctx.app).get("/auth/me").set("Authorization", bearer);
    expect(after.status).toBe(401);
  });

  it("wrong password is a generic 401 and locks out after 5 tries", async () => {
    const token = await signupToken();
    await request(ctx.app)
      .post("/auth/signup")
      .send({ token, username: "deanna", password: "opensesame" });
    for (let i = 0; i < 5; i++) {
      const res = await request(ctx.app)
        .post("/auth/login")
        .send({ username: "deanna", password: "wrong" });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "denied" });
    }
    const locked = await request(ctx.app)
      .post("/auth/login")
      .send({ username: "deanna", password: "opensesame" });
    expect(locked.status).toBe(429);
  });

  it("unknown bearer on /auth/me is 401", async () => {
    const res = await request(ctx.app).get("/auth/me").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("rejects an over-long username with the same generic 400, before it's used as a lockout key", async () => {
    const res = await request(ctx.app)
      .post("/auth/login")
      .send({ username: "a".repeat(21), password: "opensesame" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "body must be exactly { username, password }" });
  });

  it("a 20-char username (the max valid length) is still checked normally, not rejected", async () => {
    const res = await request(ctx.app)
      .post("/auth/login")
      .send({ username: "a".repeat(20), password: "opensesame" });
    // Not the length-cap 400 — a real (if wrong) credential check happened.
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "denied" });
  });

  it("a stale lockout entry is evicted and the user can log in again once the window elapses", async () => {
    vi.useFakeTimers();
    try {
      const token = await signupToken();
      await request(ctx.app)
        .post("/auth/signup")
        .send({ token, username: "deanna", password: "opensesame" });
      for (let i = 0; i < 5; i++) {
        const res = await request(ctx.app)
          .post("/auth/login")
          .send({ username: "deanna", password: "wrong" });
        expect(res.status).toBe(401);
      }
      const locked = await request(ctx.app)
        .post("/auth/login")
        .send({ username: "deanna", password: "opensesame" });
      expect(locked.status).toBe(429);

      // Advance past the 60s lockout window: the stale entry must be
      // evicted (not just re-checked) and a correct password now succeeds.
      vi.advanceTimersByTime(61_000);
      const after = await request(ctx.app)
        .post("/auth/login")
        .send({ username: "deanna", password: "opensesame" });
      expect(after.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs the cause and still fails closed with a generic 503 when the store throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boom = new Error("connection reset");
      vi.spyOn(ctx.accounts, "getCredentials").mockRejectedValueOnce(boom);

      const res = await request(ctx.app)
        .post("/auth/login")
        .send({ username: "deanna", password: "opensesame" });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "channel unavailable" });
      expect(errorSpy).toHaveBeenCalledWith("[auth]", boom);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
