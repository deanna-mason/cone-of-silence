// In-call device bar (S4): swap camera/mic mid-call, flip on phones, and the
// design ruling — device swaps are LOCKED while a podcast take is rolling
// (the record graph holds the raw tracks; a mid-take swap poisons the take).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import InCallDeviceBar from "@/components/InCallDeviceBar";

afterEach(cleanup);

function setPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: coarse && query.includes("coarse"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

const cameras = [
  { deviceId: "c1", label: "Front", kind: "videoinput" },
  { deviceId: "c2", label: "Back", kind: "videoinput" },
] as unknown as MediaDeviceInfo[];
const mics = [{ deviceId: "m1", label: "Boom", kind: "audioinput" }] as unknown as MediaDeviceInfo[];

function props(over: Partial<React.ComponentProps<typeof InCallDeviceBar>> = {}) {
  return {
    mics,
    cameras,
    choice: {} as { audioDeviceId?: string; videoDeviceId?: string; facingMode?: "user" | "environment" },
    hasCamera: true,
    locked: false,
    onSelectMic: vi.fn(),
    onSelectCamera: vi.fn(),
    onFlip: vi.fn(),
    ...over,
  };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: /equipment/i }));
}

beforeEach(() => setPointer(false));

test("selecting a different camera mid-call fires onSelectCamera", () => {
  const p = props();
  render(<InCallDeviceBar {...p} />);
  open();
  const camera = screen.getByLabelText("Camera") as HTMLSelectElement;
  fireEvent.change(camera, { target: { value: "c2" } });
  expect(p.onSelectCamera).toHaveBeenCalledWith("c2");
});

test("selecting a different mic mid-call fires onSelectMic", () => {
  const p = props();
  render(<InCallDeviceBar {...p} />);
  open();
  const mic = screen.getByLabelText("Microphone") as HTMLSelectElement;
  fireEvent.change(mic, { target: { value: "m1" } });
  expect(p.onSelectMic).toHaveBeenCalledWith("m1");
});

test("the flip control shows on a coarse-pointer (phone) device and fires onFlip", () => {
  setPointer(true);
  const p = props();
  render(<InCallDeviceBar {...p} />);
  const flip = screen.getByRole("button", { name: /flip camera/i });
  fireEvent.click(flip);
  expect(p.onFlip).toHaveBeenCalledTimes(1);
});

test("the flip control is absent on a fine-pointer (desktop) device", () => {
  setPointer(false);
  render(<InCallDeviceBar {...props()} />);
  expect(screen.queryByRole("button", { name: /flip camera/i })).toBeNull();
});

test("locked while rolling — pickers are disabled and a themed notice shows", () => {
  const p = props({ locked: true });
  render(<InCallDeviceBar {...p} />);
  open();
  expect((screen.getByLabelText("Camera") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("Microphone") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText(/disabled to protect the tape/i)).toBeDefined();
});

test("locked while rolling — the flip control is disabled, not firing", () => {
  setPointer(true);
  const p = props({ locked: true });
  render(<InCallDeviceBar {...p} />);
  const flip = screen.getByRole("button", { name: /flip camera/i }) as HTMLButtonElement;
  expect(flip.disabled).toBe(true);
  fireEvent.click(flip);
  expect(p.onFlip).not.toHaveBeenCalled();
});
