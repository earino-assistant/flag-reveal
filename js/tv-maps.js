// tv-maps.js — thin Leaflet glue for the TV's ONE breathing reveal map (mirrors
// GeoParty's js/revealmap-ui.js). Every DECISION lives in the pure revealMapSpec
// / worldZoomFor (js/flag.js); this module only executes them and choreographs
// between the two endpoints they describe: it builds ONE L.map, drops a
// white-ringed gold circleMarker on the answer country's centroid, then pulses
// the view forever between the WORLD leg (~120° world context, "Where in the
// world?") and the COUNTRY leg (the padded whole-country bbox, "Up close"),
// swapping the figcaption per leg. The couch reads BOTH stories off one canvas.
//
// The cadence is a setTimeout chain: fly ~2.6s (Leaflet easing) → hold ~2.4s →
// fly the other leg → … a ~10s loop, forever, until torn down. Under
// `prefers-reduced-motion` there is NO loop: a single static country-leg framing
// with the "Up close" caption (house reduced-motion convention — the couch still
// gets the answer's detailed context, just without the movement).
//
// The build is DEFERRED to a double requestAnimationFrame: Leaflet reads the
// container's clientWidth/clientHeight when it constructs the map, so building in
// the same tick the container is unhidden (`.hidden` just removed) captures a
// zero/stale size and leaves a wrong center/zoom (the field bug: a world map with
// a black-tile void). Two rAFs guarantee a full layout pass has landed; a final
// rAF re-applies size + kicks off the motion as belt-and-braces against any late
// layout shift.
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
// reveal map is decorative — the couch never touches the TV. attributionControl
// is left default-on so the OSM tile attribution stays visible (required).
// zoomSnap 0.25 lets the map honor the fractional zoom worldZoomFor returns (and
// fitBounds snap to the same 0.25 grid) instead of Leaflet's coarse integer
// default — the world leg lands ~120° visible instead of z2's 171° Europe-crop.
const MAP_OPTIONS = Object.freeze({
  zoomControl: false, dragging: false, scrollWheelZoom: false,
  doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  zoomSnap: 0.25,
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

// Per-leg captions swapped into the figcaption element.
const WORLD_CAPTION = "Where in the world?";
const COUNTRY_CAPTION = "Up close";

// Cadence (ms): a leg = fly (Leaflet easing) then hold; the chain alternates
// world↔country, so a full loop is 2×(FLY+HOLD) ≈ 10s. FLY_S is the same value
// in seconds handed to flyTo/flyToBounds `duration`.
const FLY_S = 2.6;
const FLY_MS = 2600;
const HOLD_MS = 2400;
const LEG_MS = FLY_MS + HOLD_MS;

// Module-level handles so destroy is idempotent across every phase edge.
let map = null;
// The answer-country marker, kept so the game-over recap rotation can MOVE it
// (setLatLng) instead of rebuilding the map each 5s cycle (see updateRevealMaps).
let marker = null;
let mapContainer = null; // element ref, so destroy can clear the box it filled
let captionContainer = null; // figcaption ref, so destroy can reset the caption
let spec = null; // the live spec, read by the leg chooser + re-aim path
let rafId = 0; // handle of the pending double-rAF build (0 = none scheduled)
let legTimer = 0; // handle of the pending cycle leg (0 = none); only ever one
let buildToken = 0; // bumped by destroy; the deferred build + every leg bail if it moved

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
function clearLegTimer() {
  if (legTimer) clearTimeout(legTimer);
  legTimer = 0;
}

function reducedMotion() {
  return !!(globalThis.matchMedia &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Build the ONE reveal map for the answer ISO. Idempotent-safe: any prior map is
 * torn down first. Offline (no globalThis.L) → a one-line placeholder in the
 * element instead of a map (decorative, matches GeoParty degradation). A spec
 * that comes back null (unknown iso / missing table) also degrades to the
 * placeholder rather than throwing. On success, starts the pulse at the WORLD leg
 * (fresh context → the up-close detail narrates better after it) — unless
 * prefers-reduced-motion, which lands on a static country-leg framing.
 */
export function renderRevealMaps({ mapEl, captionEl, iso2, table }) {
  destroyRevealMaps();
  if (!mapEl) return;
  mapContainer = mapEl;
  captionContainer = captionEl || null;

  const L = leaflet();
  if (!L) {
    setPlaceholder(mapEl);
    return;
  }

  const resolved = revealMapSpec(iso2, table);
  if (!resolved) {
    setPlaceholder(mapEl);
    return;
  }
  spec = resolved;

  // Defer the actual build until the just-unhidden container has a real layout
  // (see the module header). A double rAF crosses one full layout pass; the token
  // captured here lets a destroy that lands in between abort the build cleanly.
  const myToken = buildToken;
  cancelPendingBuild();
  rafId = raf(() => {
    rafId = raf(() => {
      rafId = 0;
      if (myToken !== buildToken) return; // torn down before we ran
      if (!mapEl.isConnected) return; // element gone
      buildMap(L, mapEl, myToken);
    });
  });
}

/**
 * Re-aim the reveal map at a NEW answer WITHOUT tearing it down, so the game-over
 * recap can rotate it in sync with its 5s card cycle — no per-cycle Leaflet
 * rebuild, hence no flicker and no tile re-fetch. Contract:
 *  - Map live AND no deferred build in flight AND spec resolves → re-aim in
 *    place: invalidateSize (the reveal 25vh → gameOver 20vh flip resized the row
 *    and Leaflet caches the container size until told to re-measure), MOVE the
 *    marker (setLatLng), then restart the pulse at the WORLD leg of the NEW
 *    country (cancel the pending leg first so the old chain can't fire).
 *  - Otherwise → delegate to renderRevealMaps, which destroys-then-builds. That
 *    single fallback covers every not-safely-re-aimable case correctly:
 *      · offline (no globalThis.L) or unknown iso (spec null) → placeholder;
 *      · a deferred build still pending (rafId set) → clean rebuild (the destroy
 *        bumps the token so the in-flight build aborts);
 *      · map not live yet (first call this game-over) → clean build.
 * Reads only its args; no write, no analytics, no consent (passive-TV).
 */
export function updateRevealMaps({ mapEl, captionEl, iso2, table }) {
  if (!mapEl) return;

  const L = leaflet();
  const resolved = L ? revealMapSpec(iso2, table) : null;
  if (!L || !resolved || rafId || !map) {
    renderRevealMaps({ mapEl, captionEl, iso2, table });
    return;
  }

  // Map live and settled → re-aim in place. Cancel the in-flight leg FIRST: the
  // old chain guards on buildToken (unchanged here), so without this its pending
  // setTimeout would still fire and fight the new country's pulse.
  clearLegTimer();
  spec = resolved;
  mapContainer = mapEl;
  captionContainer = captionEl || null;

  map.invalidateSize();
  if (marker) marker.setLatLng(spec.world.marker);
  else marker = L.circleMarker(spec.world.marker, MARKER_STYLE).addTo(map);

  // Restart the choreography on the new country, from the WORLD leg.
  startMotion(buildToken);
}

// The deferred build proper. Runs only once the container is laid out, so Leaflet
// measures the real size. Sets the initial framing, then one frame later
// re-measures and kicks off the motion (belt-and-braces against a late layout
// shift). Guarded by `myToken` throughout — a phase edge (destroy) between
// scheduling and here makes this a no-op.
function buildMap(L, mapEl, myToken) {
  map = L.map(mapEl, MAP_OPTIONS);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(map);
  // Initial framing = the world leg (fresh world context). The marker sits on the
  // centroid and stays there for BOTH legs — it never moves during the pulse.
  const [center, zoom] = worldView(mapEl);
  map.setView(center, zoom);
  marker = L.circleMarker(spec.world.marker, MARKER_STYLE).addTo(map);

  // Belt and braces: re-measure and start the motion one frame later so a late
  // layout shift can never leave a stale framing (the field bug's core cause).
  // Store this rAF's id in rafId so updateRevealMaps's `rafId` guard sees the
  // in-flight build (a re-aim landing in this one-frame window would otherwise be
  // reverted) and cancelPendingBuild()/destroy can cancel it. Clear rafId FIRST
  // inside the callback so the settled state reads as no-pending-build.
  rafId = raf(() => {
    rafId = 0;
    if (myToken !== buildToken || !map) return;
    map.invalidateSize();
    startMotion(myToken);
  });
}

// Choose motion vs. static, then drive it. reduced-motion → a single static
// country-leg framing + "Up close" caption, no timers (house convention). Normal
// → start the alternating pulse at the WORLD leg.
function startMotion(token) {
  if (!map) return;
  clearLegTimer();
  if (reducedMotion()) {
    setCaption(COUNTRY_CAPTION);
    map.fitBounds(countryBounds(), fitOpts(spec.borders, mapContainer));
    return;
  }
  leg(token, "world");
}

// One leg of the pulse: swap the caption, fly to this leg's framing, then chain
// the OTHER leg after fly + hold. Token-checked so a teardown/re-aim between
// schedule and fire drops the stale leg silently.
function leg(token, which) {
  if (token !== buildToken || !map) return;
  if (which === "world") {
    setCaption(WORLD_CAPTION);
    const [center, zoom] = worldView(mapContainer);
    map.flyTo(center, zoom, { duration: FLY_S });
  } else {
    setCaption(COUNTRY_CAPTION);
    map.flyToBounds(countryBounds(), { ...fitOpts(spec.borders, mapContainer), duration: FLY_S });
  }
  legTimer = setTimeout(() => {
    legTimer = 0;
    leg(token, which === "world" ? "country" : "world");
  }, LEG_MS);
}

// The world-leg framing: the spec's centroid at the width-aware ~120° zoom.
function worldView(el) {
  return [spec.world.center, worldZoomFor((el && el.clientWidth) || 0, spec.world.spanDeg)];
}

// The country-leg framing: the verbatim whole-country bbox as Leaflet bounds.
// bounds is [minLng, minLat, maxLng, maxLat] → Leaflet [[south, west], [north, east]].
function countryBounds() {
  const b = spec.borders.bounds;
  return leaflet().latLngBounds([b[1], b[0]], [b[3], b[2]]);
}

// fitBounds options from the spec's pad fraction: symmetric pixel padding around
// the verbatim bbox so the country's neighbors stay in view, capped at maxZoom.
function fitOpts(borders, el) {
  const pad = borders.pad || 0;
  const px = [((el && el.clientWidth) || 0) * pad, ((el && el.clientHeight) || 0) * pad];
  return { maxZoom: borders.maxZoom, paddingTopLeft: px, paddingBottomRight: px };
}

function setCaption(text) {
  if (captionContainer) captionContainer.textContent = text;
}

function setPlaceholder(el) {
  el.textContent = "Map unavailable offline";
  el.classList.add("tv-map-offline");
}

/**
 * Tear the map down and clear its container. Idempotent — safe to call twice and
 * on every phase edge (screen-flag.js calls it on every non-reveal snapshot).
 * Bumps the build token (so a deferred build already in flight aborts AND every
 * scheduled cycle leg bails), cancels the pending double-rAF build, and clears
 * the pending cycle leg so nothing fires after teardown.
 */
export function destroyRevealMaps() {
  buildToken++;
  cancelPendingBuild();
  clearLegTimer();
  if (map) {
    try { map.remove(); } catch { /* already gone */ }
    map = null;
  }
  // The marker dies with the map (map.remove() drops all layers); clear the ref
  // so a stale handle can't leak into the next build's setLatLng.
  marker = null;
  spec = null;
  // Clear whatever we put in the box (a built map's leftover DOM or an offline
  // placeholder) so the next reveal starts from a clean container, and reset the
  // caption to its world-leg default.
  if (mapContainer) {
    mapContainer.textContent = "";
    mapContainer.classList.remove("tv-map-offline");
  }
  if (captionContainer) captionContainer.textContent = WORLD_CAPTION;
  mapContainer = null;
  captionContainer = null;
}
