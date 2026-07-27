// Anti-flash contract (Deanna's requirement, spec §4C): `disconnected` is
// twitchy — show only after 3s of continuous bad state; once shown, never a
// single-frame flicker (1s minimum); `failed` shows fast.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  BADGE_DELAY_MS,
  BADGE_MIN_SHOW_MS,
  useSignalLostBadge,
} from "@/hooks/useSignalLostBadge";

// Date faked too — the min-show hold reads Date.now().
beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function drive(initial: RTCPeerConnectionState) {
  return renderHook(({ state }) => useSignalLostBadge(state), {
    initialProps: { state: initial },
  });
}

describe("useSignalLostBadge", () => {
  it("disconnected shows only after the full delay", () => {
    const h = drive("disconnected");
    act(() => vi.advanceTimersByTime(BADGE_DELAY_MS - 100));
    expect(h.result.current).toBe(false);
    act(() => vi.advanceTimersByTime(100));
    expect(h.result.current).toBe(true);
  });

  it("a quick self-heal never flashes the badge", () => {
    const h = drive("disconnected");
    act(() => vi.advanceTimersByTime(1_000));
    h.rerender({ state: "connected" });
    act(() => vi.advanceTimersByTime(60_000));
    expect(h.result.current).toBe(false);
  });

  it("failed shows immediately", () => {
    const h = drive("connected");
    h.rerender({ state: "failed" });
    expect(h.result.current).toBe(true);
  });

  it("once shown, stays a minimum beat even if the state recovers instantly", () => {
    const h = drive("failed");
    expect(h.result.current).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    h.rerender({ state: "connected" });
    expect(h.result.current).toBe(true); // still inside the minimum
    act(() => vi.advanceTimersByTime(BADGE_MIN_SHOW_MS));
    expect(h.result.current).toBe(false);
  });

  it("connecting/new never badge (pre-call states are the Awaiting story)", () => {
    const h = drive("new");
    act(() => vi.advanceTimersByTime(60_000));
    expect(h.result.current).toBe(false);
    h.rerender({ state: "connecting" });
    act(() => vi.advanceTimersByTime(60_000));
    expect(h.result.current).toBe(false);
  });
});
