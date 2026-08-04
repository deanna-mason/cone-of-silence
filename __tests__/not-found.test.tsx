// The 404 boundary (app/not-found.tsx) — dossier copy for an unmatched URL,
// with a route home. Renders inside the root layout, so it is just the card.
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import NotFound from "@/app/not-found";

afterEach(cleanup);

test("renders the dossier 404 copy", () => {
  render(<NotFound />);
  expect(screen.getByText(/this file is not on record/i)).toBeDefined();
  expect(screen.getByText(/no such corridor/i)).toBeDefined();
});

test("offers a route back to the lobby", () => {
  render(<NotFound />);
  const link = screen.getByRole("link", { name: /return to lobby/i });
  expect(link.getAttribute("href")).toBe("/");
});
