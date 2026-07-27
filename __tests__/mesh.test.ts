import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, STAGGER_MS, type LinkEvents, type MeshLink, type RemotePeer } from "@/lib/webrtc/mesh";

class FakeLink implements MeshLink {
  handleSignal = vi.fn(async (_payload: string) => {});
  replaceStream = vi.fn(async (_stream: MediaStream) => {});
  close = vi.fn();
}

interface Made {
  peerId: string;
  polite: boolean;
  events: LinkEvents;
  link: FakeLink;
}

function harness() {
  const made: Made[] = [];
  const rosters: RemotePeer[][] = [];
  const cb = {
    onRoster: vi.fn((r: RemotePeer[]) => rosters.push(r)),
    onChannelOpen: vi.fn(),
    onChannelClosed: vi.fn(),
  };
  const mesh = new Mesh((peerId, polite, events) => {
    const link = new FakeLink();
    made.push({ peerId, polite, events, link });
    return link;
  }, cb);
  return { mesh, made, cb, rosters };
}

/** Links after the first are constructed on a stagger — let them all land. */
function settle() {
  vi.runAllTimers();
}

const fakeStream = {} as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Mesh politeness", () => {
  it("addExistingPeers: we are the newcomer — polite toward every incumbent", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    settle();
    expect(made.map((m) => [m.peerId, m.polite])).toEqual([
      ["p1", true],
      ["p2", true],
      ["p3", true],
    ]);
    expect(mesh.size).toBe(3);
  });

  it("addNewcomer: they are the newcomer — we are impolite", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p9");
    expect(made).toHaveLength(1); // single link — never deferred
    expect(made[0].polite).toBe(false);
  });

  it("a duplicate newcomer announce is ignored", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p9");
    mesh.addNewcomer("p9");
    settle();
    expect(made).toHaveLength(1);
    expect(mesh.size).toBe(1);
  });
});

describe("Mesh staggered bring-up", () => {
  it("builds no link in the caller's tick, then one per stagger in peer order", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    expect(made).toHaveLength(0); // never inside the signaling handler's own tick

    vi.advanceTimersByTime(STAGGER_MS - 1);
    expect(made).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(made.map((m) => m.peerId)).toEqual(["p1"]);

    vi.advanceTimersByTime(STAGGER_MS);
    expect(made.map((m) => m.peerId)).toEqual(["p1", "p2"]);

    vi.advanceTimersByTime(STAGGER_MS);
    expect(made.map((m) => m.peerId)).toEqual(["p1", "p2", "p3"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("every peer is in the roster immediately, before its link exists", () => {
    const { mesh, rosters } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    expect(mesh.size).toBe(3);
    expect(rosters.at(-1)).toEqual([
      { peerId: "p1", stream: null, connectionState: "new" },
      { peerId: "p2", stream: null, connectionState: "new" },
      { peerId: "p3", stream: null, connectionState: "new" },
    ]);
  });

  it("addNewcomer is immediate — one new pc per tick already", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    expect(made).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Mesh pending-signal buffering", () => {
  it("queues signals for a peer whose link is not built yet, draining in arrival order", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    mesh.relay("p2", "sig-1");
    mesh.relay("p2", "sig-2");
    expect(made).toHaveLength(0); // p2's link still pending

    settle();
    expect(made[1].peerId).toBe("p2");
    expect(made[1].link.handleSignal.mock.calls.map((c) => c[0])).toEqual(["sig-1", "sig-2"]);
  });

  it("routes straight through once the link exists", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    mesh.relay("p2", "payload-x");
    expect(made[1].link.handleSignal).toHaveBeenCalledWith("payload-x");
    expect(made[0].link.handleSignal).not.toHaveBeenCalled();
  });

  it("swallows rejections raised while draining the queue", () => {
    const rejecting = new Mesh(
      () => ({
        handleSignal: vi.fn(async () => {
          throw new Error("straggler ICE");
        }),
        replaceStream: vi.fn(async () => {}),
        close: vi.fn(),
      }),
      { onRoster: vi.fn(), onChannelOpen: vi.fn(), onChannelClosed: vi.fn() },
    );
    rejecting.addExistingPeers(["p1", "p2"]);
    rejecting.relay("p2", "straggler");
    expect(() => settle()).not.toThrow();
  });

  it("discards queued signals if the peer is removed before its link is built", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    mesh.relay("p2", "sig-1");
    mesh.remove("p2");
    settle();
    expect(made.map((m) => m.peerId)).toEqual(["p1"]); // p2's link never constructed
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Mesh roster", () => {
  it("starts each peer with null stream and connectionState new", () => {
    const { mesh, rosters } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    expect(rosters.at(-1)).toEqual([
      { peerId: "p1", stream: null, connectionState: "new" },
      { peerId: "p2", stream: null, connectionState: "new" },
    ]);
  });

  it("onRemoteStream updates only that peer's entry", () => {
    const { mesh, made, rosters } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    made[0].events.onRemoteStream(fakeStream);
    const roster = rosters.at(-1)!;
    expect(roster.find((p) => p.peerId === "p1")?.stream).toBe(fakeStream);
    expect(roster.find((p) => p.peerId === "p2")?.stream).toBeNull();
  });

  it("onConnectionState updates only that peer's entry", () => {
    const { mesh, made, rosters } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    made[1].events.onConnectionState("connected");
    const roster = rosters.at(-1)!;
    expect(roster.find((p) => p.peerId === "p2")?.connectionState).toBe("connected");
    expect(roster.find((p) => p.peerId === "p1")?.connectionState).toBe("new");
  });

  it("remove closes the link and shrinks the roster; unknown remove is a no-op", () => {
    const { mesh, made, cb } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    const emits = cb.onRoster.mock.calls.length;
    mesh.remove("p1");
    expect(made[0].link.close).toHaveBeenCalledOnce();
    expect(mesh.roster().map((p) => p.peerId)).toEqual(["p2"]);
    mesh.remove("ghost");
    expect(cb.onRoster.mock.calls.length).toBe(emits + 1); // only the real remove emitted
  });

  it("events from an already-removed link never resurrect its roster entry", () => {
    const { mesh, made, rosters } = harness();
    mesh.addNewcomer("p1");
    mesh.remove("p1");
    const emits = rosters.length;
    made[0].events.onRemoteStream(fakeStream);
    made[0].events.onConnectionState("connected");
    expect(rosters.length).toBe(emits);
    expect(mesh.size).toBe(0);
  });
});

describe("Mesh relay routing", () => {
  it("routes payloads to the addressed link only", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    mesh.relay("p2", "payload-x");
    expect(made[1].link.handleSignal).toHaveBeenCalledWith("payload-x");
    expect(made[0].link.handleSignal).not.toHaveBeenCalled();
  });

  it("relay from an unknown peer is dropped; handleSignal rejection is swallowed", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    made[0].link.handleSignal.mockRejectedValueOnce(new Error("straggler ICE"));
    expect(() => mesh.relay("stranger", "x")).not.toThrow();
    expect(() => mesh.relay("p1", "y")).not.toThrow();
  });
});

describe("Mesh data-channel aggregation", () => {
  it("fires onChannelOpen only on the 0→1 transition", () => {
    const { mesh, made, cb } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    made[0].events.onChannelOpen();
    made[1].events.onChannelOpen();
    expect(cb.onChannelOpen).toHaveBeenCalledOnce();
  });

  it("fires onChannelClosed only when the last open channel goes away", () => {
    const { mesh, made, cb } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    made[0].events.onChannelOpen();
    made[1].events.onChannelOpen();
    mesh.remove("p1");
    expect(cb.onChannelClosed).not.toHaveBeenCalled();
    mesh.remove("p2");
    expect(cb.onChannelClosed).toHaveBeenCalledOnce();
  });

  it("closeAll closes every link, empties the roster, and closes the channel state", () => {
    const { mesh, made, cb, rosters } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    settle();
    made[0].events.onChannelOpen();
    mesh.closeAll();
    for (const m of made) expect(m.link.close).toHaveBeenCalledOnce();
    expect(rosters.at(-1)).toEqual([]);
    expect(cb.onChannelClosed).toHaveBeenCalledOnce();
    expect(mesh.size).toBe(0);
  });

  it("closeAll cancels pending construction — no link is ever built afterwards", () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    mesh.closeAll();
    expect(vi.getTimerCount()).toBe(0); // no leaked timers
    settle();
    expect(made).toHaveLength(0);
    expect(mesh.size).toBe(0);
  });
});

describe("Mesh device switch", () => {
  it("replaceStreamAll fans the new stream out to every link", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    settle();
    await mesh.replaceStreamAll(fakeStream);
    for (const m of made) expect(m.link.replaceStream).toHaveBeenCalledWith(fakeStream);
  });

  it("replaceStreamAll skips peers whose link is not constructed yet", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2", "p3"]);
    vi.advanceTimersByTime(STAGGER_MS); // only p1's link is up
    expect(made).toHaveLength(1);
    await expect(mesh.replaceStreamAll(fakeStream)).resolves.toBeUndefined();
    expect(made[0].link.replaceStream).toHaveBeenCalledWith(fakeStream);
    settle();
    // The deferred links pick the current stream up from the factory instead.
    expect(made).toHaveLength(3);
    expect(made[1].link.replaceStream).not.toHaveBeenCalled();
    expect(made[2].link.replaceStream).not.toHaveBeenCalled();
  });
});
