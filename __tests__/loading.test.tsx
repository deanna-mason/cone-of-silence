// The root Suspense fallback (app/loading.tsx) — the switchboard strip shown
// while a page streams in. Renders inside the root layout, so it is just the
// strip, in the same form as the room page's Studio Deck warm-up fallback.
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Loading from "@/app/loading";

afterEach(cleanup);

test("renders the switchboard loading copy", () => {
  render(<Loading />);
  expect(screen.getByText(/switchboard/i)).toBeDefined();
  expect(screen.getByText(/patching you through/i)).toBeDefined();
});

test("announces itself as a status region", () => {
  render(<Loading />);
  expect(screen.getByRole("status")).toBeDefined();
});
