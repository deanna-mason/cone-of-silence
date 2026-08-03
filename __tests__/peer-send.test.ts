// __tests__/peer-send.test.ts
// PeerLink.send / sendXfer throw-safety (Phase 6 carry-forward, ledgered in
// 5D final review): RTCDataChannel.send can throw even after a readyState
// check passes — the channel can flip open -> closing between the check and
// the send (both are the same synchronous task only in the happy path; the
// closing transition is driven by the transport, not by us). A throw here
// propagates into callers that were promised a boolean — most damningly
// joinProof.issueChallenge, which calls onSend() BEFORE arming its timeout:
// on the retry path (retried=true, timeoutId=null) an escaping throw strands
// the proof `pending` forever, silently. The contract is "false (not
// queued)" — a send the transport refused must report false, never throw.
// Fake-platform idiom — same shape as __tests__/e2ee-peer.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerLink } from "@/lib/webrtc/peer";

class FakeChannel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  onbufferedamountlow: unknown = null;
  send = vi.fn();
}

class FakePC {
  static lastInstance: FakePC | undefined;
  channels = new Map<string, FakeChannel>();
  onnegotiationneeded: unknown = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor() {
    FakePC.lastInstance = this;
  }
  createDataChannel(name: string) {
    const ch = new FakeChannel();
    this.channels.set(name, ch);
    return ch as unknown as RTCDataChannel;
  }
  addTrack() {
    return {} as RTCRtpSender;
  }
  getSenders() {
    return [];
  }
  getTransceivers() {
    return [];
  }
  close() {}
}

const noop = () => {};
const base = {
  polite: true,
  localStream: { getTracks: () => [] } as unknown as MediaStream,
  sendSignal: noop,
  onRemoteStream: noop,
};

function closingRaceThrow(): never {
  // What Chrome actually throws when the transport closed under the send.
  throw new DOMException("RTCDataChannel.readyState is not 'open'", "InvalidStateError");
}

beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", FakePC);
});

afterEach(() => {
  FakePC.lastInstance = undefined;
  vi.unstubAllGlobals();
});

describe("PeerLink.send throw-safety", () => {
  it("returns false, not a throw, when channel.send throws under an open readyState", () => {
    const link = new PeerLink(base);
    const cos = FakePC.lastInstance!.channels.get("cos")!;
    cos.send.mockImplementation(closingRaceThrow);
    let result: boolean | undefined;
    expect(() => {
      result = link.send("proof-challenge");
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("still returns true and delivers when the send succeeds", () => {
    const link = new PeerLink(base);
    const cos = FakePC.lastInstance!.channels.get("cos")!;
    expect(link.send("hello")).toBe(true);
    expect(cos.send).toHaveBeenCalledWith("hello");
  });

  it("still returns false without sending when the channel is not open", () => {
    const link = new PeerLink(base);
    const cos = FakePC.lastInstance!.channels.get("cos")!;
    cos.readyState = "closing";
    expect(link.send("late")).toBe(false);
    expect(cos.send).not.toHaveBeenCalled();
  });
});

describe("PeerLink.sendXfer throw-safety", () => {
  it("returns false, not a throw, when xfer.send throws under an open readyState", () => {
    const link = new PeerLink(base);
    const xfer = FakePC.lastInstance!.channels.get("cos-xfer")!;
    xfer.send.mockImplementation(closingRaceThrow);
    let result: boolean | undefined;
    expect(() => {
      result = link.sendXfer(new ArrayBuffer(8));
    }).not.toThrow();
    // False IS the park signal — the exchange engine treats a refused send
    // as the channel dying under it, which is exactly right for this race.
    expect(result).toBe(false);
  });

  it("still returns true and delivers when the send succeeds", () => {
    const link = new PeerLink(base);
    const xfer = FakePC.lastInstance!.channels.get("cos-xfer")!;
    expect(link.sendXfer("frame")).toBe(true);
    expect(xfer.send).toHaveBeenCalledWith("frame");
  });
});
