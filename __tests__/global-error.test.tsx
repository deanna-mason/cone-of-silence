// The root error boundary (app/global-error.tsx). It renders its own
// <html>/<body>; rendering that inside jsdom's document body produces DOM
// nesting warnings but works, which is enough to assert the copy and that the
// recover affordance is wired to the stable `retry` prop (Next 16.3.0), falling
// back to reset. The component is deliberately self-contained (inline styles, no
// globals.css / next/font imports) so it is unit-testable and survives a CSS
// bundle failure.
//
// Like app/error.tsx, this file used to hand the component `unstable_retry` —
// the 16.2.x name the 16.3.0 runtime never sends — so the suite stayed green
// while the only button on the blackout page fell through to reset(). The
// contract check below takes the prop names from Next's own runtime type so a
// future rename cannot slip past the same way.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import type { ReactNode } from "react";
import type { ErrorInfo } from "next/dist/client/components/error-boundary";
import GlobalError from "@/app/global-error";

afterEach(cleanup);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Reproduces a 16.2.x runtime, which passes no `retry` at all; the prop is typed
// required because 16.3.0 always passes it, so omitting it takes an explicit cast.
const GlobalErrorAsOlderRuntime = GlobalError as unknown as (props: {
  error: Error & { digest?: string };
  reset: () => void;
}) => ReactNode;

test("prop signature matches what the Next runtime actually passes", () => {
  // Only compiles while this component's destructured prop names match the
  // ErrorInfo type Next's ErrorBoundary calls it with — see the note in
  // error-boundary.test.tsx.
  const acceptsRuntimeProps: (
    props: Omit<ErrorInfo, "error"> & { error: Error },
  ) => unknown = GlobalError;
  expect(acceptsRuntimeProps).toBe(GlobalError);
});

test("renders the blackout copy and recover button", () => {
  render(
    <GlobalError error={new Error("boom")} reset={() => {}} retry={() => {}} />,
  );
  expect(screen.getByText(/the station went dark/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /re-establish channel/i })).toBeDefined();
});

test("recover button prefers retry over reset", () => {
  const retry = vi.fn();
  const reset = vi.fn();
  render(<GlobalError error={new Error("boom")} reset={reset} retry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: /re-establish channel/i }));
  expect(retry).toHaveBeenCalledOnce();
  expect(reset).not.toHaveBeenCalled();
});

test("recover falls back to reset when retry is absent", () => {
  const reset = vi.fn();
  render(<GlobalErrorAsOlderRuntime error={new Error("boom")} reset={reset} />);
  fireEvent.click(screen.getByRole("button", { name: /re-establish channel/i }));
  expect(reset).toHaveBeenCalledOnce();
});
