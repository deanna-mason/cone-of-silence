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
 *  is always a pad, never a trim), the episode chime trim, then the
 *  object-fit: COVER pair — scale-to-cover + center crop into the pane's
 *  own w/h (design 2026-08-03: the mp4 product crops so faces fill the
 *  full-frame tiles; §5A's never-crop rule now applies to the RAW vault
 *  recordings, which remain the complete, uncropped archival record).
 *  Returns `[label]`.
 *
 *  TRIM PLACEMENT (design 2026-08-05). The window goes AFTER tpad because
 *  it is expressed on the common post-delay timeline (the same timeline the
 *  audio's `adelay`ed mix is trimmed on), and BEFORE the scale/crop because
 *  trimming first means the scaler never touches frames that are about to
 *  be thrown away. Both panes get the IDENTICAL window, so the alignment
 *  computed upstream survives the cut.
 *
 *  WHY THE RE-ZERO IS `setpts=PTS-<startS>/TB` AND NOT `PTS-STARTPTS`
 *  (which is what the audio side uses — chain.mjs's `asetpts`). `atrim` is
 *  sample-accurate, so audio's first surviving sample IS `startS` and
 *  `STARTPTS` equals it exactly. The video `trim` filter is FRAME-quantized:
 *  at 30fps the first surviving frame can sit up to 33ms after `startS`.
 *  Re-zeroing THAT frame to PTS 0 with `STARTPTS` would advance the picture
 *  by up to a frame relative to the audio — a permanent lip-sync shift.
 *  Subtracting the exact `startS` instead preserves each frame's true offset
 *  from the cut. The cost is that a pane may show bare backdrop for under
 *  one frame at the very start, which is imperceptible and strictly
 *  preferable to a sync error. */
function videoChain(inputIdx, sinkLabel, pane, { setpts, delayMs, trim }) {
  const filters = [];
  if (setpts) filters.push(setpts);
  if (delayMs) filters.push(`tpad=start_duration=${(delayMs / 1000).toFixed(3)}`);
  // Same 3-decimal formatting as the audio trim segment pipeline.mjs builds
  // for chain.mjs — the two must name the same instant or the cut lands in
  // different places in the two tracks.
  const startS = trim.startS.toFixed(3);
  filters.push(`trim=start=${startS}:end=${trim.endS.toFixed(3)}`);
  filters.push(`setpts=PTS-${startS}/TB`);
  filters.push(`scale=${pane.w}:${pane.h}:force_original_aspect_ratio=increase`);
  filters.push(`crop=${pane.w}:${pane.h}`);
  return `[${inputIdx}:v]${filters.join(",")}[${sinkLabel}]`;
}

/**
 * compositeArgs(backdropPng, localWebm, remoteWebm, layout, {remoteSetpts, delays, trim}, audioM4a, outMp4) → string[]
 *
 * Argv for the final side-by-side composite:
 * - backdrop: `-loop 1` still-image input (the Humanym paper field + seal
 *   and wordmark plaque + wells + invisible labels, already rendered by
 *   renderBackdrop).
 * - local (LEFT pane, D14): cover scale+crop, optional tpad delay if IT is
 *   the earlier side. Never RATE-corrected (no `setpts=PTS*`) — local is the
 *   reference timeline; it does carry the trim's own re-zeroing setpts,
 *   which both panes get.
 * - remote (RIGHT pane, D14): remoteSetpts (drift-ratio rate correction)
 *   THEN its own tpad delay, both strictly before the cover scale/crop.
 * - trim (design 2026-08-05): `{startS, endS}` from drift.mjs's
 *   `episodeWindow()`, REQUIRED — the same window pipeline.mjs trims the
 *   mix's audio on, applied identically to both panes between tpad and
 *   scale. See videoChain's own comment for the placement and for why the
 *   video re-zero deliberately differs from the audio's. The duration-pin
 *   reasoning below is unaffected by it: the backdrop is still `-loop 1`
 *   and the remote overlay still carries no `shortest`, so `bg1` stays
 *   effectively infinite and `[outv]` still binds to local's length — now
 *   local's TRIMMED length.
 * - Two-stage overlay, REMOTE FIRST then LOCAL LAST (Task 7 review, round 2
 *   — the round-1 fix below was itself wrong; both are logged in
 *   task-7-report.md's fix-report addendum for the full derivation):
 *
 *   `[0:v][rpad]overlay=<rx>:<ry>[bg1]` (remote onto the backdrop, NO
 *   shortest) `;[bg1][lpad]overlay=<lx>:<ly>:shortest=1[outv]` (local onto
 *   that, WITH shortest=1 — the only shortest anywhere in this graph).
 *
 *   Why order matters and a single `shortest=1` isn't enough on its own:
 *   the backdrop input is `-loop 1`, i.e. genuinely infinite. Stage 1 has
 *   no `shortest`, so with the default `eof_action=repeat` its MAIN input
 *   (the infinite backdrop) is what keeps driving output — remote's last
 *   frame just freezes once remote's own (possibly delayed/drift-stretched)
 *   video ends, regardless of whether remote is longer or shorter than
 *   local. `bg1` therefore stays infinite no matter remote's length. Stage
 *   2's `shortest=1` then bounds `[outv]` to `min(bg1, lpad)` —
 *   `min(infinite, local's own duration)` — which is exactly local's
 *   duration, unconditionally, regardless of which of {local, remote} is
 *   actually longer.
 *
 *   ROUND 1 of this fix (shipped, then reverted) put local FIRST and added
 *   a second `shortest=1` on remote's stage instead:
 *   `[0:v][lpad]overlay=...:shortest=1[bg1];[bg1][rpad]overlay=...:shortest=1[outv]`.
 *   That makes stage 1's `bg1` FINITE (exactly local's own duration, via
 *   its own shortest=1) — so stage 2's `shortest=1` then computes
 *   `min(bg1, rpad)` = `min(localLen, remoteLen)`, i.e. it pins to
 *   WHICHEVER SIDE IS SHORTER, not to local specifically. Reviewer measured
 *   both directions against real ffmpeg: with remote genuinely longer than
 *   local, round 1 correctly landed on local's 180fr/6.000s (the case the
 *   original Task 5 bug report used, which is why round 1 looked right);
 *   with LOCAL genuinely longer (the `who === "local"` half of the offset
 *   space — local is the side that gets tpad-delayed and so becomes the
 *   longer chain), round 1 pinned to remote's 150fr/5.000s instead —
 *   content loss, with the mixed audio truncating right along with it via
 *   the output-level `-shortest` below. The remote-first/local-last
 *   ordering above is order-INDEPENDENT: verified 180fr/6.000s in BOTH
 *   directions (e2e now exercises both — episode-fix01 is `who: "remote"`,
 *   episode-fix02 is `who: "local"`).
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
 *
 * The options bag is spelled out for the type-checker below because `trim`
 * carries no default (it is required — an untrimmed composite would show
 * what the mix no longer contains), and TS infers a destructured JS
 * parameter's shape from its defaults alone.
 *
 * @param {string} backdropPng
 * @param {string} localWebm
 * @param {string} remoteWebm
 * @param {{left: {x: number, y: number, w: number, h: number}, right: {x: number, y: number, w: number, h: number}}} layout
 * @param {{remoteSetpts?: string, delays?: {local?: number, remote?: number}, trim: {startS: number, endS: number}}} opts
 * @param {string} audioM4a
 * @param {string} outMp4
 * @returns {string[]}
 */
export function compositeArgs(
  backdropPng,
  localWebm,
  remoteWebm,
  layout,
  { remoteSetpts = "", delays = {}, trim } = {},
  audioM4a,
  outMp4,
) {
  const localDelay = delays.local || 0;
  const remoteDelay = delays.remote || 0;

  const inputs = ["-loop", "1", "-framerate", "30", "-i", backdropPng, "-i", localWebm, "-i", remoteWebm, "-i", audioM4a];
  const localIdx = 1;
  const remoteIdx = 2;
  const audioIdx = 3;

  const localChain = videoChain(localIdx, "lpad", layout.left, { setpts: null, delayMs: localDelay, trim });
  const remoteChain = videoChain(remoteIdx, "rpad", layout.right, { setpts: remoteSetpts, delayMs: remoteDelay, trim });

  const filterComplex = [
    localChain,
    remoteChain,
    // Remote first, NO shortest — see the doc comment above for why this
    // keeps bg1 effectively infinite (driven by the looped backdrop input)
    // regardless of remote's own length.
    `[0:v][rpad]overlay=${layout.right.x}:${layout.right.y}[bg1]`,
    // Local LAST, the only shortest=1 in this graph — bounds [outv] to
    // min(bg1, lpad) = local's duration, unconditionally (order-independent
    // fix, Task 7 review round 2; see the doc comment above).
    `[bg1][lpad]overlay=${layout.left.x}:${layout.left.y}:shortest=1[outv]`,
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
