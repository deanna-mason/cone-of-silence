// The root error boundary (app/global-error.tsx). It renders its own
// <html>/<body>; rendering that inside jsdom's document body produces DOM
// nesting warnings but works, which is enough to assert the copy and that the
// recover affordance is wired to unstable_retry (Next 16.2.9), falling back to
// reset. The component is deliberately self-contained (inline styles, no
// globals.css / next/font imports) so it is unit-testable and survives a CSS
// bundle failure.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import GlobalError from "@/app/global-error";

afterEach(cleanup);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("renders the blackout copy and recover button", () => {
  render(<GlobalError error={new Error("boom")} reset={() => {}} />);
  expect(screen.getByText(/the station went dark/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /re-establish channel/i })).toBeDefined();
});

test("recover button prefers unstable_retry over reset", () => {
  const retry = vi.fn();
  const reset = vi.fn();
  render(
    <GlobalError error={new Error("boom")} reset={reset} unstable_retry={retry} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /re-establish channel/i }));
  expect(retry).toHaveBeenCalledOnce();
  expect(reset).not.toHaveBeenCalled();
});
