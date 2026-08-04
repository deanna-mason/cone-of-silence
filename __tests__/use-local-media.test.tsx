// In-call device switching / phone flip (S4). The mesh wiring is tested
// elsewhere; here we pin the acquire-side contract useLocalMedia owns:
// flipCamera toggles facingMode without an explicit deviceId, an explicit
// camera pick clears any facingMode, and both preserve the live mute state.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const getLocalStream = vi.fn<(c?: unknown) => Promise<unknown>>();
const listDevices = vi.fn(async () => ({
  mics: [],
  cameras: [{ deviceId: "c1" }, { deviceId: "c2" }],
}));
const stopStream = vi.fn();
const readStashedDeviceChoice = vi.fn(() => ({}));
const stashDeviceChoice = vi.fn();

vi.mock("@/lib/webrtc/media", () => ({
  getLocalStream: (c?: unknown) => getLocalStream(c),
  listDevices: () => listDevices(),
  stopStream: (s: unknown) => stopStream(s),
  readStashedDeviceChoice: () => readStashedDeviceChoice(),
  stashDeviceChoice: (c: unknown) => stashDeviceChoice(c),
  MediaError: class MediaError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
}));

import { useLocalMedia } from "@/hooks/useLocalMedia";

function fakeStream() {
  const tracks = [
    { kind: "audio", enabled: true, stop: vi.fn() },
    { kind: "video", enabled: true, stop: vi.fn() },
  ];
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getTracks: () => tracks,
  };
}

afterEach(cleanup);

beforeEach(() => {
  getLocalStream.mockReset();
  getLocalStream.mockImplementation(async () => fakeStream());
  stopStream.mockReset();
  stashDeviceChoice.mockReset();
});

async function mountReady() {
  const hook = renderHook(() => useLocalMedia(true));
  await waitFor(() => expect(hook.result.current.stream).not.toBeNull());
  return hook;
}

test("flipCamera toggles facingMode user→environment→user with no explicit deviceId", async () => {
  const { result } = await mountReady();

  await act(async () => {
    await result.current.flipCamera();
  });
  let choice = getLocalStream.mock.calls.at(-1)![0] as { facingMode?: string; videoDeviceId?: string };
  expect(choice.facingMode).toBe("environment");
  expect(choice.videoDeviceId).toBeUndefined();

  await act(async () => {
    await result.current.flipCamera();
  });
  choice = getLocalStream.mock.calls.at(-1)![0] as { facingMode?: string };
  expect(choice.facingMode).toBe("user");
});

test("flipCamera preserves a cut mic across the re-acquire", async () => {
  const { result } = await mountReady();

  act(() => result.current.toggleMic());
  expect(result.current.micOn).toBe(false);

  await act(async () => {
    await result.current.flipCamera();
  });

  expect(result.current.micOn).toBe(false);
  expect(result.current.stream!.getAudioTracks()[0].enabled).toBe(false);
});

test("an explicit camera pick clears any prior facingMode", async () => {
  const { result } = await mountReady();

  await act(async () => {
    await result.current.flipCamera(); // now facingMode=environment
  });
  await act(async () => {
    await result.current.switchDevice("video", "c2");
  });

  const choice = getLocalStream.mock.calls.at(-1)![0] as { videoDeviceId?: string; facingMode?: string };
  expect(choice.videoDeviceId).toBe("c2");
  expect(choice.facingMode).toBeUndefined();
});
