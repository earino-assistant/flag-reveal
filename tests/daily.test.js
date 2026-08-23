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
