// The room page's screen-share wiring, end to end across the UI half: the
// control renders only where getDisplayMedia exists, a click acquires the
// capture and hands it to the session's screen port, and a peer's announced
// screenStream gets its own document tile beside the face tiles. Same
// mock-the-session/stub-the-platform idiom as room-device-lock.test.tsx.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import RoomPage from "@/app/room/page";
import type { RemotePeer } from "@/lib/webrtc/session";
import type { PodcastPanelState } from "@/components/PodcastPanel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const screenPort = { share: vi.fn(), stop: vi.fn() };
const call = { peers: [] as RemotePeer[] };

vi.mock("@/hooks/useCallSession", () => ({
  useCallSession: () => ({
    status: "connected",
    peers: call.peers,
    dcOpen: false,
    bus: {
      sendAll: () => {},
      sendTo: () => false,
      onMessage: () => () => {},
      xfer: {
        send: () => false,
        bufferedAmount: () => -1,
        onMessage: () => () => {},
        onDrain: () => () => {},
        onChannelState: () => () => {},
      },
    },
    xferKey: null,
    screen: screenPort,
  }),
}));

const BYTES = { video: 0, audio: 0 };
const ACTIONS = {
  chooseVault: async () => {},
  grantVault: async () => {},
  roll: () => {},
  stop: () => {},
  dismissFault: () => {},
};

vi.mock("@/hooks/usePodcastTake", () => ({
  usePodcastTake: () => ({
    panel: { kind: "armed", canSend: false, partnerCodename: null } as PodcastPanelState,
    faultedThisTake: false,
    partnerCodename: null,
    myCodename: "Nightingale",
    bytes: BYTES,
    lastTakeId: null,
    actions: ACTIONS,
  }),
}));

const ID = "A".repeat(22);
const SECRET = "B".repeat(22);
const getUserMedia = vi.fn<() => Promise<MediaStream>>();
const getDisplayMedia = vi.fn<() => Promise<MediaStream>>();

class FakeCamStream extends EventTarget {
  private tracks = [
    { kind: "audio", enabled: true, readyState: "live", stop() {}, getSettings: () => ({ deviceId: "m1" }), addEventListener() {}, removeEventListener() {} },
    { kind: "video", enabled: true, readyState: "live", stop() {}, getSettings: () => ({ deviceId: "c1" }), addEventListener() {}, removeEventListener() {} },
  ];
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeScreenTrack extends EventTarget {
  kind = "video";
  readyState = "live";
  stop = vi.fn();
}

class FakeScreenStream {
  id = "scr-me";
  private track = new FakeScreenTrack();
  addEventListener() {}
  removeEventListener() {}
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

const remoteScreen = () =>
  ({
    id: "scr-p1",
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
    getTracks: () => [{}],
  }) as unknown as MediaStream;

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("cos-room", JSON.stringify({ roomId: ID, secret: SECRET }));
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  call.peers = [];
  screenPort.share.mockReset();
  screenPort.stop.mockReset();
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async () => new FakeCamStream() as unknown as MediaStream);
  getDisplayMedia.mockReset();
  getDisplayMedia.mockImplementation(async () => new FakeScreenStream() as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      getDisplayMedia,
      enumerateDevices: vi.fn(async () => [
        { deviceId: "m1", kind: "audioinput", label: "Boom" },
        { deviceId: "c1", kind: "videoinput", label: "MacBook" },
      ]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
});

async function enterRoom() {
  render(<RoomPage />);
  fireEvent.click(await screen.findByRole("button", { name: /enter the cone/i }));
  await screen.findByText(/secure channel/i);
}

test("sharing a screen: click → capture → session handoff → own document tile", async () => {
  await enterRoom();

  fireEvent.click(await screen.findByRole("button", { name: /table your screen/i }));

  await waitFor(() => expect(screenPort.share).toHaveBeenCalledTimes(1));
  expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
  expect(await screen.findByRole("button", { name: /screen on the table/i })).toBeTruthy();
  expect(screen.getByText("Your Screen")).toBeTruthy();
});

test("clearing the table stops the capture and the tile", async () => {
  await enterRoom();
  fireEvent.click(await screen.findByRole("button", { name: /table your screen/i }));
  await waitFor(() => expect(screenPort.share).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("button", { name: /screen on the table/i }));

  await waitFor(() => expect(screenPort.stop).toHaveBeenCalled());
  expect(screen.queryByText("Your Screen")).toBeNull();
  expect(screen.getByRole("button", { name: /table your screen/i })).toBeTruthy();
});

test("no getDisplayMedia → no share control (mobile browsers)", async () => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => []),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  await enterRoom();

  expect(screen.queryByRole("button", { name: /table your screen/i })).toBeNull();
});

test("a peer's announced screen gets its own tile, labeled off the agent", async () => {
  call.peers = [
    { peerId: "p1", stream: null, screenStream: remoteScreen(), connectionState: "connected" },
  ];
  await enterRoom();

  expect(screen.getByText("Agent 2's Screen")).toBeTruthy();
});

// 8/11 live-test finding: equal tiles made shared text unreadable. A tabled
// screen is the thing being discussed — it takes the dominant area and the
// faces drop to a strip.
test("a tabled screen dominates the layout — faces drop to a strip", async () => {
  call.peers = [
    { peerId: "p1", stream: null, screenStream: remoteScreen(), connectionState: "connected" },
  ];
  await enterRoom();

  const screenArea = screen.getByText("Agent 2's Screen").closest("figure")!.parentElement!;
  expect(screenArea.className).toContain("flex-1"); // the screen gets the room
  const faceStrip = screen.getByText("You").closest("figure")!.parentElement!;
  expect(faceStrip.className).toContain("grid-flow-col"); // faces ride the strip
  expect(faceStrip.className).not.toContain("flex-1");
});

// 8/11 second round: on desktop the strip UNDER the screen still stole ~9rem
// of height from a text-heavy share. At sm+ the faces ride a side column so
// the screen area keeps the full height of the view.
test("on desktop widths the faces ride a side column beside the screen", async () => {
  call.peers = [
    { peerId: "p1", stream: null, screenStream: remoteScreen(), connectionState: "connected" },
  ];
  await enterRoom();

  const screenArea = screen.getByText("Agent 2's Screen").closest("figure")!.parentElement!;
  expect(screenArea.parentElement!.className).toContain("sm:flex-row");
  const faceStrip = screen.getByText("You").closest("figure")!.parentElement!;
  expect(faceStrip.className).toContain("sm:grid-flow-row");
});

test("with nothing on the table, faces keep the full grid", async () => {
  call.peers = [{ peerId: "p1", stream: null, connectionState: "connected" }];
  await enterRoom();

  const faceGrid = screen.getByText("You").closest("figure")!.parentElement!;
  expect(faceGrid.className).toContain("flex-1");
});
