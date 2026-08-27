// daily.js — pure Daily Challenge logic for Flag Reveal. A date-seeded, solo,
// single-device run of DAILY_ROUNDS flags: the seed is derived from the LOCAL
// calendar date (Wordle's rule — your "today" is your local midnight, not
// UTC's), so everyone playing on a given day walks the same shuffled flag
// order and their scores are comparable and shareable. No DOM, no network in
// here — the browser glue lives in daily-ui.js, and the deterministic PRNG,
// reveal plan and scoring all come from the already-tested pure core in
// flag.js (mulberry32 / shuffle / revealPlan / scoreRing). The day's flag
// sequence is the Daily's own curated easy-first allocation (see dailyFlags).
//
// This mirrors GeoParty's daily.js, adapted from "guess a place on a map" to
// "name the country from a half-revealed flag": a round's quality is the STEP
// at which the player rang it (earlier = worth more), not a distance.

import { hash, hashSeed, mulberry32, scoreRing, shuffle } from "./flag.js";

/* ================================================================
 * The fixed rules. Comparable scores need identical rules for every
 * player, so nothing here is host-configurable: five flags, the
 * standard 8-step reveal, the party game's own scoreRing table.
 * ================================================================ */

export const DAILY_ROUNDS = 5;
export const DAILY_STEPS = 8;          // the reveal depth (flag.js STEPS default)

// The Daily does NOT run on a party difficulty setting. It is a curated
// easy-first sequence — "feel smart, then stretch": the first
// DAILY_EASY_ROUNDS flags are drawn from the `easy` TIER, the rest from the
// `world` TIER (2 easy + 3 world at DAILY_ROUNDS = 5). Expert is never in the
// Daily. Drawing per tier is why this can't go through eligiblePool: the
// difficulty SETTINGS are easy/default/hard/everything, so `world` there would
// fall back to `default` (easy + world) and not isolate the tier at all.
export const DAILY_EASY_ROUNDS = 2;           // rounds 1–2 are easy-tier
export const DAILY_TIERS = ["easy", "world"]; // rounds 3–5 are world-tier

// Daily #1. The number is a day counter, not a date — "Daily #12" is what the
// share card brags, exactly like Wordle's puzzle number. Flag Reveal's daily
// launches with v0.2.
export const DAILY_EPOCH_KEY = "20260823";

/* ================================================================
 * Date key -> seed -> day number
 * ================================================================ */

// Local-date key, e.g. "20260823". Everything daily hangs off this string.
export function dailyKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${m}${d}`;
}

// The gameFlags seed for a day. Namespaced ("flagdaily-") so a daily order can
// never collide with a real room's random gameSeed, and so it is distinct from
// GeoParty's own "daily-" namespace on the shared analytics backend.
export function dailySeed(key) {
  return `flagdaily-${key}`;
}

// Parse a "YYYYMMDD" key as a UTC midnight — calendar-day arithmetic without
// DST surprises (local DST days are 23/25h; UTC days never are).
function keyToUtcMs(key) {
  return Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8));
}

// "Daily #N": days since the epoch, 1-based. Pre-epoch clocks go ≤ 0 —
// harmless (the seed, not the number, picks the flags).
export function dailyNumber(key) {
  return Math.round((keyToUtcMs(key) - keyToUtcMs(DAILY_EPOCH_KEY)) / 86_400_000) + 1;
}

// Whole calendar days from key `a` to key `b` (b − a), both parsed as UTC
// midnights so DST-length local days can't skew the count. Exported for the
// streak fold: a gap of 1 is consecutive days, ≥2 is a broken streak, ≤0 is a
// same-day re-entry or a backwards clock. Empty/undefined `a` returns Infinity
// — the "first ever run" sentinel the fold reads as a fresh streak.
export function daysBetweenKeys(a, b) {
  if (!a || !b) return Infinity;
  return Math.round((keyToUtcMs(b) - keyToUtcMs(a)) / 86_400_000);
}

/* ================================================================
 * The day's flags. Deterministic from the date-seed + the shared
 * pool, so every device on a given day gets the same five flags in
 * the same order — and each flag's own reveal (tile order + blur) is
 * seeded off (dailySeed, roundNumber) exactly like the party game.
 * ================================================================ */

// The DAILY_ROUNDS iso2 codes for a day, in play order: a per-tier allocation
// rather than one flat shuffle of the whole easy+world pool. Each tier is
// ISO-sorted before its seeded shuffle (canonical order, independent of
// flags.json's own ordering — §8.1), and both tiers draw from ONE rng stream,
// so a day is fully determined by its date seed. Repeat-free by construction:
// each tier is shuffled without replacement and the tiers are disjoint.
export function dailyFlags(key, pool) {
  const rng = mulberry32(hashSeed(dailySeed(key)));
  const eligible = (pool || []).filter((e) => e && e.eligible !== false);
  const quota = [DAILY_EASY_ROUNDS, DAILY_ROUNDS - DAILY_EASY_ROUNDS];
  const seq = [];
  const spare = [];
  DAILY_TIERS.forEach((tier, i) => {
    const tierPool = eligible
      .filter((e) => e.tier === tier)
      .slice()
      .sort((a, b) => (a.iso2 < b.iso2 ? -1 : a.iso2 > b.iso2 ? 1 : 0));
    const drawn = shuffle(tierPool, rng).map((e) => e.iso2);
    seq.push(...drawn.slice(0, quota[i]));
    spare.push(...drawn.slice(quota[i]));
  });
  // A tier too small to fill its quota (never true for the shipped pool: 40
  // easy, 98 world) borrows the other Daily tier's leftovers rather than
  // handing daily-ui a short day. Clamped to DAILY_ROUNDS either way.
  return seq.concat(spare).slice(0, DAILY_ROUNDS);
}

// Round `n` (1-based) reveal seed for a day — the same (seed, number) folding
// the party game uses, so a daily reveal is authored identically.
export function dailyFlagSeed(key, number) {
  return hash(dailySeed(key), number);
}

/* ================================================================
 * The run: a fold over rounds. Same scorer as the party game
 * (scoreRing on the step the player rang), so a daily point means
 * exactly what a party point means.
 * ================================================================ */

// A fresh run for a day. score accumulates; rounds is the per-flag log.
export function newDailyRun(key) {
  return { key, score: 0, rounds: [] };
}

// Lock one round into the run. `result` is { correct, atStep } — atStep is the
// reveal step the player rang at (1..DAILY_STEPS). A wrong/never-rung round is
// { correct:false } and scores zero (a forfeit, like a party bust). Returns a
// NEW run; the input is never mutated.
export function recordDailyRound(run, result) {
  const correct = !!(result && result.correct);
  const atStep = result && typeof result.atStep === "number" ? result.atStep : null;
  const points = correct && atStep != null ? scoreRing(atStep, DAILY_STEPS) : 0;
  const entry = { correct, atStep: correct ? atStep : null, points };
  return {
    ...run,
    score: run.score + points,
    rounds: [...run.rounds, entry],
  };
}

export function dailyRunComplete(run) {
  return !!run && run.rounds.length >= DAILY_ROUNDS;
}

// Rounds the player actually named (feeds daily_completed's `correct`).
export function correctRounds(run) {
  return run && run.rounds ? run.rounds.filter((r) => r && r.correct).length : 0;
}

/* ================================================================
 * Streak. A run carries the streak it earned, so tomorrow's run reads
 * yesterday's streak straight off the saved board (no separate ledger).
 * ================================================================ */

// The streak a run played on `todayKey` earns, given the previously stored run
// (any day). First ever run → 1; a consecutive day → +1; a missed day (or a
// backwards clock) → reset to 1; a same-day re-entry keeps the stored streak.
export function nextStreak(prev, todayKey) {
  if (!prev || !prev.key) return 1;
  const gap = daysBetweenKeys(prev.key, todayKey);
  if (gap === 0) return prev.streak || 1; // same-day (the lock normally blocks this)
  if (gap === 1) return (prev.streak || 0) + 1;
  return 1;
}

/* ================================================================
 * Replay lock: one scored run per day per device. A single slot —
 * yesterday's board is superseded, so nothing accumulates. (A mid-run
 * refresh restarts the run; the flags are deterministic anyway, and
 * devtools-grade honesty is not a threat model we carry.)
 * ================================================================ */

export const DAILY_RESULT_KEY = "flagreveal_daily_result";

// The raw stored board (any day), validated, or null. Shared by the lock check
// (loadDailyResult) and the streak fold (which needs yesterday's board).
function readStored(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(DAILY_RESULT_KEY));
    if (
      parsed &&
      typeof parsed.key === "string" &&
      typeof parsed.score === "number" &&
      Array.isArray(parsed.rounds)
    ) {
      return parsed;
    }
  } catch {
    /* private mode / tampered — treat as no board */
  }
  return null;
}

// The lock: today's board iff it exists (the run was already played today),
// else null ("not played yet"). Anything from another day reads as unplayed.
export function loadDailyResult(storage, key) {
  const stored = readStored(storage);
  return stored && stored.key === key ? stored : null;
}

// The streak-continuity read: whatever board is stored, regardless of day.
export function loadLastResult(storage) {
  return readStored(storage);
}

export function saveDailyResult(storage, run) {
  try {
    storage.setItem(DAILY_RESULT_KEY, JSON.stringify(run));
  } catch {
    /* private mode: today just won't be remembered */
  }
}
