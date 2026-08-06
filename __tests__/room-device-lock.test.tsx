// The in-call device-bar lock, as the room page wires it (8/5 re-drill
// finding 2).
//
// The rider from commit 54e0e69 stands: CallControls keeps the BROAD lock
// (`podcastLocked`) — only the Equipment bar loosens. What changed is the key:
// the bar follows `podcast.faultedThisTake`, a latch that survives the
// operator acknowledging the alarm, instead of `panel.kind === "fault"`, which
// does not. Deanna acknowledged the unplugged-camera alarm on the live drill,
// the panel fell back to "rolling", and the picker re-locked with the camera
// still unplugged.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import RoomPage from "@/app/room/page";
import type { PodcastPanelState } from "@/components/PodcastPanel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// jsdom has no WebSocket for the real session hook — a steady "connected"
// with no peers is all this test observes.
vi.mock("@/hooks/useCallSession", () => ({
  useCallSession: () => ({
    status: "connected",
    peers: [],
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
  }),
}));

// The take itself is driven by __tests__/use-podcast-take.test.tsx; here the
// hook is a dial, so a take state can be posed directly. `bytes` and the
// action bag are module-level constants because the page feeds `podcast.bytes`
// into an effect's dep array — a fresh object per render would loop.
const BYTES = { video: 0, audio: 0 };
const ACTIONS = {
  chooseVault: async () => {},
  grantVault: async () => {},
  roll: () => {},
  stop: () => {},
  dismissFault: () => {},
};
const take = {
  panel: { kind: "armed", canSend: false, partnerCodename: null } as PodcastPanelState,
  faultedThisTake: false,
  // Every args object the page has handed the hook this render pass. The mock
  // makes the take a dial, but the ARGUMENTS are real page wiring, and one of
  // them (audioDeviceId) becomes an `exact` constraint on the tape's own mic
  // capture — previously unobserved by any test, on either side of the mock.
  args: [] as { audioDeviceId?: string }[],
};

vi.mock("@/hooks/usePodcastTake", () => ({
  usePodcastTake: (args: { audioDeviceId?: string }) => {
    take.args.push(args);
    return {
      panel: take.panel,
      faultedThisTake: take.faultedThisTake,
      partnerCodename: null,
      myCodename: "Nightingale",
      bytes: BYTES,
      lastTakeId: null,
      actions: ACTIONS,
    };
  },
}));

const ID = "A".repeat(22);
const SECRET = "B".repeat(22);
const getUserMedia = vi.fn<() => Promise<MediaStream>>();

class FakeMediaStream extends EventTarget {
  // readyState/getSettings are what the pickers read to tell the truth about
  // which device is live (8/5 finding 4) — the capture lands on m1/c1 here
  // whatever was asked for.
  private tracks = [
    {
      kind: "audio",
      enabled: true,
      readyState: "live",
      stop() {},
      getSettings: () => ({ deviceId: "m1" }),
      addEventListener() {},
      removeEventListener() {},
    },
    {
      kind: "video",
      enabled: true,
      readyState: "live",
      stop() {},
      getSettings: () => ({ deviceId: "c1" }),
      addEventListener() {},
      removeEventListener() {},
    },
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

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("cos-room", JSON.stringify({ roomId: ID, secret: SECRET }));
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  take.panel = { kind: "armed", canSend: false, partnerCodename: null };
  take.faultedThisTake = false;
  take.args.length = 0;
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async () => new FakeMediaStream() as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { deviceId: "m1", kind: "audioinput", label: "Boom" },
        { deviceId: "c1", kind: "videoinput", label: "MacBook" },
        { deviceId: "c2", kind: "videoinput", label: "iPhone" },
      ]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
});

/** Green room → in-room, then open the Equipment disclosure. */
async function enterAndOpenEquipment() {
  render(<RoomPage />);
  fireEvent.click(await screen.findByRole("button", { name: /enter the cone/i }));
  fireEvent.click(await screen.findByRole("button", { name: /equipment/i }));
}

// 8/5 re-drill, finding 4 — the page wiring, end to end. A stale iPhone pick
// is stashed from a previous session but the capture came up on the MacBook
// (exactly the shape an unplug leaves: the stored choice outlives the device).
// The bar must name the camera that is live, not the one that was asked for —
// a picker already displaying the wanted camera fires no change event when it
// is picked again, which is why the swap needed two clicks on the drill.
test("the device bar names the live camera, not the stale stashed choice", async () => {
  sessionStorage.setItem("cos-devices", JSON.stringify({ audioDeviceId: "m1", videoDeviceId: "c2" }));
  await enterAndOpenEquipment();

  expect((screen.getByLabelText("Camera") as HTMLSelectElement).value).toBe("c1");
});

test("a clean rolling take locks the device bar — a swap would poison the tape", async () => {
  take.panel = {
    kind: "rolling",
    elapsedS: 4,
    localBytes: 1,
    partnerBytes: 1,
    partnerCodename: null,
  };
  await enterAndOpenEquipment();

  expect((screen.getByLabelText("Camera") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("Microphone") as HTMLSelectElement).disabled).toBe(true);
});

test("the bar is reachable while the fault banner is up", async () => {
  take.panel = {
    kind: "fault",
    faults: [{ side: "local", cause: "camera-lost" }],
    partnerCodename: null,
  };
  take.faultedThisTake = true;
  await enterAndOpenEquipment();

  expect((screen.getByLabelText("Camera") as HTMLSelectElement).disabled).toBe(false);
});

// The live failure: Stand Down returns the panel to "rolling" with the camera
// still unplugged. The bar must NOT re-lock — the swap is the remedy.
test("acknowledging the alarm leaves the bar reachable for the rest of the take", async () => {
  take.panel = {
    kind: "rolling",
    elapsedS: 9,
    localBytes: 1,
    partnerBytes: 1,
    partnerCodename: null,
  };
  take.faultedThisTake = true;
  await enterAndOpenEquipment();

  expect((screen.getByLabelText("Camera") as HTMLSelectElement).disabled).toBe(false);
  expect((screen.getByLabelText("Microphone") as HTMLSelectElement).disabled).toBe(false);
  expect(screen.queryByText(/locked while rolling/i)).toBeNull();

  // The rider: the call controls keep the BROAD lock. A compromised take is
  // still a take — no cutting the mic behind the recorder's back.
  expect((screen.getByRole("button", { name: /mic live|mic cut/i }) as HTMLButtonElement).disabled)
    .toBe(true);
});

// The same truth rule as the pickers above, one layer deeper. commit fd3f186
// moved every UI consumer off `choice` (stored intent, which can lie) and onto
// `liveDeviceIds` — but the podcast hook's audioDeviceId was missed, and that
// one is not cosmetic: it becomes an `exact` deviceId constraint on the tape's
// OWN mic capture (lib/podcast/recordGraph.ts). A mic that was merely busy at
// join (Zoom holding it) degrades the call to the default input while the
// stored pick stays stale forever — so the tape would have recorded the wrong
// microphone, with nothing faulted and nothing on screen to say so.
test("the tape's mic follows the LIVE capture, never the stale stored pick", async () => {
  // Asked for m0; the capture came up on m1 (the fake gUM honours no
  // constraint — exactly what a busy mic leaves behind).
  sessionStorage.setItem("cos-devices", JSON.stringify({ audioDeviceId: "m0", videoDeviceId: "c1" }));
  await enterAndOpenEquipment();

  expect(take.args.length).toBeGreaterThan(0);
  expect(take.args[take.args.length - 1]!.audioDeviceId).toBe("m1");
  // Not once, on any render, was the stale intent handed to the recorder.
  expect(take.args.map((a) => a.audioDeviceId)).not.toContain("m0");
});
