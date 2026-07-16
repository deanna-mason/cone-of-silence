import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingDir, sourcePath } from "../src/studio/paths.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { FakeAccountStore, FakeRecordingStore, signupAndLogin } from "./fakes.js";

const ADMIN = "test-admin-secret-16chars";

async function makeApp(overrides: { userQuotaBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cos-studio-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  const accounts = new FakeAccountStore();
  const recordings = new FakeRecordingStore();
  const uploadDir = await mkdtemp(join(tmpdir(), "cos-studio-uploads-"));
  const runner = { kick: vi.fn() };
  const app = createApp({
    store,
    accounts,
    adminSecret: ADMIN,
    allowedOrigins: ["http://localhost:3000"],
    recordings,
    uploadDir,
    runner,
    ...overrides,
  });
  return { app, store, accounts, recordings, uploadDir, runner };
}

describe("studio routes", () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let bearer: string;

  beforeEach(async () => {
    ctx = await makeApp();
    bearer = await signupAndLogin(ctx.app, ctx.store, "deanna");
  });

  it("uploads a small mp3, creates a queued recording, kicks the runner", async () => {
    const res = await request(ctx.app)
      .post("/studio/recordings")
      .set("Authorization", bearer)
      .attach("file", Buffer.from("fake-mp3-bytes"), "episode one.mp3");
    expect(res.status).toBe(201);
    expect(res.body.recording.status).toBe("queued");
    expect(res.body.recording.sourceExt).toBe(".mp3");
    expect(ctx.runner.kick).toHaveBeenCalled();
    // source file landed in the recording's directory:
    const dir = recordingDir(ctx.uploadDir, res.body.recording.userId, res.body.recording.id);
    await expect(stat(sourcePath(dir, ".mp3"))).resolves.toBeTruthy();
  });

  it("rejects a disallowed extension with 400 and no row", async () => {
    const res = await request(ctx.app)
      .post("/studio/recordings")
      .set("Authorization", bearer)
      .attach("file", Buffer.from("nope"), "malware.exe");
    expect(res.status).toBe(400);
    expect(ctx.recordings.recordings).toHaveLength(0);
  });

  it("401 without a session", async () => {
    const res = await request(ctx.app).post("/studio/recordings")
      .attach("file", Buffer.from("x"), "a.mp3");
    expect(res.status).toBe(401);
  });

  it("list and get are scoped to the owner; stranger gets 404", async () => {
    const strangerBearer = await signupAndLogin(ctx.app, ctx.store, "stranger");

    const upload = await request(ctx.app)
      .post("/studio/recordings")
      .set("Authorization", bearer)
      .attach("file", Buffer.from("fake-mp3-bytes"), "mine.mp3");
    expect(upload.status).toBe(201);
    const recordingId = upload.body.recording.id as string;

    // Owner sees it in their list and can GET it directly.
    const list = await request(ctx.app).get("/studio/recordings").set("Authorization", bearer);
    expect(list.status).toBe(200);
    expect(list.body.recordings).toHaveLength(1);
    expect(list.body.recordings[0].id).toBe(recordingId);

    const get = await request(ctx.app)
      .get(`/studio/recordings/${recordingId}`)
      .set("Authorization", bearer);
    expect(get.status).toBe(200);
    expect(get.body.recording.id).toBe(recordingId);

    // Stranger's list is empty and a direct GET of the owner's recording 404s.
    const strangerList = await request(ctx.app)
      .get("/studio/recordings")
      .set("Authorization", strangerBearer);
    expect(strangerList.status).toBe(200);
    expect(strangerList.body.recordings).toHaveLength(0);

    const strangerGet = await request(ctx.app)
      .get(`/studio/recordings/${recordingId}`)
      .set("Authorization", strangerBearer);
    expect(strangerGet.status).toBe(404);
  });

  it("file routes 404 until status done, then stream", async () => {
    const upload = await request(ctx.app)
      .post("/studio/recordings")
      .set("Authorization", bearer)
      .attach("file", Buffer.from("fake-mp3-bytes"), "mine.mp3");
    const recordingId = upload.body.recording.id as string;
    const userId = upload.body.recording.userId as string;

    const beforeDone = await request(ctx.app)
      .get(`/studio/recordings/${recordingId}/enhanced.m4a`)
      .set("Authorization", bearer);
    expect(beforeDone.status).toBe(404);

    const dir = recordingDir(ctx.uploadDir, userId, recordingId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "enhanced.m4a"), "fake-enhanced-audio");
    await writeFile(join(dir, "waveform.png"), "fake-waveform-bytes");
    await ctx.recordings.setStatus(recordingId, "done");

    const enhanced = await request(ctx.app)
      .get(`/studio/recordings/${recordingId}/enhanced.m4a`)
      .set("Authorization", bearer)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(enhanced.status).toBe(200);
    expect((enhanced.body as Buffer).toString()).toBe("fake-enhanced-audio");

    const waveform = await request(ctx.app)
      .get(`/studio/recordings/${recordingId}/waveform.png`)
      .set("Authorization", bearer)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(waveform.status).toBe(200);
    expect((waveform.body as Buffer).toString()).toBe("fake-waveform-bytes");
  });

  it("delete removes row and directory", async () => {
    const upload = await request(ctx.app)
      .post("/studio/recordings")
      .set("Authorization", bearer)
      .attach("file", Buffer.from("fake-mp3-bytes"), "mine.mp3");
    const recordingId = upload.body.recording.id as string;
    const userId = upload.body.recording.userId as string;
    const dir = recordingDir(ctx.uploadDir, userId, recordingId);
    await expect(stat(dir)).resolves.toBeTruthy();

    const del = await request(ctx.app)
      .delete(`/studio/recordings/${recordingId}`)
      .set("Authorization", bearer);
    expect(del.status).toBe(204);

    expect(ctx.recordings.recordings).toHaveLength(0);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("rejects an upload that would exceed the per-user quota with 507; tmp is cleaned", async () => {
    // Tiny injected quota so the test doesn't write gigabytes.
    const small = await makeApp({ userQuotaBytes: 1000 });
    const smallBearer = await signupAndLogin(small.app, small.store, "quotauser");

    const first = await request(small.app)
      .post("/studio/recordings")
      .set("Authorization", smallBearer)
      .attach("file", Buffer.alloc(600, 1), "one.mp3");
    expect(first.status).toBe(201);

    const second = await request(small.app)
      .post("/studio/recordings")
      .set("Authorization", smallBearer)
      .attach("file", Buffer.alloc(600, 1), "two.mp3");
    expect(second.status).toBe(507);
    expect(second.body.error).toBe("storage full — burn old recordings to free space");
    // no second row, no leaked tmp file
    expect(small.recordings.recordings).toHaveLength(1);
    const leftovers = await readdir(join(small.uploadDir, "tmp"));
    expect(leftovers).toHaveLength(0);
  });

  it("a non-UUID recording id 404s without touching the store", async () => {
    // Mimic the Supabase store, which throws when the id can't cast to uuid.
    ctx.recordings.get = async () => {
      throw new Error("invalid input syntax for type uuid");
    };
    const res = await request(ctx.app)
      .get("/studio/recordings/not-a-uuid")
      .set("Authorization", bearer);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not found");
  });
});
