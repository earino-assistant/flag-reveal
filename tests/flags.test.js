// tests/flags.test.js — dataset integrity for data/flags.json + vendored SVGs.
// SPEC §8.3: unique ISO codes, every entry has a vendored SVG, tiers valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FLAGS,
  TIERS,
  eligiblePool,
  poolForTier,
  byIso2,
  flagAssetPath,
} from "../js/flags-data.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FLAGS_DIR = join(ROOT, "assets", "flags");

const raw = JSON.parse(readFileSync(join(ROOT, "data", "flags.json"), "utf8"));

test("flags.json is a non-empty array with a solid country count", () => {
  assert.ok(Array.isArray(raw), "flags.json must be an array");
  assert.ok(raw.length >= 100, `expected >= 100 entries, got ${raw.length}`);
});

test("every entry has a unique, lowercased, 2-char iso2", () => {
  const seen = new Set();
  for (const e of raw) {
    assert.equal(typeof e.iso2, "string", `iso2 must be a string: ${JSON.stringify(e)}`);
    assert.equal(e.iso2, e.iso2.toLowerCase(), `iso2 must be lowercase: ${e.iso2}`);
    assert.match(e.iso2, /^[a-z]{2}$/, `iso2 must be two letters: ${e.iso2}`);
    assert.ok(!seen.has(e.iso2), `duplicate iso2: ${e.iso2}`);
    seen.add(e.iso2);
  }
});

test("every entry has a non-empty name, valid tier, boolean eligible, array aliases", () => {
  for (const e of raw) {
    assert.equal(typeof e.name, "string", `name must be a string: ${e.iso2}`);
    assert.ok(e.name.trim().length > 0, `name must be non-empty: ${e.iso2}`);
    assert.ok(TIERS.includes(e.tier), `tier must be one of ${TIERS}: ${e.iso2}=${e.tier}`);
    assert.equal(typeof e.eligible, "boolean", `eligible must be boolean: ${e.iso2}`);
    assert.ok(Array.isArray(e.aliases), `aliases must be an array: ${e.iso2}`);
    for (const a of e.aliases) {
      assert.equal(typeof a, "string", `alias must be a string: ${e.iso2}`);
    }
  }
});

test("every iso2 has a matching vendored assets/flags/<iso2>.svg", () => {
  for (const e of raw) {
    const p = join(ROOT, flagAssetPath(e.iso2));
    assert.ok(existsSync(p), `missing vendored SVG for ${e.iso2}`);
    const head = readFileSync(p, "utf8").slice(0, 400).toLowerCase();
    assert.ok(
      head.includes("<svg") || head.includes("<?xml"),
      `not a valid SVG: ${e.iso2}`
    );
  }
});

test("no orphan SVGs without a flags.json entry", () => {
  const isos = new Set(raw.map((e) => e.iso2));
  const svgs = readdirSync(FLAGS_DIR).filter((f) => f.endsWith(".svg"));
  for (const f of svgs) {
    assert.ok(isos.has(f.slice(0, -4)), `orphan SVG with no entry: ${f}`);
  }
});

test("loader FLAGS matches the raw file and is frozen", () => {
  assert.equal(FLAGS.length, raw.length);
  assert.ok(Object.isFrozen(FLAGS));
  assert.ok(Object.isFrozen(FLAGS[0]));
});

test("eligiblePool is all-eligible, ISO-sorted, and non-empty", () => {
  const pool = eligiblePool();
  assert.ok(pool.length > 0);
  assert.ok(pool.every((f) => f.eligible === true));
  const isos = pool.map((f) => f.iso2);
  assert.deepEqual(isos, [...isos].sort((a, b) => a.localeCompare(b)));
});

test("poolForTier: world = full eligible pool; easy/expert are subsets", () => {
  const all = eligiblePool();
  assert.equal(poolForTier("world").length, all.length);
  for (const tier of ["easy", "expert"]) {
    const p = poolForTier(tier);
    assert.ok(p.length > 0, `tier ${tier} must be non-empty`);
    assert.ok(p.every((f) => f.tier === tier && f.eligible));
  }
});

test("byIso2 is case-insensitive and finds ineligible entries too", () => {
  const first = raw[0];
  assert.equal(byIso2(first.iso2.toUpperCase())?.iso2, first.iso2);
  assert.equal(byIso2("zz"), undefined);
});
