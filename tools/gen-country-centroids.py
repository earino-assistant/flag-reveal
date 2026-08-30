#!/usr/bin/env python3
"""Generate data/country-centroids.json for Flag Reveal's TV reveal maps.

For every iso2 in data/flags.json, emit
    { "iso2": { "c": [lat, lng], "b": [minLng, minLat, maxLng, maxLat] }, ... }

`c` is the LARGEST polygon ring's shoelace-area centroid (a marker point that
always lands on land — the whole-multipolygon centroid could fall in the sea
between islands, and would put the US in the Pacific / Russia near lng=0). `c`
drives BOTH map markers and the world-view center.

`b` is the WHOLE-multipolygon bbox (all rings) so the up-close map frames the
entire country, not just its largest island (New Zealand spans both islands,
etc.). Antimeridian crossers whose auto bbox spans >200° of longitude are a
projection artifact (a ring clamped at ±180): they MUST appear in the override
table below (verified whole-country frames) or generation FAILS.

Countries missing from NE 110m (microstates / small islands) use a verbatim
hand-set table below.

Stdlib only. Reads NE from GitHub raw. Fails (nonzero exit) unless all iso2s
in flags.json are covered, and prints the count on success.
"""

import json
import os
import sys
import urllib.request

NE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_110m_admin_0_countries.geojson"
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FLAGS_JSON = os.path.join(ROOT, "data", "flags.json")
OUT_JSON = os.path.join(ROOT, "data", "country-centroids.json")

# iso2s present in flags.json but MISSING from NE 110m (33 microstates/islands).
# `c` is [lat, lng]; `b` a small square around it (±0.5°). Verbatim from the
# impl brief — do not edit without re-checking against flags.json.
HAND_SET = {
    "ad": [42.5, 1.6], "ag": [17.06, -61.8], "bb": [13.19, -59.54],
    "bh": [26.03, 50.55], "bm": [32.3, -64.76], "cv": [15.1, -23.6],
    "dm": [15.42, -61.34], "fm": [6.9, 158.2], "fo": [62.0, -6.8],
    "gd": [12.1, -61.7], "gi": [36.14, -5.35], "hk": [22.3, 114.17],
    "ki": [1.87, -157.36], "km": [-11.7, 43.25], "kn": [17.32, -62.75],
    "lc": [13.9, -60.97], "li": [47.15, 9.55], "mc": [43.73, 7.42],
    "mh": [7.09, 171.38], "mt": [35.94, 14.38], "mu": [-20.28, 57.57],
    "mv": [3.2, 73.22], "nr": [-0.52, 166.93], "pw": [7.5, 134.5],
    "sc": [-4.68, 55.49], "sg": [1.35, 103.82], "sm": [43.94, 12.45],
    "st": [0.24, 6.6], "to": [-21.18, -175.2], "tv": [-8.52, 179.2],
    "va": [41.90, 12.45], "vc": [13.25, -61.19], "ws": [-13.75, -172.1],
}

HALF = 0.5  # ±degrees for the hand-set square bbox

# A whole-multipolygon bbox wider than this in longitude can only be an
# antimeridian artifact (a ring clamped at ±180), never a real country extent.
DATELINE_SPAN = 200.0

# Verified whole-country frames, [minLng, minLat, maxLng, maxLat]. ru/us are
# antimeridian/overseas fixed extents (cited from Natural Earth): ru clamps its
# east edge just shy of the dateline; us is CONUS-only ([-125, 24.5, -66.9, 49.5]
# — no Alaska/Hawaii; the marker stays on the mainland centroid). fr/no are
# METROPOLITAN overrides (owner-flagged ocean-heavy "Up close" frames): the auto
# whole-multipolygon bbox drags in an overseas territory (French Guiana for fr,
# Svalbard for no) that makes the up-close map mostly ocean — these frame the
# European mainland only. All apply BEFORE the >200° dateline detector.
BBOX_OVERRIDE = {
    "ru": [19.0, 41.0, 179.9, 81.9],
    "us": [-125.0, 24.5, -66.9, 49.5],
    "fr": [-5.1, 41.3, 9.6, 51.1],  # metropolitan France — French Guiana out of frame
    "no": [4.2, 57.9, 31.2, 71.3],  # mainland Norway — Svalbard out of frame
}

# Crossers we frame with a small ±FRAME_HALF° box around the largest-ring centroid
# (`c`) instead of a fixed extent — the main islands sit comfortably in view.
# `ki` is hand-set (absent from NE 110m) so it never reaches the detector; listed
# for completeness. Populated by inspecting which >200°-span iso2s the run reports.
BBOX_C_FRAME = {"fj", "ki"}
FRAME_HALF = 1.5


def round4(x):
    return round(x, 4)


def ring_area(ring):
    """Signed shoelace area of a ring of [lng, lat] pairs (x=lng, y=lat)."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        a += x1 * y2 - x2 * y1
    return a * 0.5


def ring_centroid(ring):
    """Shoelace centroid of a ring → (lat, lng). Falls back to the vertex mean
    for a degenerate (zero-area) ring."""
    a = ring_area(ring)
    if a == 0:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return (sum(ys) / len(ys), sum(xs) / len(xs))
    cx = 0.0
    cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    cx /= 6 * a
    cy /= 6 * a
    return (cy, cx)  # (lat, lng)


def ring_bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return [min(xs), min(ys), max(xs), max(ys)]  # [minLng, minLat, maxLng, maxLat]


def whole_bbox(geometry):
    """Bounding box over the exterior rings of EVERY polygon in a Polygon or
    MultiPolygon geometry (the whole country, not its largest island).
    Returns [minLng, minLat, maxLng, maxLat], or None for an unusable geometry."""
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        return None
    min_lng = min_lat = float("inf")
    max_lng = max_lat = float("-inf")
    for poly in polygons:
        if not poly:
            continue
        for x, y in ((p[0], p[1]) for p in poly[0]):
            if x < min_lng:
                min_lng = x
            if x > max_lng:
                max_lng = x
            if y < min_lat:
                min_lat = y
            if y > max_lat:
                max_lat = y
    if min_lng == float("inf"):
        return None
    return [min_lng, min_lat, max_lng, max_lat]


def largest_ring(geometry):
    """The exterior ring of the largest polygon (by |area|) in a Polygon or
    MultiPolygon geometry."""
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    polygons = []
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        return None
    best = None
    best_area = -1.0
    for poly in polygons:
        if not poly:
            continue
        exterior = poly[0]
        area = abs(ring_area(exterior))
        if area > best_area:
            best_area = area
            best = exterior
    return best


def iso_of(props):
    """NE ISO_A2_EH, fallback ISO_A2; the string '-99' means no-match."""
    for key in ("ISO_A2_EH", "ISO_A2"):
        v = props.get(key)
        if v and v != "-99":
            return str(v).lower()
    return None


def main():
    with open(FLAGS_JSON, encoding="utf-8") as f:
        flags = json.load(f)
    required = [e["iso2"] for e in flags]

    print(f"Fetching Natural Earth 110m admin-0 countries…", file=sys.stderr)
    with urllib.request.urlopen(NE_URL) as resp:
        ne = json.load(resp)

    from_ne = {}
    for feat in ne.get("features", []):
        props = feat.get("properties") or {}
        iso2 = iso_of(props)
        if not iso2:
            continue
        geometry = feat.get("geometry") or {}
        ring = largest_ring(geometry)
        bbox = whole_bbox(geometry)
        if not ring or not bbox:
            continue
        lat, lng = ring_centroid(ring)
        from_ne[iso2] = {"c": [lat, lng], "b": bbox}

    out = {}
    wide_uncovered = []
    for iso2 in required:
        if iso2 in from_ne:
            c = from_ne[iso2]["c"]
            b = list(from_ne[iso2]["b"])
            if iso2 in BBOX_OVERRIDE:
                # A verified whole-country frame replaces the artifact bbox.
                b = list(BBOX_OVERRIDE[iso2])
            elif (b[2] - b[0]) > DATELINE_SPAN:
                # Antimeridian artifact: only allowed if we hand-frame it.
                if iso2 in BBOX_C_FRAME:
                    lat, lng = c
                    b = [lng - FRAME_HALF, lat - FRAME_HALF,
                         lng + FRAME_HALF, lat + FRAME_HALF]
                else:
                    wide_uncovered.append(iso2)
                    continue
            out[iso2] = {
                "c": [round4(c[0]), round4(c[1])],
                "b": [round4(v) for v in b],
            }
        elif iso2 in HAND_SET:
            lat, lng = HAND_SET[iso2]
            out[iso2] = {
                "c": [round4(lat), round4(lng)],
                "b": [
                    round4(lng - HALF), round4(lat - HALF),
                    round4(lng + HALF), round4(lat + HALF),
                ],
            }

    if wide_uncovered:
        print(
            f"ERROR: {len(wide_uncovered)} iso2(s) have a >{DATELINE_SPAN:.0f}° "
            f"longitude bbox (antimeridian artifact) and are not in the override "
            f"table: {sorted(wide_uncovered)}",
            file=sys.stderr,
        )
        return 1

    missing = [iso2 for iso2 in required if iso2 not in out]
    if missing:
        print(f"ERROR: {len(missing)} iso2(s) uncovered: {missing}", file=sys.stderr)
        return 1

    # Deterministic key order (iso2-ascending), stable diffs.
    ordered = {k: out[k] for k in sorted(out.keys())}
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    print(f"{len(ordered)}/{len(required)} centroids written to {OUT_JSON}")
    # Sanity lines (impl brief): the dateline crossers now have sane frames, and
    # nz spans BOTH islands (~lng 166–179), not just the largest.
    for iso2 in ("ru", "us", "nz", "fr", "no"):
        if iso2 in ordered:
            print(f"  {iso2}: b={ordered[iso2]['b']}")
    if "mt" in ordered:
        print(f"  mt: c={ordered['mt']['c']} b={ordered['mt']['b']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
