// tests/daily.test.js — the pure Daily Challenge logic (js/daily.js). Date-key,
// seed and day-number determinism; the streak fold; the run fold + scoring; the
// replay lock; and the deterministic day-flag sequence. Node's node:test, pure
// module (no DOM, no network).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dailyKey,
  dailySeed,
  dailyNumber,
  daysBetweenKeys,
  dailyFlags,
  dailyFlagSeed,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  correctRounds,
  nextStreak,
  loadDailyResult,
  loadLastResult,
  saveDailyResult,
  DAILY_ROUNDS,
  DAILY_STEPS,
  DAILY_EPOCH_KEY,
  DAILY_EASY_ROUNDS,
} from "../js/daily.js";
import { scoreRing } from "../js/flag.js";

// A pool larger than DAILY_ROUNDS so the day-sequence is a real subset.
const POOL = [
  { iso2: "br", name: "Brazil", tier: "easy", eligible: true },
  { iso2: "us", name: "United States", tier: "easy", eligible: true },
  { iso2: "fr", name: "France", tier: "world", eligible: true },
  { iso2: "de", name: "Germany", tier: "world", eligible: true },
  { iso2: "jp", name: "Japan", tier: "world", eligible: true },
  { iso2: "ke", name: "Kenya", tier: "world", eligible: true },
  { iso2: "ro", name: "Romania", tier: "expert", eligible: true },
  { iso2: "td", name: "Chad", tier: "expert", eligible: true },
];

// iso2 → tier, for asserting the curated easy-first allocation.
const TIER_OF = Object.fromEntries(POOL.map((p) => [p.iso2, p.tier]));

// A localStorage-shaped stub.
function fakeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// ---------------------------------------------------------------------------
// Date key / seed / number
// ---------------------------------------------------------------------------
test("dailyKey is the local YYYYMMDD, zero-padded", () => {
  assert.equal(dailyKey(new Date(2026, 7, 23)), "20260823"); // Aug = month 7
  assert.equal(dailyKey(new Date(2026, 0, 5)), "20260105");
});

test("dailySeed is namespaced (never collides with a room code)", () => {
  assert.equal(dailySeed("20260823"), "flagdaily-20260823");
});

test("dailyNumber counts days from the epoch, 1-based", () => {
  assert.equal(dailyNumber(DAILY_EPOCH_KEY), 1);
  assert.equal(dailyNumber("20260824"), 2);
  assert.equal(dailyNumber("20260902"), 11);
});

test("daysBetweenKeys is DST-immune calendar arithmetic", () => {
  assert.equal(daysBetweenKeys("20260823", "20260824"), 1);
  assert.equal(daysBetweenKeys("20260823", "20260826"), 3);
  assert.equal(daysBetweenKeys("20260823", "20260823"), 0);
  assert.equal(daysBetweenKeys(null, "20260823"), Infinity);
});

// ---------------------------------------------------------------------------
// The day's flags (deterministic, comparable)
// ---------------------------------------------------------------------------
test("dailyFlags is deterministic and DAILY_ROUNDS long", () => {
  const a = dailyFlags("20260823", POOL);
  const b = dailyFlags("20260823", POOL);
  assert.deepEqual(a, b);
  assert.equal(a.length, DAILY_ROUNDS);
  // Distinct days generally differ in order.
  const c = dailyFlags("20260824", POOL);
  assert.notDeepEqual(a, c);
});

test("dailyFlags entries are all from the eligible pool, no repeats", () => {
  const seq = dailyFlags("20260823", POOL);
  const isos = new Set(POOL.map((p) => p.iso2));
  assert.equal(new Set(seq).size, seq.length, "no repeats");
  for (const iso of seq) assert.ok(isos.has(iso));
});

test("dailyFlags is curated easy-first: 2 easy openers, then world", () => {
  for (const key of ["20260823", "20260824", "20260901", "20261231"]) {
    const seq = dailyFlags(key, POOL);
    const tiers = seq.map((iso) => TIER_OF[iso]);
    assert.equal(seq.length, DAILY_ROUNDS, `${key}: full day`);
    assert.deepEqual(
      tiers.slice(0, DAILY_EASY_ROUNDS),
      Array(DAILY_EASY_ROUNDS).fill("easy"),
      `${key}: rounds 1–${DAILY_EASY_ROUNDS} are easy tier`
    );
    assert.deepEqual(
      tiers.slice(DAILY_EASY_ROUNDS),
      Array(DAILY_ROUNDS - DAILY_EASY_ROUNDS).fill("world"),
      `${key}: the remaining rounds are world tier`
    );
  }
});

test("dailyFlags never serves an expert flag", () => {
  for (const key of ["20260823", "20260824", "20260825", "20260826"]) {
    const seq = dailyFlags(key, POOL);
    for (const iso of seq) assert.notEqual(TIER_OF[iso], "expert", `${key}/${iso}`);
  }
});

// The shipped pool has 40 easy flags — far more than the day needs. The tier
// quota must cap the easy draw at DAILY_EASY_ROUNDS, not fill the whole day
// from a large easy tier ("he explicitly does NOT want it too easy").
test("dailyFlags caps the easy draw when the easy tier is large", () => {
  const bigPool = [
    ...Array.from({ length: 20 }, (_, i) => ({
      iso2: `e${String(i).padStart(2, "0")}`,
      tier: "easy",
      eligible: true,
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      iso2: `w${String(i).padStart(2, "0")}`,
      tier: "world",
      eligible: true,
    })),
  ];
  const tierOf = Object.fromEntries(bigPool.map((p) => [p.iso2, p.tier]));
  const seq = dailyFlags("20260823", bigPool);
  assert.equal(seq.length, DAILY_ROUNDS);
  assert.equal(
    seq.filter((iso) => tierOf[iso] === "easy").length,
    DAILY_EASY_ROUNDS,
    "exactly DAILY_EASY_ROUNDS easy flags"
  );
  assert.equal(
    seq.filter((iso) => tierOf[iso] === "world").length,
    DAILY_ROUNDS - DAILY_EASY_ROUNDS,
    "the rest are world"
  );
  assert.equal(new Set(seq).size, seq.length, "no repeats");
});

test("dailyFlags ignores eligible:false entries", () => {
  const pool = POOL.map((p) =>
    p.iso2 === "fr" ? { ...p, eligible: false } : p
  );
  for (const key of ["20260823", "20260824", "20260825"]) {
    assert.ok(!dailyFlags(key, pool).includes("fr"), `${key}: fr excluded`);
  }
});

// Defensive only: the shipped pool always fills both quotas. A thin easy tier
// borrows from world rather than handing daily-ui a short day.
test("dailyFlags still returns a full day when a tier is too thin", () => {
  const thin = POOL.filter((p) => p.tier === "world" || p.iso2 === "br");
  const seq = dailyFlags("20260823", thin);
  assert.equal(seq.length, DAILY_ROUNDS);
  assert.equal(seq[0], "br", "the one easy flag still opens");
  assert.equal(new Set(seq).size, seq.length, "no repeats");
});

test("dailyFlagSeed is stable per (day, round)", () => {
  assert.equal(dailyFlagSeed("20260823", 1), dailyFlagSeed("20260823", 1));
  assert.notEqual(dailyFlagSeed("20260823", 1), dailyFlagSeed("20260823", 2));
});

// ---------------------------------------------------------------------------
// The run fold + scoring
// ---------------------------------------------------------------------------
test("recordDailyRound scores a correct ring by its step, misses zero", () => {
  let run = newDailyRun("20260823");
  run = recordDailyRound(run, { correct: true, atStep: 1 });
  run = recordDailyRound(run, { correct: true, atStep: 8 });
  run = recordDailyRound(run, { correct: false });
  assert.equal(run.rounds.length, 3);
  assert.equal(run.rounds[0].points, scoreRing(1, DAILY_STEPS));
  assert.equal(run.rounds[1].points, scoreRing(8, DAILY_STEPS));
  assert.equal(run.rounds[2].points, 0);
  assert.equal(run.rounds[2].atStep, null);
  assert.equal(run.score, scoreRing(1, DAILY_STEPS) + scoreRing(8, DAILY_STEPS));
});

test("recordDailyRound never mutates its input run", () => {
  const run = newDailyRun("20260823");
  const next = recordDailyRound(run, { correct: true, atStep: 2 });
  assert.equal(run.rounds.length, 0);
  assert.equal(run.score, 0);
  assert.notEqual(next, run);
});

test("dailyRunComplete + correctRounds", () => {
  let run = newDailyRun("20260823");
  for (let i = 0; i < DAILY_ROUNDS; i++) {
    run = recordDailyRound(run, { correct: i % 2 === 0, atStep: 3 });
  }
  assert.ok(dailyRunComplete(run));
  assert.equal(correctRounds(run), 3); // rounds 0,2,4 correct
});

// ---------------------------------------------------------------------------
// Streak fold
// ---------------------------------------------------------------------------
test("nextStreak: first run is 1", () => {
  assert.equal(nextStreak(null, "20260823"), 1);
  assert.equal(nextStreak({ streak: 5 }, "20260823"), 1); // no key → treated as first
});

test("nextStreak: a consecutive day extends", () => {
  assert.equal(nextStreak({ key: "20260822", streak: 3 }, "20260823"), 4);
});

test("nextStreak: a missed day resets to 1", () => {
  assert.equal(nextStreak({ key: "20260820", streak: 3 }, "20260823"), 1);
});

test("nextStreak: same-day re-entry keeps the stored streak", () => {
  assert.equal(nextStreak({ key: "20260823", streak: 3 }, "20260823"), 3);
});

// ---------------------------------------------------------------------------
// Replay lock
// ---------------------------------------------------------------------------
test("loadDailyResult locks to today's board only", () => {
  const s = fakeStorage();
  const run = { ...newDailyRun("20260823"), score: 500, streak: 2 };
  saveDailyResult(s, run);
  assert.deepEqual(loadDailyResult(s, "20260823"), run);
  assert.equal(loadDailyResult(s, "20260824"), null, "yesterday's board ≠ today");
});

test("loadLastResult returns the stored board regardless of day (streak read)", () => {
  const s = fakeStorage();
  const run = { ...newDailyRun("20260822"), score: 900, streak: 4 };
  saveDailyResult(s, run);
  assert.equal(loadDailyResult(s, "20260823"), null); // not today
  assert.deepEqual(loadLastResult(s), run); // but still readable for the streak
});

test("a tampered / empty board reads as unplayed", () => {
  assert.equal(loadDailyResult(fakeStorage(), "20260823"), null);
  assert.equal(
    loadDailyResult(fakeStorage({ flagreveal_daily_result: "{not json" }), "20260823"),
    null
  );
});
