// Route-segment error boundary (app/error.tsx). Verifies the dossier fallback
// copy renders and the recover affordance is wired to the Next 16.3.0 stable
// `retry` prop, falling back to `reset` when it is absent.
//
// These tests previously passed `unstable_retry` (the 16.2.x name) and stayed
// green for it, even though the 16.3.0 runtime never sends that prop and every
// real click was silently degrading to reset(). A test that hand-feeds a prop
// name can only prove the component agrees with the test, so the contract check
// below reads the expected prop names off Next's own runtime type rather than
// restating them here.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import type { ReactNode } from "react";
import type { ErrorInfo } from "next/dist/client/components/error-boundary";
import ErrorBoundary from "@/app/error";

// vitest globals are off — auto-cleanup never registers; unmount explicitly.
afterEach(cleanup);

// The boundary logs to console.error on mount (the field log); keep it quiet.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// A 16.2.x runtime passes no `retry` at all. The prop is typed required because
// 16.3.0 always passes it, so reproducing that older call shape takes a explicit
// cast — the same component, minus the prop the old runtime lacked.
const ErrorBoundaryAsOlderRuntime = ErrorBoundary as unknown as (props: {
  error: Error & { digest?: string };
  reset: () => void;
}) => ReactNode;

test("prop signature matches what the Next runtime actually passes", () => {
  // Compile-time guard on exactly what this bug got wrong. `ErrorInfo` is the
  // type Next's own ErrorBoundary uses to call this component, so this
  // assignment only compiles while our destructured names still match the
  // runtime's. If an upgrade renames the recover prop again — as 16.2's
  // `unstable_retry` became 16.3's `retry` — `npm run typecheck` fails here
  // instead of the button quietly falling through to reset() in production.
  // This bites only because `retry` is required, matching how error.md types it.
  // `error` is narrowed to Error per the docs' own TS example, so it is spliced
  // in rather than left as the runtime's looser `unknown`.
  const acceptsRuntimeProps: (
    props: Omit<ErrorInfo, "error"> & { error: Error },
  ) => unknown = ErrorBoundary;
  expect(acceptsRuntimeProps).toBe(ErrorBoundary);
});

test("renders the dossier failure card", () => {
  render(
    <ErrorBoundary error={new Error("boom")} reset={() => {}} retry={() => {}} />,
  );
  expect(screen.getByText(/the dispatch went dark/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /retry transmission/i })).toBeDefined();
});

test("recover button calls retry when provided", () => {
  const retry = vi.fn();
  const reset = vi.fn();
  render(<ErrorBoundary error={new Error("boom")} reset={reset} retry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: /retry transmission/i }));
  expect(retry).toHaveBeenCalledOnce();
  // retry re-fetches; reset only re-renders. Preferring reset would quietly
  // weaken the recovery this card's copy promises.
  expect(reset).not.toHaveBeenCalled();
});

test("recover falls back to reset when retry is absent", () => {
  const reset = vi.fn();
  render(<ErrorBoundaryAsOlderRuntime error={new Error("boom")} reset={reset} />);
  fireEvent.click(screen.getByRole("button", { name: /retry transmission/i }));
  expect(reset).toHaveBeenCalledOnce();
});

test("shows the case number when a digest is present", () => {
  const error = Object.assign(new Error("boom"), { digest: "abc123" });
  render(<ErrorBoundary error={error} reset={() => {}} retry={() => {}} />);
  expect(screen.getByText(/case no\. abc123/i)).toBeDefined();
});
