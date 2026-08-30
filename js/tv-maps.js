// tv-maps.js — thin Leaflet glue for the TV's two reveal maps (mirrors
// GeoParty's js/revealmap-ui.js). Every DECISION lives in the pure
// revealMapSpec / worldZoomFor (js/flag.js); this module only executes them: it
// builds two L.maps, drops a circleMarker on the answer country's centroid, sets
// the world view / fits the padded borders bbox, and tears everything down safely.
//
// The build is DEFERRED to a double requestAnimationFrame: Leaflet reads the
// container's clientWidth/clientHeight when it constructs the map, so building in
// the same tick the container is unhidden (`.hidden` just removed) captures a
// zero/stale size and leaves a wrong center/zoom (the field bug: a world map with
// a black-tile void, a borders map centered on the wrong country). Two rAFs
// guarantee a full layout pass has landed; a final rAF re-applies the view as
// belt-and-braces against any late layout shift.
//
// Zero product decisions beyond what the spec dict carries. No analytics, no
// consent import, no Firebase — the TV stays passive (it writes only its
// heartbeat, owned by screen-flag.js). Reads nothing beyond its args.
//
// Leaflet is a page global (the pinned <script> in screen.html, same as
// GeoParty). Read it lazily so the module imports cleanly in Node (tests).

import { revealMapSpec, worldZoomFor } from "./flag.js";

const leaflet = () => globalThis.L;

// Interaction-off map options, mirroring GeoParty's LEAFLET_MAP_OPTIONS. The
// reveal maps are decorative — the couch never touches the TV. attributionControl
// is left default-on so the OSM tile attribution stays visible (required).
const MAP_OPTIONS = Object.freeze({
  zoomControl: false, dragging: false, scrollWheelZoom: false,
  doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
});

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_OPTIONS = Object.freeze({
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
});

// The answer-country marker: a filled circle with a white ring so it reads
// clearly on ANY basemap (ocean, desert, forest). Concrete hex — CSS var()
// strings don't resolve inside Leaflet's SVG marker attrs.
const MARKER_STYLE = Object.freeze({
  radius: 10, color: "#ffffff", weight: 3, fillColor: "#ffcf3f", fillOpacity: 0.95,
});

// Module-level handles so destroy is idempotent across every phase edge.
let worldMap = null;
let bordersMap = null;
let containers = []; // element refs, so destroy can clear the boxes it filled
let rafId = 0; // handle of the pending double-rAF build (0 = none scheduled)
let buildToken = 0; // bumped by destroy; the deferred build bails if it moved

// rAF with a setTimeout fallback so the module works headless (Node import check)
// and degrades on the rare host without requestAnimationFrame.
function raf(fn) {
  return globalThis.requestAnimationFrame
    ? globalThis.requestAnimationFrame(fn)
    : setTimeout(fn, 16);
}
function cancelRaf(id) {
  if (!id) return;
  if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(id);
  else clearTimeout(id);
}
function cancelPendingBuild() {
  cancelRaf(rafId);
  rafId = 0;
}

/**
 * Build the two reveal maps for the answer ISO. Idempotent-safe: any prior maps
 * are torn down first. Offline (no globalThis.L) → a one-line placeholder in
 * each element instead of a map (decorative, matches GeoParty degradation).
 * A spec that comes back null (unknown iso / missing table) also degrades to the
 * placeholder rather than throwing.
 */
export function renderRevealMaps({ worldEl, bordersEl, iso2, table }) {
  destroyRevealMaps();
  if (!worldEl || !bordersEl) return;
  containers = [worldEl, bordersEl];

  const L = leaflet();
  if (!L) {
    setPlaceholder(worldEl);
    setPlaceholder(bordersEl);
    return;
  }

  const spec = revealMapSpec(iso2, table);
  if (!spec) {
    setPlaceholder(worldEl);
    setPlaceholder(bordersEl);
    return;
  }

  // Defer the actual build until the just-unhidden containers have a real layout
  // (see the module header). A double rAF crosses one full layout pass; the token
  // captured here lets a destroy that lands in between abort the build cleanly.
  const myToken = buildToken;
  cancelPendingBuild();
  rafId = raf(() => {
    rafId = raf(() => {
      rafId = 0;
      if (myToken !== buildToken) return; // torn down before we ran
      if (!worldEl.isConnected || !bordersEl.isConnected) return; // elements gone
      buildMaps(L, spec, worldEl, bordersEl, myToken);
    });
  });
}

// The deferred build proper. Runs only once the containers are laid out, so
// Leaflet measures the real size; a final rAF re-applies the view against any
// late shift. Guarded by `myToken` throughout — a phase edge (destroy) between
// scheduling and here, or before the final re-apply, makes this a no-op.
function buildMaps(L, spec, worldEl, bordersEl, myToken) {
  // Map 1 — "Where on Earth": a comfortable ~1/3-world view. worldZoomFor turns
  // the spec's spanDeg into a concrete zoom now that the container width is real.
  worldMap = L.map(worldEl, MAP_OPTIONS);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(worldMap);
  worldMap.setView(spec.world.center, worldZoomFor(worldEl.clientWidth, spec.world.spanDeg));
  L.circleMarker(spec.world.marker, MARKER_STYLE).addTo(worldMap);

  // Map 2 — "Up close": frame the whole-country bbox VERBATIM, then pad it so the
  // immediate neighbors show; cap the zoom so a microstate still frames sensibly.
  // bounds is [minLng, minLat, maxLng, maxLat] → Leaflet [[south, west], [north, east]].
  const b = spec.borders.bounds;
  const llBounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
  bordersMap = L.map(bordersEl, MAP_OPTIONS);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(bordersMap);
  bordersMap.fitBounds(llBounds, fitOpts(spec.borders, bordersEl));
  L.circleMarker(spec.borders.marker, MARKER_STYLE).addTo(bordersMap);

  // Belt and braces: re-measure and RE-APPLY each view one frame later so a late
  // layout shift can never leave a stale center/zoom (the field bug's core cause).
  raf(() => {
    if (myToken !== buildToken) return;
    if (worldMap) {
      worldMap.invalidateSize();
      worldMap.setView(spec.world.center, worldZoomFor(worldEl.clientWidth, spec.world.spanDeg));
    }
    if (bordersMap) {
      bordersMap.invalidateSize();
      bordersMap.fitBounds(llBounds, fitOpts(spec.borders, bordersEl));
    }
  });
}

// fitBounds options from the spec's pad fraction: symmetric pixel padding around
// the verbatim bbox so the country's neighbors stay in view, capped at maxZoom.
function fitOpts(borders, el) {
  const pad = borders.pad || 0;
  const px = [(el.clientWidth || 0) * pad, (el.clientHeight || 0) * pad];
  return { maxZoom: borders.maxZoom, paddingTopLeft: px, paddingBottomRight: px };
}

function setPlaceholder(el) {
  el.textContent = "Map unavailable offline";
  el.classList.add("tv-map-offline");
}

/**
 * Tear both maps down and clear their containers. Idempotent — safe to call
 * twice and on every phase edge (screen-flag.js calls it on every non-reveal
 * snapshot). Bumps the build token (so a deferred build already in flight aborts)
 * and cancels the pending double-rAF build.
 */
export function destroyRevealMaps() {
  buildToken++;
  cancelPendingBuild();
  if (worldMap) {
    try { worldMap.remove(); } catch { /* already gone */ }
    worldMap = null;
  }
  if (bordersMap) {
    try { bordersMap.remove(); } catch { /* already gone */ }
    bordersMap = null;
  }
  // Clear whatever we put in the boxes (a built map's leftover DOM or an offline
  // placeholder) so the next reveal starts from a clean container.
  for (const el of containers) {
    if (!el) continue;
    el.textContent = "";
    el.classList.remove("tv-map-offline");
  }
  containers = [];
}
