// Guards the parts of the DAY/NIGHT feature that live in CSS, which no other
// test can reach: vitest runs in jsdom, which has no cascade and never
// evaluates @media (prefers-color-scheme). __tests__/theme-toggle.test.tsx
// proves lib/theme.ts writes the right attribute — but the attribute only
// MEANS anything because of the three rule blocks below, and every one of them
// could be deleted without failing a single other test in the suite.
//
// So this reads app/globals.css as text and asserts its structure. Crude, but
// it is the difference between "the override is tested" and "the override is
// assumed".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Comments are stripped first: globals.css documents these very selectors in
// prose above the rules, so a naive indexOf would match the comment and parse
// the wrong block.
const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block following `selector`, by brace matching. */
function blockAfter(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector not found in globals.css: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start + selector.length);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

/** Custom-property declarations as a sorted `--name:value` list. */
function customProps(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => `${name}:${value.replace(/\s+/g, " ").trim()}`)
    .sort();
}

describe("theme CSS three-state contract", () => {
  it("excludes forced DAY from the OS dark-mode block", () => {
    // THE critical assertion. Without :not([data-theme="light"]) the media
    // query still applies on a dark-OS machine even after the viewer picks
    // DAY, so the nav toggle silently stops working in one direction — the
    // exact direction the whole three-state design exists to support.
    const media = blockAfter("@media (prefers-color-scheme: dark)");
    expect(media).toContain(':root:not([data-theme="light"])');
  });

  it("pins color-scheme in both forced states", () => {
    // Without these the `light dark` pair on :root keeps resolving from the OS,
    // so native controls and scrollbars render for the mode the viewer left.
    expect(blockAfter(':root[data-theme="dark"]')).toMatch(/color-scheme:\s*dark;/);
    expect(blockAfter(':root[data-theme="light"]')).toMatch(/color-scheme:\s*light;/);
  });

  it("keeps the two night palettes identical", () => {
    // The night palette is duplicated: once under the OS media query, once
    // under the forced-NIGHT attribute. They co-apply on a dark OS with NIGHT
    // chosen, and nothing but this test stops them drifting apart — which
    // would make forced NIGHT and OS NIGHT render as different palettes.
    const fromMedia = customProps(blockAfter("@media (prefers-color-scheme: dark)"));
    const fromAttr = customProps(blockAfter(':root[data-theme="dark"]'));
    expect(fromAttr).toEqual(fromMedia);
    expect(fromMedia.length).toBeGreaterThan(10); // guards against both parsing to []
  });

  it("lights the correct word in each palette", () => {
    // --theme-day / --theme-night are what make DAY or NIGHT look selected.
    // Inverted here and the toggle would show the wrong word as active in one
    // palette, with nothing else failing.
    // The base :root block — first rule in the file once comments are gone.
    const day = blockAfter(":root");
    expect(day).toMatch(/--theme-day:\s*var\(--signal\);/);
    expect(day).toMatch(/--theme-night:\s*var\(--ink-faint\);/);

    for (const night of [
      blockAfter("@media (prefers-color-scheme: dark)"),
      blockAfter(':root[data-theme="dark"]'),
    ]) {
      expect(night).toMatch(/--theme-day:\s*var\(--ink-faint\);/);
      expect(night).toMatch(/--theme-night:\s*var\(--signal\);/);
    }
  });

  it("keeps the toggle's tint layered so utilities still win", () => {
    // Unlayered rules beat every layered rule regardless of specificity, so
    // an unlayered .theme-day silently kills the hover:text-signal utility
    // Tailwind emits into @layer utilities.
    const components = blockAfter("@layer components");
    expect(components).toContain(".theme-day");
    expect(components).toContain(".theme-night");
  });
});
