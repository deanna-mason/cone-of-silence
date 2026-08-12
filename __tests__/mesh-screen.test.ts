// Mesh screen-share plumbing: the outbound fan-out (every BUILT link gets the
// screen track; links still waiting on their stagger timer are skipped — they
// get it from the session at construction, like the local stream) and the
// inbound bookkeeping (scr/share announces a stream ID; the matching remote
// MediaStream files under `screenStream`, whichever of the two arrives first —
// announce-then-track and track-then-announce are both legal orders).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, type LinkEvents, type MeshLink, type RemotePeer } from "@/lib/webrtc/mesh";

class FakeLink implements MeshLink {
  handleSignal = vi.fn(async (_payload: string) => {});
  replaceStream = vi.fn(async (_stream: MediaStream) => {});
  close = vi.fn();
  restartIce = vi.fn();
  send = vi.fn(() => true);
  sendXfer = vi.fn(() => true);
  xferBufferedAmount = vi.fn(() => 0);
  startScreenShare = vi.fn(async (_track: MediaStreamTrack, _stream: MediaStream) => {});
  stopScreenShare = vi.fn(async () => {});
}

interface Made {
  peerId: string;
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
    onMessage: vi.fn(),
    onChannelState: vi.fn(),
    onXferMessage: vi.fn(),
    onXferDrain: vi.fn(),
  };
  const mesh = new Mesh((peerId, _polite, events) => {
    const link = new FakeLink();
    made.push({ peerId, events, link });
    return link;
  }, cb);
  const lastRoster = () => rosters[rosters.length - 1];
  return { mesh, made, rosters, lastRoster };
}

const streamWithId = (id: string): MediaStream => ({ id }) as unknown as MediaStream;
const fakeTrack = {} as MediaStreamTrack;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("screenShareAll / stopScreenShareAll", () => {
  it("forwards to every built link and skips links still awaiting construction", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1", "p2"]);
    vi.runAllTimers(); // both links built
    mesh.addNewcomer("p3"); // timer NOT run — link is null

    const screen = streamWithId("scr-1");
    await mesh.screenShareAll(fakeTrack, screen);

    expect(made).toHaveLength(2);
    for (const m of made) expect(m.link.startScreenShare).toHaveBeenCalledWith(fakeTrack, screen);
  });

  it("stop forwards the same way", async () => {
    const { mesh, made } = harness();
    mesh.addExistingPeers(["p1"]);
    vi.runAllTimers();

    await mesh.stopScreenShareAll();

    expect(made[0].link.stopScreenShare).toHaveBeenCalledOnce();
  });
});

describe("remote screen bookkeeping", () => {
  it("announce first, stream second: the screen stream files under screenStream, never the face slot", () => {
    const { mesh, made, lastRoster } = harness();
    mesh.addExistingPeers(["p1"]);
    vi.runAllTimers();

    mesh.setRemoteScreen("p1", "scr-1");
    const screen = streamWithId("scr-1");
    made[0].events.onRemoteStream(screen);

    const [peer] = lastRoster();
    expect(peer.screenStream).toBe(screen);
    expect(peer.stream).toBeNull();
  });

  it("stream first, announce second: the camera keeps the face slot once the announce lands", () => {
    const { mesh, made, lastRoster } = harness();
    mesh.addExistingPeers(["p1"]);
    vi.runAllTimers();

    const camera = streamWithId("cam-1");
    const screen = streamWithId("scr-1");
    made[0].events.onRemoteStream(camera);
    made[0].events.onRemoteStream(screen);
    mesh.setRemoteScreen("p1", "scr-1");

    const [peer] = lastRoster();
    expect(peer.stream).toBe(camera);
    expect(peer.screenStream).toBe(screen);
  });

  it("a stop announce clears screenStream and the dead screen stream never becomes the face", () => {
    const { mesh, made, lastRoster } = harness();
    mesh.addExistingPeers(["p1"]);
    vi.runAllTimers();

    const camera = streamWithId("cam-1");
    const screen = streamWithId("scr-1");
    made[0].events.onRemoteStream(camera);
    mesh.setRemoteScreen("p1", "scr-1");
    made[0].events.onRemoteStream(screen);
    mesh.setRemoteScreen("p1", null);

    const [peer] = lastRoster();
    // Absent, not null: a roster row without a screen is byte-identical to a
    // pre-screen-share row (the additivity contract roster() documents).
    expect(peer.screenStream).toBeUndefined();
    expect(peer.stream).toBe(camera);
  });

  it("an announce for an unknown peer is a no-op, not a crash", () => {
    const { mesh } = harness();
    expect(() => mesh.setRemoteScreen("ghost", "scr-1")).not.toThrow();
  });

  // The 8/11 live-test regression: a RE-share reuses the already-negotiated
  // sender (replaceTrack — no renegotiation), so NO fresh `track` event ever
  // fires on this side. The only way the tile can come back is if the stream
  // stayed filed across the stop — which is exactly what the first cut threw
  // away (delete-on-stop). Each seat could share once; every later share was
  // invisible to the far side.
  it("a re-share after a stop re-files the retained stream — no fresh track event needed", () => {
    const { mesh, made, lastRoster } = harness();
    mesh.addExistingPeers(["p1"]);
    vi.runAllTimers();

    const camera = streamWithId("cam-1");
    const screen = streamWithId("scr-1");
    made[0].events.onRemoteStream(camera);
    mesh.setRemoteScreen("p1", "scr-1");
    made[0].events.onRemoteStream(screen);
    mesh.setRemoteScreen("p1", null); // stop — tile down
    mesh.setRemoteScreen("p1", "scr-1"); // re-share — same carrier id, no new ontrack

    const [peer] = lastRoster();
    expect(peer.screenStream).toBe(screen);
    expect(peer.stream).toBe(camera);
  });

  it("a stream once announced as a screen never becomes the face, even after the share ends", () => {
    const { mesh, made, lastRoster } = harness();
    mesh.addExistingPeers(["p1"]);
    vi.runAllTimers();

    // Screen arrives LAST, then the share stops: "most recent stream wins"
    // must not promote the retained screen stream into the face slot.
    const camera = streamWithId("cam-1");
    const screen = streamWithId("scr-1");
    made[0].events.onRemoteStream(camera);
    mesh.setRemoteScreen("p1", "scr-1");
    made[0].events.onRemoteStream(screen);
    mesh.setRemoteScreen("p1", null);

    const [peer] = lastRoster();
    expect(peer.screenStream).toBeUndefined();
    expect(peer.stream).toBe(camera);
  });
});
