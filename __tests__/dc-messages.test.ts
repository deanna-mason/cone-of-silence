import { describe, expect, it, vi } from "vitest";
import { Mesh, type LinkEvents, type MeshLink } from "@/lib/webrtc/mesh";

class FakeLink implements MeshLink {
  handleSignal = vi.fn(async () => {});
  replaceStream = vi.fn(async () => {});
  restartIce = vi.fn();
  close = vi.fn();
  send = vi.fn((_text: string) => true);
}

function harness() {
  const made: { peerId: string; events: LinkEvents; link: FakeLink }[] = [];
  const messages: [string, string][] = [];
  const mesh = new Mesh(
    (peerId, _polite, events) => {
      const link = new FakeLink();
      made.push({ peerId, events, link });
      return link;
    },
    {
      onRoster: () => {},
      onChannelOpen: () => {},
      onChannelClosed: () => {},
      onMessage: (peerId, text) => messages.push([peerId, text]),
    },
  );
  return { mesh, made, messages };
}

describe("dc app messages", () => {
  it("routes an inbound message with its peerId", () => {
    vi.useFakeTimers();
    const { mesh, made, messages } = harness();
    mesh.addNewcomer("p1");
    vi.runAllTimers();
    made[0].events.onMessage('{"t":"pod/hello"}');
    expect(messages).toEqual([["p1", '{"t":"pod/hello"}']]);
    vi.useRealTimers();
  });

  it("sendTo hits exactly that peer's link and reports channel readiness", () => {
    vi.useFakeTimers();
    const { mesh, made } = harness();
    mesh.addNewcomer("p1");
    mesh.addNewcomer("p2");
    vi.runAllTimers();
    expect(mesh.sendTo("p2", "x")).toBe(true);
    expect(made.find((m) => m.peerId === "p2")!.link.send).toHaveBeenCalledWith("x");
    expect(made.find((m) => m.peerId === "p1")!.link.send).not.toHaveBeenCalled();
    expect(mesh.sendTo("ghost", "x")).toBe(false); // unknown or linkless peer
    vi.useRealTimers();
  });

  it("sendAll skips linkless entries without throwing", () => {
    vi.useFakeTimers();
    const { mesh, made } = harness();
    mesh.addExistingPeers(["a", "b"]); // staggered: links not built yet
    mesh.sendAll("y"); // must not throw while links are null
    vi.runAllTimers();
    mesh.sendAll("y");
    expect(made.every((m) => m.link.send.mock.calls.some((c) => c[0] === "y"))).toBe(true);
    vi.useRealTimers();
  });

  it("stale-link messages are ignored after rebuild replaces the link", () => {
    // Mirror the identity-guard idiom construct() uses for onRemoteStream:
    // capture events from the FIRST link, remove the peer, re-add, then fire
    // the stale onMessage — it must not surface.
    vi.useFakeTimers();
    const { mesh, made, messages } = harness();
    mesh.addNewcomer("p1");
    vi.runAllTimers();
    const stale = made[0].events;
    mesh.remove("p1");
    mesh.addNewcomer("p1");
    vi.runAllTimers();
    stale.onMessage("old");
    expect(messages).toEqual([]);
    vi.useRealTimers();
  });
});
