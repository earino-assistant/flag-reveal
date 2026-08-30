// tv-maps.js — thin Leaflet glue for the TV's two reveal maps (mirrors
// GeoParty's js/revealmap-ui.js). Every DECISION lives in the pure
// revealMapSpec (js/flag.js); this module only executes it: it builds two
// L.maps, drops a circleMarker on the answer country's centroid, sets the
// world view / fits the borders bbox, nudges Leaflet's size pass once the
// containers are visible, and tears everything down safely.
//
// Zero product decisions beyond what the spec dict carries. No analytics, no
// consent import, no Firebase — the TV stays passive (it writes only its
// heartbeat, owned by screen-flag.js). Reads nothing beyond its args.
//
// Leaflet is a page global (the pinned <script> in screen.html, same as
// GeoParty). Read it lazily so the module imports cleanly in Node (tests).

import { revealMapSpec } from "./flag.js";

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

// The answer-country marker: a small filled circle in the accent color. Concrete
// hex — CSS var() strings don't resolve inside Leaflet's SVG marker attrs.
const MARKER_STYLE = Object.freeze({
  radius: 8, color: "#ffcf3f", weight: 2, fillColor: "#ffcf3f", fillOpacity: 0.6,
});

// Module-level handles so destroy is idempotent across every phase edge.
let worldMap = null;
let bordersMap = null;
let containers = []; // element refs, so destroy can clear the boxes it filled
const timers = new Set();

function later(fn, ms) {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
  return id;
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

  // Map 1 — "Where on Earth": zoomed-out world context with a marker.
  worldMap = L.map(worldEl, MAP_OPTIONS);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(worldMap);
  worldMap.setView(spec.world.center, spec.world.zoom);
  L.circleMarker(spec.world.marker, MARKER_STYLE).addTo(worldMap);

  // Map 2 — "Up close": framed to the country's main-polygon bbox (capped zoom);
  // OSM tiles draw the borders in detail (no GeoJSON vendored). bounds is the
  // verbatim [minLng, minLat, maxLng, maxLat] — convert to Leaflet's
  // [[south, west], [north, east]].
  const b = spec.borders.bounds;
  const llBounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
  bordersMap = L.map(bordersEl, MAP_OPTIONS);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(bordersMap);
  bordersMap.fitBounds(llBounds, { maxZoom: spec.borders.maxZoom });
  L.circleMarker(spec.borders.marker, MARKER_STYLE).addTo(bordersMap);

  // Leaflet needs a size pass once the container is actually visible (the
  // GeoParty pitfall). Guarded — the maps may be gone by the time it fires.
  later(() => {
    if (worldMap) worldMap.invalidateSize({ pan: false });
    if (bordersMap) bordersMap.invalidateSize({ pan: false });
  }, 80);
}

function setPlaceholder(el) {
  el.textContent = "Map unavailable offline";
  el.classList.add("tv-map-offline");
}

/**
 * Tear both maps down and clear their containers. Idempotent — safe to call
 * twice and on every phase edge (screen-flag.js calls it on every non-reveal
 * snapshot). Cancels any pending size-nudge timer.
 */
export function destroyRevealMaps() {
  for (const id of timers) clearTimeout(id);
  timers.clear();
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
