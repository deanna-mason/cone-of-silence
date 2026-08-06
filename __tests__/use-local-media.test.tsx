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

/** A track that can report which device it is on and can be killed the way an
 *  unplugged camera kills one: readyState flips to "ended" and `ended` fires. */
function fakeTrack(kind: "audio" | "video", deviceId: string) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    kind,
    enabled: true,
    readyState: "live" as MediaStreamTrackState,
    deviceId,
    stop: vi.fn(),
    getSettings() {
      return { deviceId: this.deviceId };
    },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    /** Unplug: the source went away. */
    unplug(fireEnded = true) {
      this.readyState = "ended";
      if (fireEnded) listeners.get("ended")?.forEach((fn) => fn());
    },
  };
}

function fakeStream(ids: { audio?: string; video?: string } = {}) {
  const tracks = [fakeTrack("audio", ids.audio ?? "m1"), fakeTrack("video", ids.video ?? "c1")];
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getTracks: () => tracks,
  };
}

function audioOnlyStream() {
  const tracks = [fakeTrack("audio", "m1")];
  return {
    getAudioTracks: () => tracks,
    getVideoTracks: () => [],
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

test("devicechange re-reads the device lists (8/5 drill: replugged camera must appear)", async () => {
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
  });
  const { result, unmount } = await mountReady();
  await waitFor(() => expect(result.current.devices.cameras.length).toBe(2));

  listDevices.mockResolvedValueOnce({
    mics: [],
    cameras: [{ deviceId: "c1" }, { deviceId: "c2" }, { deviceId: "continuity" }],
  });
  act(() => listeners.get("devicechange")!());
  await waitFor(() => expect(result.current.devices.cameras.length).toBe(3));

  unmount();
  expect(listeners.has("devicechange")).toBe(false);
  vi.unstubAllGlobals();
});

// 8/5 re-drill, finding 4. The pickers used to display stored *intent*
// (`choice`, falling back to the first name in the list), which stays put when
// a camera is unplugged and no re-acquire happens — so the UI named a camera
// the capture was not on. liveDeviceIds is read off the tracks themselves.
test("liveDeviceIds report the devices the tracks are actually on", async () => {
  getLocalStream.mockImplementation(async () => fakeStream({ audio: "m9", video: "c9" }));
  const { result } = await mountReady();
  await waitFor(() =>
    expect(result.current.liveDeviceIds).toEqual({ audioDeviceId: "m9", videoDeviceId: "c9" }),
  );
});

test("a camera unplugged mid-call drops out of liveDeviceIds — the mic is untouched", async () => {
  const stream = fakeStream();
  getLocalStream.mockImplementation(async () => stream);
  const { result } = await mountReady();
  await waitFor(() => expect(result.current.liveDeviceIds.videoDeviceId).toBe("c1"));

  act(() => stream.getVideoTracks()[0].unplug());

  await waitFor(() => expect(result.current.liveDeviceIds.videoDeviceId).toBeUndefined());
  expect(result.current.liveDeviceIds.audioDeviceId).toBe("m1");
});

// getLocalStream's audio-only degrade reaches the same shape with no unplug at
// all: a stashed videoDeviceId, and no video track to honour it.
test("an audio-only degrade reports no live camera", async () => {
  getLocalStream.mockImplementation(async () => audioOnlyStream());
  const { result } = await mountReady();
  await waitFor(() => expect(result.current.liveDeviceIds.audioDeviceId).toBe("m1"));
  expect(result.current.liveDeviceIds.videoDeviceId).toBeUndefined();
});

// Belt and braces for Deanna's rig: a Continuity Camera is not guaranteed to
// fire `ended` on the track when the phone drops off. devicechange fires
// regardless, so re-read the live tracks there too.
test("devicechange re-reads the live tracks, even with no ended event", async () => {
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
  });
  const stream = fakeStream();
  getLocalStream.mockImplementation(async () => stream);
  const { result } = await mountReady();
  await waitFor(() => expect(result.current.liveDeviceIds.videoDeviceId).toBe("c1"));

  stream.getVideoTracks()[0].unplug(false); // no `ended` event
  act(() => listeners.get("devicechange")!());

  await waitFor(() => expect(result.current.liveDeviceIds.videoDeviceId).toBeUndefined());
  vi.unstubAllGlobals();
});

test("switching cameras moves liveDeviceIds to the new device", async () => {
  getLocalStream.mockImplementation(async () => fakeStream({ video: "c1" }));
  const { result } = await mountReady();
  await waitFor(() => expect(result.current.liveDeviceIds.videoDeviceId).toBe("c1"));

  getLocalStream.mockImplementation(async () => fakeStream({ video: "c2" }));
  await act(async () => {
    await result.current.switchDevice("video", "c2");
  });

  await waitFor(() => expect(result.current.liveDeviceIds.videoDeviceId).toBe("c2"));
});
