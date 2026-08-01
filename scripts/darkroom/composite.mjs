// Template render (headless Chrome) + side-by-side overlay arg builder.
//
// D10: this ffmpeg build has no drawtext/freetype, so the 1920x1080
// composite backdrop (manila field, pane wells, codename label plates,
// kicker, stamp) is a committed HTML/CSS file (scripts/darkroom/
// template.html) rendered per-episode by headless Chrome. Pane geometry is
// read back from the LIVE page (getBoundingClientRect), never hardcoded
// here — a redesign of template.html never touches this file.
//
// D14: local host renders in the LEFT pane, remote in the RIGHT.
import { DarkroomError } from "./errors.mjs";

/**
 * renderBackdrop(chromePath, templatePath, {left, right}, outPng) → Promise<Layout>
 *
 * Loads template.html in headless Chrome (playwright-core, the phase5a-e2e
 * EXECUTABLE-resolution pattern — the caller resolves and passes chromePath;
 * this module never picks a Chrome build itself), sets the two codename
 * label texts via evaluate() (never baked into the HTML — zero PII at rest),
 * screenshots the fixed 1920x1080 page to outPng, and returns the pane
 * wells' own live geometry so the pipeline never guesses at coordinates.
 *
 * Layout = { left: {x,y,w,h}, right: {x,y,w,h} } — integers, from
 * getBoundingClientRect() on #pane-left / #pane-right.
 *
 * Any failure (Chrome launch, navigation, missing pane elements, screenshot)
 * is reported as `template-render-failed`.
 */
export async function renderBackdrop(chromePath, templatePath, { left, right }, outPng) {
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`file://${templatePath}`);

    await page.evaluate(
      ({ left, right }) => {
        const leftEl = document.querySelector("#label-left span");
        const rightEl = document.querySelector("#label-right span");
        if (!leftEl || !rightEl) {
          throw new Error("template.html is missing #label-left/#label-right span elements");
        }
        leftEl.textContent = left;
        rightEl.textContent = right;
      },
      { left, right },
    );

    await page.screenshot({ path: outPng });

    const layout = await page.evaluate(() => {
      const rectOf = (id) => {
        const el = document.querySelector(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return { left: rectOf("#pane-left"), right: rectOf("#pane-right") };
    });

    if (!layout.left || !layout.right) {
      throw new Error("template.html is missing #pane-left/#pane-right elements");
    }

    return layout;
  } catch (err) {
    throw new DarkroomError("template-render-failed", err && err.message ? err.message : String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Builds the filtergraph segment for one input's video pane: optional rate
 *  correction (setpts, remote only), optional start delay (tpad — the
 *  earlier side is pushed later so both marks land on the same output
 *  timestamp; alignment() always hands back a non-negative delay, so this
 *  is always a pad, never a trim), then the object-fit: CONTAIN pair —
 *  scale-to-fit + center pad into the pane's own w/h (§5A honest framing:
 *  never crop, never stretch). Returns `[label]`. */
function videoChain(inputIdx, sinkLabel, pane, { setpts, delayMs }) {
  const filters = [];
  if (setpts) filters.push(setpts);
  if (delayMs) filters.push(`tpad=start_duration=${(delayMs / 1000).toFixed(3)}`);
  filters.push(`scale=${pane.w}:${pane.h}:force_original_aspect_ratio=decrease`);
  filters.push(`pad=${pane.w}:${pane.h}:(ow-iw)/2:(oh-ih)/2`);
  return `[${inputIdx}:v]${filters.join(",")}[${sinkLabel}]`;
}

/**
 * compositeArgs(backdropPng, localWebm, remoteWebm, layout, {remoteSetpts, delays}, audioM4a, outMp4) → string[]
 *
 * Argv for the final side-by-side composite:
 * - backdrop: `-loop 1` still-image input (the aged-dossier field + wells +
 *   labels + stamp, already rendered by renderBackdrop).
 * - local (LEFT pane, D14): contain scale+pad, optional tpad delay if IT is
 *   the earlier side. Never setpts — local is the reference timeline.
 * - remote (RIGHT pane, D14): remoteSetpts (drift-ratio rate correction)
 *   THEN its own tpad delay, both strictly before the contain scale/pad.
 * - Two-stage overlay: local composites onto the backdrop FIRST, with the
 *   overlay filter's own `shortest=1` option (not the global `-shortest`
 *   flag, which is never used) — this bounds the whole filtergraph's length
 *   to local's duration alone, exactly the "pinned to LOCAL, no -shortest"
 *   invariant. Remote composites onto that result with the default
 *   eof_action (repeat), so it never extends or truncates the timeline.
 * - Audio: the already-mixed, already-aligned episode m4a is the SOLE
 *   audio, mapped with `-c:a copy` (no re-encode — it's already final).
 */
export function compositeArgs(
  backdropPng,
  localWebm,
  remoteWebm,
  layout,
  { remoteSetpts = "", delays = {} } = {},
  audioM4a,
  outMp4,
) {
  const localDelay = delays.local || 0;
  const remoteDelay = delays.remote || 0;

  const inputs = ["-loop", "1", "-framerate", "30", "-i", backdropPng, "-i", localWebm, "-i", remoteWebm, "-i", audioM4a];
  const localIdx = 1;
  const remoteIdx = 2;
  const audioIdx = 3;

  const localChain = videoChain(localIdx, "lpad", layout.left, { setpts: null, delayMs: localDelay });
  const remoteChain = videoChain(remoteIdx, "rpad", layout.right, { setpts: remoteSetpts, delayMs: remoteDelay });

  const filterComplex = [
    localChain,
    remoteChain,
    `[0:v][lpad]overlay=${layout.left.x}:${layout.left.y}:shortest=1[bg1]`,
    `[bg1][rpad]overlay=${layout.right.x}:${layout.right.y}[outv]`,
  ].join(";");

  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    `${audioIdx}:a`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outMp4,
  ];
}
