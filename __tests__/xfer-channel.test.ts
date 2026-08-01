import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerLink, XFER_LOW_WATER } from "@/lib/webrtc/peer";

class FakeChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  bufferedAmountLowThreshold = 0;
  bufferedAmount = 0;
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  sent: unknown[] = [];
  constructor(public label: string, public init?: RTCDataChannelInit) {}
  send(data: unknown) { this.sent.push(data); }
}

class FakePC {
  static lastInstance: FakePC | undefined;
  channels: FakeChannel[] = [];
  onnegotiationneeded: unknown = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor() { FakePC.lastInstance = this; }
  createDataChannel(label: string, init?: RTCDataChannelInit) {
    const ch = new FakeChannel(label, init);
    this.channels.push(ch);
    return ch as unknown as RTCDataChannel;
  }
  addTrack() {}
  getSenders() { return []; }
  close() {}
}
vi.stubGlobal("RTCPeerConnection", FakePC);
afterEach(() => { FakePC.lastInstance = undefined; });

const noop = () => {};
const stream = { getTracks: () => [] } as unknown as MediaStream;
function make(events: Partial<{
  onChannelState: (c: string, s: string, d?: string) => void;
  onXferMessage: (data: string | ArrayBuffer) => void;
  onXferDrain: () => void;
}> = {}) {
  const link = new PeerLink({
    polite: true, localStream: stream, sendSignal: noop, onRemoteStream: noop, ...events,
  });
  const pc = FakePC.lastInstance!;
  const cos = pc.channels.find((c) => c.label === "cos")!;
  const xfer = pc.channels.find((c) => c.label === "cos-xfer")!;
  return { link, cos, xfer };
}

describe("cos-xfer channel", () => {
  it("constructs cos-xfer negotiated id 1 with arraybuffer binaryType and the low-water threshold", () => {
    const { xfer } = make();
    expect(xfer.init).toEqual({ negotiated: true, id: 1 });
    expect(xfer.binaryType).toBe("arraybuffer");
    expect(xfer.bufferedAmountLowThreshold).toBe(XFER_LOW_WATER);
  });

  it("fires per-channel open/close/error for BOTH channels", () => {
    const events: [string, string][] = [];
    const { cos, xfer } = make({ onChannelState: (c, s) => events.push([c, s]) });
    cos.onopen!(); xfer.onopen!(); xfer.onerror!({ error: { message: "sctp reset" } }); xfer.onclose!(); cos.onclose!();
    expect(events).toEqual([
      ["cos", "open"], ["xfer", "open"], ["xfer", "error"], ["xfer", "closed"], ["cos", "closed"],
    ]);
  });

  it("legacy onChannelOpen still fires on cos open (5A hello contract untouched)", () => {
    let opened = 0;
    const link = new PeerLink({
      polite: true, localStream: stream, sendSignal: noop, onRemoteStream: noop,
      onChannelOpen: () => { opened += 1; },
    });
    void link;
    FakePC.lastInstance!.channels.find((c) => c.label === "cos")!.onopen!();
    expect(opened).toBe(1);
  });

  it("sendXfer refuses (not queues) unless open; routes string and binary in", () => {
    const inbound: (string | ArrayBuffer)[] = [];
    const { link, xfer } = make({ onXferMessage: (d) => inbound.push(d) });
    expect(link.sendXfer("x")).toBe(false);
    xfer.readyState = "open";
    const buf = new ArrayBuffer(8);
    expect(link.sendXfer("x")).toBe(true);
    expect(link.sendXfer(buf)).toBe(true);
    expect(xfer.sent).toEqual(["x", buf]);
    xfer.onmessage!({ data: "hello" });
    xfer.onmessage!({ data: buf });
    expect(inbound).toEqual(["hello", buf]);
  });

  it("xferBufferedAmount mirrors the channel and onXferDrain rides bufferedamountlow", () => {
    let drains = 0;
    const { link, xfer } = make({ onXferDrain: () => { drains += 1; } });
    xfer.bufferedAmount = 12345;
    expect(link.xferBufferedAmount()).toBe(12345);
    xfer.onbufferedamountlow!();
    expect(drains).toBe(1);
  });
});
