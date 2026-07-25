import { describe, expect, it } from "vitest";
import {
  MAX_RELAY_PAYLOAD_CHARS,
  parseClientMessage,
  parseServerMessage,
} from "../../lib/webrtc/protocol.js";

const ROOM = "R".repeat(22);
const TOKEN = "t".repeat(22);
const PEER = "p".repeat(8);

describe("parseClientMessage", () => {
  it("accepts each well-formed client message", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "create", roomId: ROOM, token: TOKEN })))
      .toEqual({ v: 1, t: "create", roomId: ROOM, token: TOKEN });
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "join", roomId: ROOM })))
      .toEqual({ v: 1, t: "join", roomId: ROOM });
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "relay", to: PEER, payload: "opaque" })))
      .toEqual({ v: 1, t: "relay", to: PEER, payload: "opaque" });
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "leave" }))).toEqual({ v: 1, t: "leave" });
  });

  it("rejects garbage, wrong version, unknown type, malformed ids", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 2, t: "join", roomId: ROOM }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "steal" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "join", roomId: "short" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "create", roomId: ROOM, token: "x" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "relay", to: "nope", payload: "p" }))).toBeNull();
  });

  it("rejects relay payloads over the cap", () => {
    const fat = "x".repeat(MAX_RELAY_PAYLOAD_CHARS + 1);
    expect(parseClientMessage(JSON.stringify({ v: 1, t: "relay", to: PEER, payload: fat }))).toBeNull();
  });
});

describe("parseServerMessage", () => {
  it("accepts each well-formed server message", () => {
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "created", selfId: PEER })))
      .toEqual({ v: 1, t: "created", selfId: PEER });
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "joined", selfId: PEER, peers: [{ peerId: PEER }] })))
      .toEqual({ v: 1, t: "joined", selfId: PEER, peers: [{ peerId: PEER }] });
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "peer-joined", peerId: PEER })))
      .toEqual({ v: 1, t: "peer-joined", peerId: PEER });
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "peer-left", peerId: PEER })))
      .toEqual({ v: 1, t: "peer-left", peerId: PEER });
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "relay", from: PEER, payload: "sdp" })))
      .toEqual({ v: 1, t: "relay", from: PEER, payload: "sdp" });
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "error", reason: "room-full", message: "m" })))
      .toEqual({ v: 1, t: "error", reason: "room-full", message: "m" });
  });

  it("rejects garbage and malformed rosters", () => {
    expect(parseServerMessage("{}")).toBeNull();
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "joined", selfId: PEER, peers: [{ peerId: 7 }] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "error", reason: "made-up", message: "m" }))).toBeNull();
  });
});

describe("ice field on created/joined", () => {
  const ICE = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: ["turn:turn.example.com:3478?transport=udp"], username: "123", credential: "abc" },
  ];

  it("parses created with a valid ice list", () => {
    const raw = JSON.stringify({ v: 1, t: "created", selfId: "s", ice: ICE });
    expect(parseServerMessage(raw)).toEqual({ v: 1, t: "created", selfId: "s", ice: ICE });
  });

  it("parses joined with a valid ice list", () => {
    const raw = JSON.stringify({ v: 1, t: "joined", selfId: "s", peers: [], ice: ICE });
    expect(parseServerMessage(raw)).toEqual({ v: 1, t: "joined", selfId: "s", peers: [], ice: ICE });
  });

  it("created/joined without ice still parse (additive field)", () => {
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "created", selfId: "s" })))
      .toEqual({ v: 1, t: "created", selfId: "s" });
    expect(parseServerMessage(JSON.stringify({ v: 1, t: "joined", selfId: "s", peers: [] })))
      .toEqual({ v: 1, t: "joined", selfId: "s", peers: [] });
  });

  it("rejects malformed ice shapes", () => {
    const bad = [
      { v: 1, t: "created", selfId: "s", ice: "not-an-array" },
      { v: 1, t: "created", selfId: "s", ice: [{ urls: 42 }] },
      { v: 1, t: "created", selfId: "s", ice: [{ urls: [] }] },
      { v: 1, t: "created", selfId: "s", ice: [{ urls: "turn:x", username: 7 }] },
      { v: 1, t: "created", selfId: "s", ice: [null] },
    ];
    for (const msg of bad) expect(parseServerMessage(JSON.stringify(msg))).toBeNull();
  });
});
