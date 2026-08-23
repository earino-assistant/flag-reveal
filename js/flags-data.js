// js/flags-data.js — pure dataset loader + helpers for Flag Reveal.
//
// No DOM, no network, no Firebase — this is the unit-tested data layer that
// sits alongside `js/flag.js`. It reads the vendored `data/flags.json`
// (derived from mledoze/countries, ODbL — see data/ATTRIBUTION.md) and exposes
// small pure helpers for pool selection. Flag images are vendored SVGs under
// `assets/flags/<iso2>.svg`.
//
// `flags.json` shape: { iso2, name, aliases:[], tier, eligible }[]

import flags from "../data/flags.json" with { type: "json" };

export const TIERS = Object.freeze(["easy", "world", "expert"]);

// The full immutable dataset, exactly as authored (ISO-ascending, SPEC §8.1).
export const FLAGS = Object.freeze(flags.map(Object.freeze));

/** Relative path to a country's vendored flag SVG (no leading slash). */
export function flagAssetPath(iso2) {
  return `assets/flags/${String(iso2).toLowerCase()}.svg`;
}

/** All guessable (eligible) entries, canonically ISO-sorted (SPEC §8.1). */
export function eligiblePool() {
  return FLAGS.filter((f) => f.eligible)
    .slice()
    .sort((a, b) => a.iso2.localeCompare(b.iso2));
}

/**
 * The eligible pool for a difficulty tier.
 * `world` is the default mixed pool = every eligible entry (all tiers).
 * `easy` / `expert` narrow to entries of that recognizability tier.
 */
export function poolForTier(tier) {
  const pool = eligiblePool();
  if (tier === "world") return pool;
  return pool.filter((f) => f.tier === tier);
}

/** Look up a single entry by iso2 (case-insensitive), or undefined. */
export function byIso2(iso2) {
  const k = String(iso2).toLowerCase();
  return FLAGS.find((f) => f.iso2 === k);
}
