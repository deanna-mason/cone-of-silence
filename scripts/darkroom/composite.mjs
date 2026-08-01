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
 *   overlay filter's own `shortest=1` option — this bounds the VIDEO half
 *   of the filtergraph to local's duration alone. Remote composites onto
 *   that result with the default eof_action (repeat), so it never extends
 *   or truncates the video timeline.
 * - Audio (D21, controller ruling on this task's review): the video-side
 *   `shortest=1` above does NOT bound the audio. The already-mixed,
 *   already-aligned episode m4a (upstream mixApplyArgs's amix defaults to
 *   duration=longest) can outlast local on churn/reconnect asymmetries —
 *   left unchecked, the finished mp4's real container duration would then
 *   exceed local, violating the "duration pinned to LOCAL" invariant even
 *   though the video track itself is correctly capped. Fixed with the
 *   classic exact-pin idiom: the audio is routed through `apad` (infinite
 *   pad) and the OUTPUT carries `-shortest` — the container then ends
 *   exactly when the (already local-capped) video ends. This supersedes
 *   the plan's literal "-shortest NOT used" line; that line's INTENT
 *   (don't let a short REMOTE truncate the composite) is preserved by the
 *   video-side `overlay=...:shortest=1` cap, which is unaffected by this
 *   output-level flag. `apad` requires filtering, so this output's audio
 *   is re-encoded (`-c:a aac -b:a 192k`) rather than copied — the
 *   archival `episode.m4a` product itself is untouched; only the
 *   composite mp4's muxed-in audio track loses the copy fast-path.
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
    // D21: infinite-pad the audio so it never ends before the video does —
    // paired with the output-level `-shortest` below, the container's real
    // duration is then exactly the (already local-capped) video's.
    `[${audioIdx}:a]apad[outa]`,
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
    "[outa]",
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
    "aac",
    "-b:a",
    "192k",
    // Output-level exact-pin (D21) — safe here specifically BECAUSE the
    // audio was just apad'ed to never be the shortest stream; the video
    // (local-capped via the overlay `shortest=1` above) is what actually
    // ends first, so this flag can't let a short remote win the way the
    // plan's original "-shortest NOT used" line was written to prevent.
    "-shortest",
    "-movflags",
    "+faststart",
    outMp4,
  ];
}
