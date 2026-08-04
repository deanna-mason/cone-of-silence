// NavBar: below sm the inline link row (which overran a 390px viewport,
// 7/30 testers) collapses into a menu toggle + an absolute dropdown.
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import NavBar from "@/components/NavBar";

afterEach(cleanup);

const DESTINATIONS = ["Lobby", "Dossier", "Studio", "Account"];

describe("NavBar", () => {
  test("desktop link row always renders all four destinations", () => {
    render(<NavBar />);
    for (const label of DESTINATIONS) {
      expect(screen.getAllByRole("link", { name: label }).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("the mobile menu toggle opens/closes the dropdown and exposes every destination", () => {
    render(<NavBar />);
    const toggle = screen.getByRole("button", { name: /menu/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("nav-menu")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const menu = document.getElementById("nav-menu");
    expect(menu).not.toBeNull();
    for (const label of DESTINATIONS) {
      expect(within(menu!).getByRole("link", { name: label })).toBeDefined();
    }

    // Selecting a destination closes the dropdown.
    fireEvent.click(within(menu!).getByRole("link", { name: "Studio" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("nav-menu")).toBeNull();
  });
});
