import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerLink, ICE_SERVERS } from "@/lib/webrtc/peer";

class FakePC {
  static lastConfig: RTCConfiguration | undefined;
  onnegotiationneeded: unknown = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor(config?: RTCConfiguration) {
    FakePC.lastConfig = config;
  }
  createDataChannel() {
    return { onopen: null } as unknown as RTCDataChannel;
  }
  addTrack() {}
  getSenders() {
    return [];
  }
  close() {}
}

vi.stubGlobal("RTCPeerConnection", FakePC);
afterEach(() => {
  FakePC.lastConfig = undefined;
});

const noop = () => {};
const stream = { getTracks: () => [] } as unknown as MediaStream;
const base = { polite: true, localStream: stream, sendSignal: noop, onRemoteStream: noop };

describe("PeerLink ICE configuration", () => {
  it("defaults to the built-in STUN list", () => {
    new PeerLink(base);
    expect(FakePC.lastConfig).toEqual({ iceServers: ICE_SERVERS });
    expect(Object.hasOwn(FakePC.lastConfig!, "iceTransportPolicy")).toBe(false);
  });

  it("uses injected ice servers when provided", () => {
    const ice = [{ urls: "turn:turn.example.com:3478", username: "9", credential: "m" }];
    new PeerLink({ ...base, iceServers: ice });
    expect(FakePC.lastConfig?.iceServers).toEqual(ice);
  });

  it("forceRelay sets iceTransportPolicy relay", () => {
    new PeerLink({ ...base, forceRelay: true });
    expect(FakePC.lastConfig?.iceTransportPolicy).toBe("relay");
  });

  it("no forceRelay → no iceTransportPolicy key", () => {
    new PeerLink(base);
    expect(Object.hasOwn(FakePC.lastConfig!, "iceTransportPolicy")).toBe(false);
  });
});
