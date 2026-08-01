// Phase 5B Task 2: per-link, per-channel bookkeeping + xfer routing in the
// Mesh. Extends the FakeLink/harness idiom from dc-messages.test.ts (per-peer
// routing, stale-link identity guard) and the recovery-test idiom from
// mesh.test.ts (fake timers, RESTART_RECOVERY_MS) — this is where the two
// idioms meet: a Phase-4C rebuild must report cos-xfer honestly, since a
// later transfer protocol's parking contract depends on it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Mesh,
  RESTART_RECOVERY_MS,
  type ChannelLifecycle,
  type ChannelName,
  type LinkEvents,
  type MeshLink,
} from "@/lib/webrtc/mesh";

class FakeLink implements MeshLink {
  handleSignal = vi.fn(async (_payload: string) => {});
  replaceStream = vi.fn(async (_stream: MediaStream) => {});
  restartIce = vi.fn();
  close = vi.fn();
  send = vi.fn(() => true);
  sendXfer = vi.fn(() => true);
  xferBufferedAmount = vi.fn(() => 0);
}

interface Made {
  peerId: string;
  events: LinkEvents;
  link: FakeLink;
}

function harness() {
  const made: Made[] = [];
  const channelStates: [string, string, string][] = [];
  const xferMessages: [string, string | ArrayBuffer][] = [];
  const xferDrains: string[] = [];
  const cb = {
    onRoster: vi.fn(),
    onChannelOpen: vi.fn(),
    onChannelClosed: vi.fn(),
    onMessage: vi.fn(),
    onChannelState: vi.fn((peerId: string, channel: ChannelName, state: ChannelLifecycle, _detail?: string) => {
      channelStates.push([peerId, channel, state]);
    }),
    onXferMessage: vi.fn((peerId: string, data: string | ArrayBuffer) => {
      xferMessages.push([peerId, data]);
    }),
    onXferDrain: vi.fn((peerId: string) => {
      xferDrains.push(peerId);
    }),
  };
  const mesh = new Mesh((peerId, _polite, events) => {
    const link = new FakeLink();
    made.push({ peerId, events, link });
    return link;
  }, cb);
  return { mesh, made, cb, channelStates, xferMessages, xferDrains };
}

function settle() {
  vi.runAllTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Mesh per-channel bookkeeping (Phase 5B Task 2)", () => {
  it("(a) cos open fires the aggregate exactly as today; opening xfer alone does not — both are recorded per peer", () => {
    const { mesh, made, cb, channelStates } = harness();
    mesh.addNewcomer("p1");
    settle();

    made[0].events.onChannelState("xfer", "open");
    expect(cb.onChannelOpen).not.toHaveBeenCalled();

    made[0].events.onChannelState("cos", "open");
    expect(cb.onChannelOpen).toHaveBeenCalledOnce();

    expect(channelStates).toEqual([
      ["p1", "xfer", "open"],
      ["p1", "cos", "open"],
    ]);
  });

  it("(b) sendXferTo hits exactly that peer's link; false for unknown/linkless; xferBufferedAmount('ghost') is -1", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    mesh.addNewcomer("p2");
    settle();

    expect(mesh.sendXferTo("p2", "hi")).toBe(true);
    expect(made.find((m) => m.peerId === "p2")!.link.sendXfer).toHaveBeenCalledWith("hi");
    expect(made.find((m) => m.peerId === "p1")!.link.sendXfer).not.toHaveBeenCalled();

    expect(mesh.sendXferTo("ghost", "hi")).toBe(false);
    expect(mesh.xferBufferedAmount("ghost")).toBe(-1);
  });

  it("(b) sendXferTo/xferBufferedAmount are false/-1 for a peer whose link is not yet constructed", () => {
    const { mesh } = harness();
    mesh.addNewcomer("p1"); // still staggered — no link yet
    expect(mesh.sendXferTo("p1", "hi")).toBe(false);
    expect(mesh.xferBufferedAmount("p1")).toBe(-1);
  });

  it("(b) xferBufferedAmount mirrors the peer's link", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].link.xferBufferedAmount.mockReturnValue(4096);
    expect(mesh.xferBufferedAmount("p1")).toBe(4096);
  });

  it("(c) onXferMessage/onXferDrain route with peerId", () => {
    const { mesh, made, xferMessages, xferDrains } = harness();
    mesh.addNewcomer("p1");
    settle();

    const buf = new ArrayBuffer(4);
    made[0].events.onXferMessage("hello");
    made[0].events.onXferMessage(buf);
    made[0].events.onXferDrain();

    expect(xferMessages).toEqual([
      ["p1", "hello"],
      ["p1", buf],
    ]);
    expect(xferDrains).toEqual(["p1"]);
  });

  it("(c) stale-link onXferMessage/onXferDrain are ignored after the peer is removed and re-added", () => {
    // Mirrors dc-messages.test.ts's stale-link shape: capture events from the
    // FIRST link, remove the peer, re-add, then fire the stale callbacks.
    const { mesh, made, xferMessages, xferDrains } = harness();
    mesh.addNewcomer("p1");
    settle();
    const stale = made[0].events;
    mesh.remove("p1");
    mesh.addNewcomer("p1");
    settle();

    stale.onXferMessage("old");
    stale.onXferDrain();

    expect(xferMessages).toEqual([]);
    expect(xferDrains).toEqual([]);
  });

  it("a Phase-4C link rebuild reports cos-xfer closed for that link — the parked-transfer contract", () => {
    const { mesh, made, cb, channelStates } = harness();
    mesh.addNewcomer("p1");
    settle();

    made[0].events.onChannelState("cos", "open");
    made[0].events.onChannelState("xfer", "open");
    expect(cb.onChannelOpen).toHaveBeenCalledOnce();

    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // fallback fires -> rebuildLink

    expect(channelStates).toContainEqual(["p1", "xfer", "closed"]);
    expect(channelStates).toContainEqual(["p1", "cos", "closed"]);
    expect(cb.onChannelClosed).toHaveBeenCalledOnce(); // cos was the only open cos-channel
  });

  it("(e) remove(p1) synthesizes closed events for both open channels", () => {
    const { mesh, made, cb, channelStates } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onChannelState("cos", "open");
    made[0].events.onChannelState("xfer", "open");
    channelStates.length = 0; // isolate the teardown synth events

    mesh.remove("p1");

    expect(channelStates).toHaveLength(2);
    expect(channelStates).toEqual(
      expect.arrayContaining([
        ["p1", "cos", "closed"],
        ["p1", "xfer", "closed"],
      ]),
    );
    expect(cb.onChannelClosed).toHaveBeenCalledOnce();
  });

  it("(e) closeAll synthesizes closed events for both open channels, per peer", () => {
    const { mesh, made, cb, channelStates } = harness();
    mesh.addNewcomer("p1");
    mesh.addNewcomer("p2");
    settle();
    made[0].events.onChannelState("cos", "open");
    made[0].events.onChannelState("xfer", "open");
    made[1].events.onChannelState("cos", "open");
    channelStates.length = 0;

    mesh.closeAll();

    expect(channelStates).toHaveLength(3);
    expect(channelStates).toEqual(
      expect.arrayContaining([
        ["p1", "cos", "closed"],
        ["p1", "xfer", "closed"],
        ["p2", "cos", "closed"],
      ]),
    );
    expect(cb.onChannelClosed).toHaveBeenCalledOnce();
  });

  it("(f) a straggling xfer-closed event from the old (rebuilt-away) link does not double-fire", () => {
    const { mesh, made, cb, channelStates } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onChannelState("cos", "open");
    made[0].events.onChannelState("xfer", "open");
    const stale = made[0].events;

    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // rebuildLink synthesizes closes, entry.link -> null

    const statesAfterRebuild = channelStates.length;
    const closedCallsAfterRebuild = cb.onChannelClosed.mock.calls.length;

    stale.onChannelState("xfer", "closed"); // the discarded old link's straggling real close

    expect(channelStates.length).toBe(statesAfterRebuild); // identity guard ate it
    expect(cb.onChannelClosed.mock.calls.length).toBe(closedCallsAfterRebuild); // no extra aggregate fire
  });
});
