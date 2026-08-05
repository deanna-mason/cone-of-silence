// useSpeakerLatch — the room's latched speaking indicator (8/4 rework).
// The outline holds on the MOST RECENT speaker until a DIFFERENT person
// speaks; it never goes dark when the current holder falls silent.
import { afterEach, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SELF_SPEAKER, useSpeakerLatch } from "@/hooks/useSpeakerLatch";

afterEach(cleanup);

function mount(selfSpeaking = false) {
  return renderHook(({ self }) => useSpeakerLatch(self), {
    initialProps: { self: selfSpeaking },
  });
}

test("nobody is lit before anyone has spoken", () => {
  const { result } = mount();
  expect(result.current.lastSpeaker).toBeNull();
});

test("self speaking latches SELF_SPEAKER and holds through silence", () => {
  const view = mount();
  view.rerender({ self: true });
  expect(view.result.current.lastSpeaker).toBe(SELF_SPEAKER);
  // Falling silent does NOT clear the latch — only a different speaker does.
  view.rerender({ self: false });
  expect(view.result.current.lastSpeaker).toBe(SELF_SPEAKER);
});

test("a remote speaker takes the latch, and self can take it back on a fresh rising edge", () => {
  const view = mount();
  view.rerender({ self: true });
  act(() => view.result.current.noteSpeaker("p1"));
  expect(view.result.current.lastSpeaker).toBe("p1");
  // The self detector must go quiet and rise again to re-latch — a level,
  // not an edge, would bounce the latch straight back every render.
  view.rerender({ self: false });
  expect(view.result.current.lastSpeaker).toBe("p1");
  view.rerender({ self: true });
  expect(view.result.current.lastSpeaker).toBe(SELF_SPEAKER);
});

test("re-noting the current holder keeps the latch (no flicker)", () => {
  const view = mount();
  act(() => view.result.current.noteSpeaker("p1"));
  act(() => view.result.current.noteSpeaker("p1"));
  expect(view.result.current.lastSpeaker).toBe("p1");
});

test("noteSpeaker identity is stable across renders (safe effect dep downstream)", () => {
  const view = mount();
  const first = view.result.current.noteSpeaker;
  view.rerender({ self: true });
  expect(view.result.current.noteSpeaker).toBe(first);
});
