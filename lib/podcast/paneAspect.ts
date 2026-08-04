// lib/podcast/paneAspect.ts — the darkroom composite's pane shape.
//
// MUST mirror scripts/darkroom/template.html's #pane-left/#pane-right
// geometry (930x1008 — see the template's geometry table comment). The room
// UI uses it, while the tape rolls, to preview exactly the region the
// episode mp4 will show (composite.mjs cover-crops each camera into a pane
// of this shape). If the template's pane size ever changes, change this too.
export const EPISODE_PANE_W = 930;
export const EPISODE_PANE_H = 1008;
