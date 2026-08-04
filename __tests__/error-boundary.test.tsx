// Route-segment error boundary (app/error.tsx). Verifies the dossier fallback
// copy renders and the recover affordance is wired to the Next 16.2.9
// `unstable_retry` prop, falling back to `reset` when it is absent.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
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

test("renders the dossier failure card", () => {
  render(<ErrorBoundary error={new Error("boom")} reset={() => {}} />);
  expect(screen.getByText(/the dispatch went dark/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /retry transmission/i })).toBeDefined();
});

test("recover button calls unstable_retry when provided", () => {
  const retry = vi.fn();
  const reset = vi.fn();
  render(
    <ErrorBoundary error={new Error("boom")} reset={reset} unstable_retry={retry} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /retry transmission/i }));
  expect(retry).toHaveBeenCalledOnce();
  expect(reset).not.toHaveBeenCalled();
});

test("recover falls back to reset when unstable_retry is absent", () => {
  const reset = vi.fn();
  render(<ErrorBoundary error={new Error("boom")} reset={reset} />);
  fireEvent.click(screen.getByRole("button", { name: /retry transmission/i }));
  expect(reset).toHaveBeenCalledOnce();
});

test("shows the case number when a digest is present", () => {
  const error = Object.assign(new Error("boom"), { digest: "abc123" });
  render(<ErrorBoundary error={error} reset={() => {}} />);
  expect(screen.getByText(/case no\. abc123/i)).toBeDefined();
});
