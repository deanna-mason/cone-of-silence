import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Mesh,
  STAGGER_MS,
  DISCONNECTED_RESTART_MS,
  RESTART_RECOVERY_MS,
  MAX_LINK_REBUILDS,
  MAX_PENDING_SIGNALS,
  type LinkEvents,
  type MeshLink,
  type RemotePeer,
} from "@/lib/webrtc/mesh";

class FakeLink implements MeshLink {
  handleSignal = vi.fn(async (_payload: string) => {});
  replaceStream = vi.fn(async (_stream: MediaStream) => {});
  close = vi.fn();
  restartIce = vi.fn();
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

/** A link whose handleSignal stays in flight until the test releases it. */
class DeferredLink implements MeshLink {
  /** Payloads in the order handleSignal was actually invoked with them. */
  readonly started: string[] = [];
  private readonly settlers: Array<(reject?: boolean) => void> = [];
  handleSignal = vi.fn((payload: string) => {
    this.started.push(payload);
    return new Promise<void>((resolve, reject) => {
      this.settlers.push((rejectIt) => (rejectIt ? reject(new Error("straggler ICE")) : resolve()));
    });
  });
  replaceStream = vi.fn(async (_stream: MediaStream) => {});
  close = vi.fn();
  /** Settle the oldest in-flight handleSignal. */
  release(reject = false) {
    this.settlers.shift()?.(reject);
  }
}

/** Every link is deferred ((i + 1) * STAGGER_MS) — run the timers so they all land. */
function settle() {
  vi.runAllTimers();
}

/**
 * Signal application is chained on promises, so a payload reaches handleSignal
 * a microtask (or several) after the call that enqueued it.
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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
    settle();
    expect(made).toHaveLength(1);
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

  it("addNewcomer is deferred by STAGGER_MS like every other construction", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    expect(made).toHaveLength(0);
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Mesh pending-signal buffering", () => {
  it("queues signals for a peer whose link is not built yet, draining in arrival order", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    mesh.relay("p2", "sig-1");
    mesh.relay("p2", "sig-2");
    expect(made).toHaveLength(0); // p2's link still pending

    settle();
    await flush();
    expect(made[1].peerId).toBe("p2");
    expect(made[1].link.handleSignal.mock.calls.map((c) => c[0])).toEqual(["sig-1", "sig-2"]);
  });

  it("routes straight through once the link exists", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    mesh.relay("p2", "payload-x");
    await flush();
    expect(made[1].link.handleSignal).toHaveBeenCalledWith("payload-x");
    expect(made[0].link.handleSignal).not.toHaveBeenCalled();
  });

  it("swallows rejections raised while draining the queue", async () => {
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
    await expect(flush()).resolves.toBeUndefined();
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

describe("Mesh signal serialization", () => {
  function deferredHarness() {
    const links: DeferredLink[] = [];
    const cb = { onRoster: vi.fn(), onChannelOpen: vi.fn(), onChannelClosed: vi.fn() };
    const mesh = new Mesh(() => {
      const link = new DeferredLink();
      links.push(link);
      return link;
    }, cb);
    return { mesh, links };
  }

  it("does not start a queued signal until the previous one has settled", async () => {
    const { mesh, links } = deferredHarness();
    mesh.addExistingPeers(["p1"]);
    mesh.relay("p1", "offer");
    mesh.relay("p1", "candidate");

    settle();
    await flush();
    const link = links[0];
    // handleSignal(offer) is still suspended — the candidate must NOT be
    // applied concurrently (it would hit a null remoteDescription).
    expect(link.started).toEqual(["offer"]);

    link.release();
    await flush();
    expect(link.started).toEqual(["offer", "candidate"]);
  });

  it("serializes live relays into a link that already exists", async () => {
    const { mesh, links } = deferredHarness();
    mesh.addNewcomer("p1");
    settle();
    const link = links[0];
    mesh.relay("p1", "one");
    mesh.relay("p1", "two");
    await flush();
    expect(link.started).toEqual(["one"]);

    link.release();
    await flush();
    expect(link.started).toEqual(["one", "two"]);
  });

  it("a live relay arriving mid-drain lands after the drained payloads", async () => {
    const { mesh, links } = deferredHarness();
    mesh.addExistingPeers(["p1"]);
    mesh.relay("p1", "queued-1");
    mesh.relay("p1", "queued-2");

    settle();
    await flush();
    const link = links[0];
    expect(link.started).toEqual(["queued-1"]); // drain in flight

    mesh.relay("p1", "live"); // arrives while queued-1 is still suspended
    await flush();
    expect(link.started).toEqual(["queued-1"]);

    link.release();
    await flush();
    expect(link.started).toEqual(["queued-1", "queued-2"]);

    link.release();
    await flush();
    expect(link.started).toEqual(["queued-1", "queued-2", "live"]);
  });

  it("a rejected payload is swallowed and does not stall the ones behind it", async () => {
    const { mesh, links } = deferredHarness();
    mesh.addNewcomer("p1");
    settle();
    const link = links[0];
    mesh.relay("p1", "bad");
    mesh.relay("p1", "good");
    await flush();

    link.release(true); // "bad" rejects
    await flush();
    expect(link.started).toEqual(["bad", "good"]);
  });
});

describe("Mesh construction failure", () => {
  it("a throwing link factory drops the entry, emits the roster, and leaks no timer", () => {
    const rosters: RemotePeer[][] = [];
    const cb = {
      onRoster: vi.fn((r: RemotePeer[]) => rosters.push(r)),
      onChannelOpen: vi.fn(),
      onChannelClosed: vi.fn(),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const mesh = new Mesh(() => {
      throw new Error("factory blew up");
    }, cb);

    mesh.addExistingPeers(["p1"]);
    mesh.relay("p1", "sig");
    expect(() => settle()).not.toThrow(); // construction runs on a timer tick

    expect(mesh.size).toBe(0);
    expect(rosters.at(-1)).toEqual([]);
    expect(logged).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    logged.mockRestore();
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
    settle();
    mesh.remove("p1");
    const emits = rosters.length;
    made[0].events.onRemoteStream(fakeStream);
    made[0].events.onConnectionState("connected");
    expect(rosters.length).toBe(emits);
    expect(mesh.size).toBe(0);
  });
});

describe("Mesh relay routing", () => {
  it("routes payloads to the addressed link only", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    settle();
    mesh.relay("p2", "payload-x");
    await flush();
    expect(made[1].link.handleSignal).toHaveBeenCalledWith("payload-x");
    expect(made[0].link.handleSignal).not.toHaveBeenCalled();
  });

  it("relay from an unknown peer is dropped; handleSignal rejection is swallowed", async () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].link.handleSignal.mockRejectedValueOnce(new Error("straggler ICE"));
    expect(() => mesh.relay("stranger", "x")).not.toThrow();
    expect(() => mesh.relay("p1", "y")).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
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

describe("Mesh link recovery (Phase 4C)", () => {
  it("failed → restartIce immediately", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    expect(made[0].link.restartIce).toHaveBeenCalledOnce();
  });

  it("failed link that recovers cancels the rebuild", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    made[0].events.onConnectionState("connected");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS + 1_000);
    expect(made).toHaveLength(1); // no second construction
  });

  it("failed with no recovery rebuilds the link off-tick, politeness preserved", () => {
    const { mesh, made, rosters } = harness();
    mesh.addExistingPeers(["p1"]);
    settle();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // fallback fires
    expect(made).toHaveLength(1); // rebuild is DEFERRED — not in this tick
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made).toHaveLength(2);
    expect(made[1].polite).toBe(true); // same role as the original
    expect(made[0].link.close).toHaveBeenCalledOnce();
    expect(rosters.at(-1)?.[0].stream).toBeNull(); // stream reset for the new link
  });

  it("rebuilds are capped at MAX_LINK_REBUILDS", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    for (let i = 0; i < MAX_LINK_REBUILDS + 2; i++) {
      made.at(-1)!.events.onConnectionState("failed");
      vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS);
    }
    expect(made).toHaveLength(1 + MAX_LINK_REBUILDS); // original + capped rebuilds
  });

  it("disconnected persisting past the grace restarts ICE; self-heal does not", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("disconnected");
    vi.advanceTimersByTime(DISCONNECTED_RESTART_MS - 1_000);
    made[0].events.onConnectionState("connected"); // healed at 2s
    vi.advanceTimersByTime(10_000);
    expect(made[0].link.restartIce).not.toHaveBeenCalled();

    made[0].events.onConnectionState("disconnected");
    vi.advanceTimersByTime(DISCONNECTED_RESTART_MS);
    expect(made[0].link.restartIce).toHaveBeenCalledOnce();
  });

  it("signals arriving during a rebuild window queue and drain into the NEW link", async () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // old link closed, rebuild pending
    mesh.relay("p1", "queued-during-rebuild");
    vi.advanceTimersByTime(STAGGER_MS);
    await Promise.resolve(); // let the chain tick (make the test async)
    expect(made[1].link.handleSignal).toHaveBeenCalledWith("queued-during-rebuild");
    expect(made[0].link.handleSignal).not.toHaveBeenCalledWith("queued-during-rebuild");
  });

  it("remove and closeAll cancel recovery timers — nothing fires later", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    mesh.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("addNewcomer is now deferred off the handler tick too (watch item closed)", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    expect(made).toHaveLength(0); // not in the calling tick
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made).toHaveLength(1);
  });
});

describe("Mesh link recovery — fix wave (fallback survives intermediate states)", () => {
  it("an intermediate 'connecting' state does not disarm the failed fallback", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(1_000);
    made[0].events.onConnectionState("connecting"); // restartIce's own transition
    vi.advanceTimersByTime(RESTART_RECOVERY_MS - 1_000); // original deadline, minus the 1s already spent
    expect(made).toHaveLength(1); // fallback fires here, but construction is itself deferred
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made).toHaveLength(2); // fallback still fired despite the intermediate state
  });

  it("failed → connected cancels the pending rebuild AND resets the rebuild counter", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    // Burn one rebuild.
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS);
    expect(made).toHaveLength(2); // one rebuild happened

    // Fully recover.
    made[1].events.onConnectionState("connected");

    // If the counter weren't reset, only MAX_LINK_REBUILDS - 1 more rebuilds
    // would be available. Burn a full MAX_LINK_REBUILDS worth here to prove
    // the counter actually reset, not just that the pending timer cancelled.
    for (let i = 0; i < MAX_LINK_REBUILDS; i++) {
      made.at(-1)!.events.onConnectionState("failed");
      vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS);
    }
    expect(made).toHaveLength(2 + MAX_LINK_REBUILDS);
  });

  it("a second failed while the fallback is armed does not call restartIce again", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    expect(made[0].link.restartIce).toHaveBeenCalledOnce();
    made[0].events.onConnectionState("failed"); // still within the armed window
    expect(made[0].link.restartIce).toHaveBeenCalledOnce(); // not called again
  });

  it("old link's late events are ignored once a rebuild has replaced it (link-identity guard)", () => {
    const { mesh, made, rosters } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // fallback fires -> rebuildLink
    vi.advanceTimersByTime(STAGGER_MS); // new link constructed
    expect(made).toHaveLength(2);

    // The discarded link reports its own late "failed" — it must not touch
    // the entry now owned by the new link (no restartIce, no burned rebuild).
    made[0].events.onConnectionState("failed");
    expect(made[1].link.restartIce).not.toHaveBeenCalled();

    // Stale stream/channel events from the old link are ignored too.
    made[0].events.onRemoteStream(fakeStream);
    made[0].events.onChannelOpen();
    expect(rosters.at(-1)?.[0].stream).toBeNull();

    // And no rebuild was burned by the stale "failed" — nothing fires later.
    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS + 1_000);
    expect(made).toHaveLength(2);
  });

  it("a construction failure during rebuild keeps the peer mapped as failed, not evicted", () => {
    const rosters: RemotePeer[][] = [];
    const cb = {
      onRoster: vi.fn((r: RemotePeer[]) => rosters.push(r)),
      onChannelOpen: vi.fn(),
      onChannelClosed: vi.fn(),
    };
    const madeLocal: Array<{ events: LinkEvents; link: FakeLink }> = [];
    let attempts = 0;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const mesh = new Mesh((_peerId, _polite, events) => {
      attempts += 1;
      if (attempts === 1) {
        const link = new FakeLink();
        madeLocal.push({ events, link });
        return link;
      }
      throw new Error("rebuild construction blew up");
    }, cb);

    mesh.addNewcomer("p1");
    settle();
    madeLocal[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // fallback fires -> rebuildLink
    vi.advanceTimersByTime(STAGGER_MS); // deferred construct runs and throws

    expect(mesh.size).toBe(1); // still mapped, not evicted
    expect(rosters.at(-1)).toEqual([{ peerId: "p1", stream: null, connectionState: "failed" }]);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("caps the pending-signal queue at MAX_PENDING_SIGNALS, dropping newest", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1"]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const total = MAX_PENDING_SIGNALS + 5;
    for (let i = 0; i < total; i++) mesh.relay("p1", `sig-${i}`);
    settle();
    // The drain chain is MAX_PENDING_SIGNALS deep — flush()'s fixed 10-tick
    // budget isn't enough to walk it; wait until every queued payload has
    // actually reached handleSignal instead of a fixed number of ticks.
    for (let i = 0; i < MAX_PENDING_SIGNALS * 10 && made[0].link.handleSignal.mock.calls.length < MAX_PENDING_SIGNALS; i++) {
      await Promise.resolve();
    }
    const applied = made[0].link.handleSignal.mock.calls.map((c) => c[0]);
    expect(applied).toHaveLength(MAX_PENDING_SIGNALS);
    // The head of the queue is the offer everything behind it depends on —
    // it must survive. The trailing (newest) candidates are the ones shed.
    expect(applied[0]).toBe("sig-0");
    expect(applied.at(-1)).toBe(`sig-${MAX_PENDING_SIGNALS - 1}`); // the newest 5 were dropped
    expect(warned).toHaveBeenCalledOnce(); // single warn despite multiple drops
    warned.mockRestore();
  });

  it("a rebuild of the only-open-channel link fires onChannelClosed", () => {
    const { mesh, made, cb } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onChannelOpen();
    expect(cb.onChannelOpen).toHaveBeenCalledOnce();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS);
    expect(cb.onChannelClosed).toHaveBeenCalledOnce();
  });

  it("failed preempts an armed disconnected grace timer — restarts now, not at grace expiry", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("disconnected"); // arms a 3s grace timer
    vi.advanceTimersByTime(500);
    made[0].events.onConnectionState("failed"); // preempts the grace — restart now
    expect(made[0].link.restartIce).toHaveBeenCalledOnce();

    // The original grace deadline (t=3s) is well inside this window — if it
    // had survived the preemption it would have fired a second, stray
    // restart here. It must not: the fallback armed by "failed" replaces it
    // outright, with a fresh RESTART_RECOVERY_MS window starting from t=0.5s.
    vi.advanceTimersByTime(RESTART_RECOVERY_MS - 1); // 1ms short of the new fallback's deadline (t=10.5s)
    expect(made[0].link.restartIce).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1); // exactly RESTART_RECOVERY_MS after the preemption (t=10.5s)
    expect(made).toHaveLength(1); // rebuildLink fired, but construction is itself deferred
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made).toHaveLength(2); // rebuild landed
  });

  it("two newcomers announcing in the same tick are spaced a stagger apart (unified cursor)", () => {
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    mesh.addNewcomer("p2");
    expect(made).toHaveLength(0);
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made.map((m) => m.peerId)).toEqual(["p1"]);
    vi.advanceTimersByTime(STAGGER_MS);
    expect(made.map((m) => m.peerId)).toEqual(["p1", "p2"]);
  });
});

describe("Mesh rebuild roster honesty (Task 4 badge fix)", () => {
  it("during a rebuild, the new link's 'new'/'connecting' events leave the roster at 'failed' and emit nothing", () => {
    const { mesh, made, rosters } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS); // fallback fires -> rebuildLink
    vi.advanceTimersByTime(STAGGER_MS); // new link constructed
    expect(made).toHaveLength(2);
    expect(rosters.at(-1)?.[0].connectionState).toBe("failed"); // still failed right after construction

    const emitsBefore = rosters.length;
    made[1].events.onConnectionState("new");
    made[1].events.onConnectionState("connecting");
    expect(rosters.length).toBe(emitsBefore); // neither transition emitted a roster
    expect(rosters.at(-1)?.[0].connectionState).toBe("failed"); // still failed — badge stays honest
    // No interaction with the recovery machine either — connecting was
    // already a no-op there, and suppression short-circuits before it's reached.
    expect(made[1].link.restartIce).not.toHaveBeenCalled();
  });

  it("during a rebuild, the new link's 'connected' event flips the roster to connected and re-arms nothing", () => {
    const { mesh, made, rosters } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed");
    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS);
    expect(made).toHaveLength(2);

    made[1].events.onConnectionState("connecting"); // suppressed, still "failed"
    expect(rosters.at(-1)?.[0].connectionState).toBe("failed");
    made[1].events.onConnectionState("connected"); // real recovery — written normally
    expect(rosters.at(-1)?.[0].connectionState).toBe("connected");

    // Recovered — nothing should be armed; advancing well past every
    // recovery window must not produce a third link.
    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS + DISCONNECTED_RESTART_MS);
    expect(made).toHaveLength(2);
  });

  it("a rebuilt link that fails again reports 'failed' honestly and burns the next rebuild per the cap", () => {
    const { mesh, made, rosters } = harness();
    mesh.addNewcomer("p1");
    settle();
    made[0].events.onConnectionState("failed"); // rebuild #1 armed
    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS);
    expect(made).toHaveLength(2); // rebuild #1 landed

    made[1].events.onConnectionState("connecting"); // suppressed
    expect(rosters.at(-1)?.[0].connectionState).toBe("failed");

    made[1].events.onConnectionState("failed"); // the rebuilt link fails too — honest news
    expect(rosters.at(-1)?.[0].connectionState).toBe("failed");
    expect(made[1].link.restartIce).toHaveBeenCalledOnce(); // drives the next recovery cycle

    vi.advanceTimersByTime(RESTART_RECOVERY_MS + STAGGER_MS);
    expect(made).toHaveLength(3); // rebuild #2 landed — within MAX_LINK_REBUILDS
  });
});
