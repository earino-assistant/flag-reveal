// reveal-render.js — shared DOM glue for the progressive flag reveal, used by
// BOTH the player phone (js/flag-ui.js) and the TV (js/screen-flag.js). It is
// logic-light: the tile order and blur schedule come from the pure functions in
// js/flag.js (revealPlan/exposedAt); this file only paints them.
//
// PRIVACY (SPEC §5.2): this renderer reads ONLY public round fields — flagSeed,
// currentStep, gridN, steps, the answer ISO. It NEVER takes round/private as
// input. A country's ISO is used solely to pick the vendored SVG to paint.
//
// The flag is drawn into a FIXED reveal canvas of aspect `revealAspect` (default
// 3:2) with object-fit: contain (SPEC §8.4), so every flag — 1:1 (CH/VA), 11:28
// (QA), Nepal's pennant — tiles identically. A gridN×gridN overlay of tiles
// de-occludes as `currentStep` advances; a parallel blur→sharp track sharpens
// the whole image.

import { revealPlan, exposedAt } from "./flag.js";
import { flagAssetPath } from "./flags-data.js";

// "3:2" | "3/2" | number → a CSS aspect-ratio value string.
function aspectCss(revealAspect) {
  if (typeof revealAspect === "number" && Number.isFinite(revealAspect)) {
    return String(revealAspect);
  }
  const m = String(revealAspect || "3:2").split(/[:/]/);
  const w = Number(m[0]) || 3;
  const h = Number(m[1]) || 2;
  return `${w} / ${h}`;
}

// Build (or reuse) the canvas + tile grid inside `container`. Rebuilds the DOM
// only when the flag, grid size, or aspect changes; otherwise updates in place
// so re-rendering every snapshot is cheap.
function ensureStructure(container, iso2, gridN, revealAspect) {
  const key = `${iso2}|${gridN}|${revealAspect}`;
  if (container._flagKey === key && container._tiles) return;

  container.innerHTML = "";
  container.classList.add("flag-canvas");
  container.style.setProperty("--flag-aspect", aspectCss(revealAspect));
  container.style.setProperty("--flag-grid", String(gridN));

  const img = document.createElement("img");
  img.className = "flag-img";
  img.alt = ""; // decorative during play; the answer is announced separately
  img.setAttribute("aria-hidden", "true");
  img.src = flagAssetPath(iso2);
  container.appendChild(img);

  const grid = document.createElement("div");
  grid.className = "flag-grid";
  const tiles = [];
  for (let i = 0; i < gridN * gridN; i++) {
    const t = document.createElement("div");
    t.className = "flag-tile";
    grid.appendChild(t);
    tiles.push(t);
  }
  container.appendChild(grid);

  container._flagKey = key;
  container._img = img;
  container._tiles = tiles;
}

/**
 * Render the reveal into `container`.
 * @param {HTMLElement} container
 * @param {object} opts - { flagSeed, currentStep, gridN, steps, iso2,
 *                          revealAspect, full }
 *   `full: true` forces the fully-revealed, unblurred flag (reveal/gameOver).
 */
export function renderReveal(container, opts) {
  const {
    flagSeed,
    currentStep = 1,
    gridN = 4,
    steps = 8,
    iso2,
    revealAspect = "3:2",
    full = false,
  } = opts || {};
  if (!container || !iso2) return;

  ensureStructure(container, iso2, gridN, revealAspect);
  const plan = revealPlan(flagSeed >>> 0, steps, gridN);
  const step = full ? steps : currentStep;
  const { tiles, blurPx } = exposedAt(plan, step);
  const shown = new Set(tiles);

  const els = container._tiles;
  for (let i = 0; i < els.length; i++) {
    els[i].classList.toggle("exposed", shown.has(i));
  }
  container._img.style.filter = full ? "none" : `blur(${blurPx}px)`;
  container.classList.toggle("full", !!full);
}
