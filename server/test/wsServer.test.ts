import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../src/http/app.js";
import { FileTokenStore } from "../src/tokens/fileStore.js";
import { attachSignaling, type Signaling } from "../src/ws/attach.js";
import { FakeAccountStore, FakeRecordingStore } from "./fakes.js";

const ORIGIN = "http://localhost:3000";
const ROOM = "R".repeat(22);

let httpServer: Server;
let signaling: Signaling;
let url: string;
let token: string;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "cos-ws-"));
  const store = await FileTokenStore.open(join(dir, "tokens.json"));
  token = (await store.mint("ws-test")).token;
  const uploadDir = await mkdtemp(join(tmpdir(), "cos-ws-uploads-"));
  const app = createApp({
    store,
    accounts: new FakeAccountStore(),
    adminSecret: "s".repeat(32),
    allowedOrigins: [ORIGIN],
    recordings: new FakeRecordingStore(),
    uploadDir,
    runner: { kick() {} },
  });
  httpServer = createServer(app);
  signaling = attachSignaling(httpServer, { store, allowedOrigins: [ORIGIN] });
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  signaling.stop();
  await new Promise((r) => httpServer.close(r));
});

function connect(origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { headers: { origin } } : {});
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`upgrade rejected: ${res.statusCode}`)),
    );
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)),
  );
}

async function send(ws: WebSocket, msg: unknown): Promise<Record<string, unknown>> {
  const reply = nextMessage(ws);
  ws.send(JSON.stringify(msg));
  return reply;
}

describe("ws signaling server", () => {
  it("rejects upgrades from a disallowed or missing Origin", async () => {
    await expect(connect("https://evil.example")).rejects.toThrow("403");
    await expect(connect()).rejects.toThrow("403");
  });

  it("rejects upgrades on any path other than /ws", async () => {
    const badPathUrl = url.replace("/ws", "/not-ws");
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(badPathUrl, { headers: { origin: ORIGIN } });
        ws.once("open", () => resolve(ws));
        ws.once("unexpected-response", (_req, res) =>
          reject(new Error(`upgrade rejected: ${res.statusCode}`)),
        );
        ws.once("error", reject);
      }),
    ).rejects.toThrow("403");
  });

  it("full call flow over real sockets: create, join, relay, leave", async () => {
    const a = await connect(ORIGIN);
    const created = await send(a, { v: 1, t: "create", roomId: ROOM, token });
    expect(created.t).toBe("created");

    const b = await connect(ORIGIN);
    const aSeesB = nextMessage(a);
    const joined = await send(b, { v: 1, t: "join", roomId: ROOM });
    expect(joined).toMatchObject({ t: "joined", peers: [{ peerId: created.selfId }] });
    expect((await aSeesB).t).toBe("peer-joined");

    const relayed = nextMessage(a);
    b.send(JSON.stringify({ v: 1, t: "relay", to: created.selfId, payload: "opaque-sdp" }));
    expect(await relayed).toMatchObject({ t: "relay", from: joined.selfId, payload: "opaque-sdp" });

    const left = nextMessage(a);
    b.close();
    expect(await left).toMatchObject({ t: "peer-left", peerId: joined.selfId });
    a.close();
  });

  it("join of an unknown room is refused; create with a bad token is refused", async () => {
    const w = await connect(ORIGIN);
    const notFound = await send(w, { v: 1, t: "join", roomId: "X".repeat(22) });
    expect(notFound).toMatchObject({ t: "error", reason: "room-not-found" });
    const refused = await send(w, { v: 1, t: "create", roomId: "X".repeat(22), token: "x".repeat(22) });
    expect(refused).toMatchObject({ t: "error", reason: "create-refused" });
    w.close();
  });

  it("a third joiner is politely refused", async () => {
    const a = await connect(ORIGIN);
    await send(a, { v: 1, t: "create", roomId: ROOM, token });
    const b = await connect(ORIGIN);
    await send(b, { v: 1, t: "join", roomId: ROOM });
    const c = await connect(ORIGIN);
    const full = await send(c, { v: 1, t: "join", roomId: ROOM });
    expect(full).toMatchObject({ t: "error", reason: "room-full" });
    for (const ws of [a, b, c]) ws.close();
  });
});
