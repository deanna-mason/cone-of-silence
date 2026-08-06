// The nav's DAY / NIGHT toggle. The palette itself is CSS (three states in
// app/globals.css); what is testable here is the contract lib/theme.ts holds
// up: which attribute lands on <html>, that it survives a reload, and that an
// explicit choice overrides the OS in BOTH directions — a viewer on a dark OS
// has to be able to force DAY, not just the other way round.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import ThemeToggle from "@/components/ThemeToggle";
import {
  THEME_ATTRIBUTE,
  THEME_NO_FLASH_SCRIPT,
  THEME_STORAGE_KEY,
  readResolvedTheme,
} from "@/lib/theme";

/** Pin the OS preference for a test. */
function stubOs(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("prefers-color-scheme: dark") ? dark : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  stubOs(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const day = () => screen.getByRole("button", { name: "Day theme" });
const night = () => screen.getByRole("button", { name: "Night theme" });

describe("ThemeToggle", () => {
  test("renders DAY and NIGHT as pressable options in a labelled group", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("group", { name: "Theme" })).toBeDefined();
    expect(day().textContent).toBe("DAY");
    expect(night().textContent).toBe("NIGHT");
    // Keyboard-reachable: real buttons, not click-handled spans.
    expect(day().tagName).toBe("BUTTON");
    expect(night().tagName).toBe("BUTTON");
  });

  test("a first visit follows the OS and leaves the document unmarked", () => {
    render(<ThemeToggle />);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    // No attribute at all — the @media block is left to decide.
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    expect(day().getAttribute("aria-pressed")).toBe("true");
    expect(night().getAttribute("aria-pressed")).toBe("false");
  });

  test("a dark OS resolves to NIGHT without any stored choice", () => {
    stubOs(true);
    render(<ThemeToggle />);
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    expect(night().getAttribute("aria-pressed")).toBe("true");
    expect(day().getAttribute("aria-pressed")).toBe("false");
  });

  test("override direction 1 — NIGHT on a light-mode machine", () => {
    stubOs(false);
    render(<ThemeToggle />);

    fireEvent.click(night());

    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(night().getAttribute("aria-pressed")).toBe("true");
    expect(day().getAttribute("aria-pressed")).toBe("false");
  });

  test("override direction 2 — DAY on a dark-mode machine", () => {
    // The direction a dark-only `[data-theme="dark"]` rule cannot express:
    // the media query would still win, so the toggle must mark the document
    // explicitly for light too.
    stubOs(true);
    render(<ThemeToggle />);
    expect(night().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(day());

    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(day().getAttribute("aria-pressed")).toBe("true");
    expect(night().getAttribute("aria-pressed")).toBe("false");
  });

  test("the choice beats the OS on the next visit, not just the click", () => {
    stubOs(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    render(<ThemeToggle />);

    // The mount re-applies the stored choice (the dev Strict Mode safety net),
    // and the resolved theme ignores the dark OS.
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(readResolvedTheme()).toBe("light");
    expect(day().getAttribute("aria-pressed")).toBe("true");
  });

  test("switching back and forth keeps document and storage in step", () => {
    render(<ThemeToggle />);
    fireEvent.click(night());
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    fireEvent.click(day());
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  test("garbage in storage is ignored — the OS still decides", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "chartreuse");
    stubOs(true);
    render(<ThemeToggle />);
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    expect(readResolvedTheme()).toBe("dark");
  });
});

describe("the no-flash inline script", () => {
  // This is the string app/layout.tsx runs in <head>, before first paint.
  function runNoFlashScript() {
    new Function(THEME_NO_FLASH_SCRIPT)();
  }

  test("applies a stored choice to <html> on its own, with no React involved", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runNoFlashScript();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });

  test("applies a stored light choice too, so a dark OS is overridden pre-paint", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    runNoFlashScript();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });

  test("marks nothing when no choice was made, leaving the OS in charge", () => {
    runNoFlashScript();
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });

  test("ignores an unrecognised stored value rather than pinning the palette", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark-ish");
    runNoFlashScript();
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });
});
