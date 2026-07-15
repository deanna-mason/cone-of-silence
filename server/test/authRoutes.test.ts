import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { FakeAccountStore } from "./fakes.js";

const ADMIN = "test-admin-secret-16chars";

async function makeApp() {
  const dir = await mkdtemp(join(tmpdir(), "cos-auth-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  const accounts = new FakeAccountStore();
  const app = createApp({
    store,
    accounts,
    adminSecret: ADMIN,
    allowedOrigins: ["http://localhost:3000"],
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
});
