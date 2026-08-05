// 8/5 drill defect: after a camera unplug, the local stream keeps an ENDED
// video track. A rebuilt PeerLink must not hand that track to the pc — the
// dead sender's m-line/transform/codec-pin path can throw and destroy the
// whole link, audio included (the one-way-audio incident). And a failed
// negotiation must surface as connectionState "failed" so the mesh's
// restart/rebuild ladder engages instead of wedging in "connecting".
import { describe, expect, it, vi } from "vitest";
import { PeerLink } from "@/lib/webrtc/peer";

function makeFakePC(overrides: Partial<Record<string, unknown>> = {}) {
  class FakePC {
    static lastInstance: InstanceType<typeof FakePC> | undefined;
    onnegotiationneeded: (() => Promise<void>) | null = null;
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    addTrack = vi.fn();
    restartIce = vi.fn();
    localDescription = null;
    setLocalDescription = vi.fn(async () => {});
    createDataChannel() {
      return { onopen: null } as unknown as RTCDataChannel;
    }
    getSenders() {
      return [];
    }
    close() {}
    constructor() {
      Object.assign(this, overrides);
      FakePC.lastInstance = this;
    }
  }
  vi.stubGlobal("RTCPeerConnection", FakePC);
  return FakePC;
}

const noop = () => {};

function streamWith(tracks: Array<{ kind: string; readyState: string }>): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

describe("PeerLink with a dead local track", () => {
  it("skips an ended video track but still adds the live audio track", () => {
    const FakePC = makeFakePC();
    const audio = { kind: "audio", readyState: "live" };
    const video = { kind: "video", readyState: "ended" };
    new PeerLink({
      polite: true,
      localStream: streamWith([audio, video]),
      sendSignal: noop,
      onRemoteStream: noop,
    });
    const pc = FakePC.lastInstance!;
    expect(pc.addTrack).toHaveBeenCalledTimes(1);
    expect(pc.addTrack.mock.calls[0][0]).toBe(audio);
    vi.unstubAllGlobals();
  });

  it("reports a failed negotiation as connectionState 'failed' (never a silent wedge)", async () => {
    const FakePC = makeFakePC({
      setLocalDescription: vi.fn(async () => {
        throw new Error("sLD refused");
      }),
    });
    const onConnectionState = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    new PeerLink({
      polite: true,
      localStream: streamWith([]),
      sendSignal: noop,
      onRemoteStream: noop,
      onConnectionState,
    });
    const pc = FakePC.lastInstance!;
    await pc.onnegotiationneeded!();
    expect(onConnectionState).toHaveBeenCalledWith("failed");
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
