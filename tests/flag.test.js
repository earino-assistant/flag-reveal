// tests/flag.test.js — unit tests for the pure module js/flag.js.
// Node's built-in runner: `npm test` → node --test "tests/*.test.js".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  gameFlags,
  flagForRound,
  revealPlan,
  exposedAt,
  chooseOptions,
  choiceUnlocked,
  scoreRing,
  normalizeName,
  normalizeAnswer,
  buildAnswerIndex,
  resolveOutcome,
  advanceState,
  roundConduct,
  gameWinner,
  carryStandings,
  versionCompatible,
  hash,
} from "../js/flag.js";

// A small fixture pool covering tiers, aliases, diacritics, the "Congo"
// collision, and an explicitly ineligible entry.
const POOL = [
  { iso2: "BR", name: "Brazil", aliases: [], tier: "easy", eligible: true },
  { iso2: "US", name: "United States", aliases: ["USA", "America"], tier: "easy", eligible: true },
  { iso2: "FR", name: "France", aliases: [], tier: "world", eligible: true },
  { iso2: "DE", name: "Germany", aliases: [], tier: "world", eligible: true },
  { iso2: "CI", name: "Côte d'Ivoire", aliases: ["Ivory Coast"], tier: "world", eligible: true },
  { iso2: "CG", name: "Congo - Rep.", aliases: ["Congo"], tier: "world", eligible: true },
  { iso2: "CD", name: "Congo - Dem. Rep.", aliases: ["Congo", "DR Congo"], tier: "world", eligible: true },
  { iso2: "TD", name: "Chad", aliases: [], tier: "expert", eligible: true },
  { iso2: "RO", name: "Romania", aliases: [], tier: "expert", eligible: true },
  { iso2: "XX", name: "Testland", aliases: [], tier: "world", eligible: false },
];

// eligible "world" pool = every eligible entry (any tier) → 9 (XX excluded).
const WORLD_SIZE = 9;

// ---------------------------------------------------------------------------
// scoreRing
// ---------------------------------------------------------------------------
test("scoreRing: full default step table", () => {
  const expected = [1000, 875, 750, 625, 500, 375, 250, 125];
  for (let step = 1; step <= 8; step++) {
    assert.equal(scoreRing(step, 8, 1000, 100), expected[step - 1]);
  }
});

test("scoreRing: min floor binds under a non-default config", () => {
  // base 200, steps 8, step 8 → round(200*1/8)=25, floored to min 100.
  assert.equal(scoreRing(8, 8, 200, 100), 100);
  // defaults never hit the floor.
  assert.equal(scoreRing(8), 125);
});

// ---------------------------------------------------------------------------
// gameFlags
// ---------------------------------------------------------------------------
test("gameFlags: deterministic for the same seed", () => {
  const a = gameFlags("seed-1", 5, "world", POOL);
  const b = gameFlags("seed-1", 5, "world", POOL);
  assert.deepEqual(a, b);
});

test("gameFlags: different seeds generally differ", () => {
  const a = gameFlags("seed-1", WORLD_SIZE, "world", POOL);
  const b = gameFlags("seed-2", WORLD_SIZE, "world", POOL);
  assert.notDeepEqual(a, b);
});

test("gameFlags: repeat-free within a game", () => {
  const seq = gameFlags("seed-1", WORLD_SIZE, "world", POOL);
  assert.equal(new Set(seq).size, seq.length);
});

test("gameFlags: excludes ineligible entries", () => {
  const seq = gameFlags("seed-1", 50, "world", POOL);
  assert.ok(!seq.includes("XX"));
});

test("gameFlags: easy-first guard — easy game opens on an easy-tier flag", () => {
  const easyIsos = new Set(POOL.filter((e) => e.tier === "easy").map((e) => e.iso2));
  for (const seed of ["a", "b", "c", "d", "e"]) {
    const seq = gameFlags(seed, 2, "easy", POOL);
    assert.ok(easyIsos.has(seq[0]), `first flag ${seq[0]} should be easy-tier`);
    // easy difficulty only yields easy-tier flags
    for (const iso of seq) assert.ok(easyIsos.has(iso));
  }
});

test("gameFlags: clamps roundCount larger than the pool (no crash)", () => {
  const seq = gameFlags("seed-1", 1000, "world", POOL);
  assert.equal(seq.length, WORLD_SIZE);
});

// ---------------------------------------------------------------------------
// flagForRound
// ---------------------------------------------------------------------------
test("flagForRound: matches gameFlags[number-1] and a stable flagSeed", () => {
  const cfg = { difficulty: "world", roundCount: 10 };
  const seq = gameFlags("seed-1", Math.min(10, WORLD_SIZE), "world", POOL);
  const r2 = flagForRound(cfg, "seed-1", 2, POOL);
  assert.equal(r2.answerIso, seq[1]);
  assert.equal(r2.flagSeed, hash("seed-1", 2));
  // re-derivable (owner-refresh property)
  assert.deepEqual(flagForRound(cfg, "seed-1", 2, POOL), r2);
});

// ---------------------------------------------------------------------------
// revealPlan / exposedAt
// ---------------------------------------------------------------------------
test("revealPlan: tileOrder covers gridN² tiles, blur has `steps` entries", () => {
  const plan = revealPlan(hash("s", 1), 8, 4);
  assert.equal(plan.tileOrder.length, 16);
  assert.equal(new Set(plan.tileOrder).size, 16); // a permutation
  assert.equal(plan.blur.length, 8);
});

test("revealPlan: blur is monotonically decreasing, 20 → 0", () => {
  const plan = revealPlan(hash("s", 1), 8, 4);
  assert.equal(plan.blur[0], 20);
  assert.equal(plan.blur[plan.blur.length - 1], 0);
  for (let i = 1; i < plan.blur.length; i++) {
    assert.ok(plan.blur[i] < plan.blur[i - 1], "blur must strictly decrease");
  }
});

test("revealPlan: deterministic for the same flagSeed", () => {
  assert.deepEqual(revealPlan(1234, 8, 4), revealPlan(1234, 8, 4));
});

test("exposedAt: cumulative reveal partitions into `steps` groups", () => {
  const plan = revealPlan(hash("s", 1), 8, 4);
  // full flag by the final step
  assert.equal(exposedAt(plan, 8).tiles.length, 16);
  // strictly non-decreasing cumulative counts, +2 per step at 16/8
  let prev = 0;
  for (let step = 1; step <= 8; step++) {
    const n = exposedAt(plan, step).tiles.length;
    assert.ok(n >= prev);
    prev = n;
  }
  assert.equal(exposedAt(plan, 4).tiles.length, 8);
  // clamps
  assert.equal(exposedAt(plan, 0).tiles.length, 0);
  assert.equal(exposedAt(plan, 99).tiles.length, 16);
  assert.equal(exposedAt(plan, 8).blurPx, 0);
});

// ---------------------------------------------------------------------------
// chooseOptions
// ---------------------------------------------------------------------------
test("chooseOptions: 4 options, contains the answer exactly once, deterministic", () => {
  const seed = hash("s", 3);
  const opts = chooseOptions(seed, "FR", POOL);
  assert.equal(opts.length, 4);
  assert.equal(opts.filter((o) => o === "FR").length, 1);
  assert.equal(new Set(opts).size, 4); // no duplicate distractors
  assert.deepEqual(chooseOptions(seed, "FR", POOL), opts); // identical on every device
});

// ---------------------------------------------------------------------------
// normalization + answer index
// ---------------------------------------------------------------------------
test("normalizeName: case, diacritics, apostrophes, leading 'the'", () => {
  assert.equal(normalizeName("  Côte d'Ivoire "), "cote divoire");
  assert.equal(normalizeName("The United States"), "united states");
  assert.equal(normalizeName("BRAZIL"), "brazil");
  assert.equal(normalizeName("Guinea-Bissau"), "guinea bissau");
});

test("normalizeAnswer: matches canonical name or alias, folded", () => {
  assert.equal(normalizeAnswer("côte d'ivoire", "CI", ["Côte d'Ivoire", "Ivory Coast"]), true);
  assert.equal(normalizeAnswer("The United States", "US", ["United States", "USA"]), true);
  assert.equal(normalizeAnswer("america", "US", ["United States", "USA", "America"]), true);
  assert.equal(normalizeAnswer("germany", "US", ["United States", "USA"]), false);
});

test("buildAnswerIndex: normalized keys map to iso[], Congo collision is an array", () => {
  const idx = buildAnswerIndex(POOL);
  assert.deepEqual(idx.get("brazil"), ["BR"]);
  assert.deepEqual(idx.get("usa"), ["US"]);
  const congo = idx.get("congo");
  assert.ok(Array.isArray(congo));
  assert.equal(congo.length, 2);
  assert.ok(congo.includes("CG") && congo.includes("CD"));
});

// ---------------------------------------------------------------------------
// resolveOutcome
// ---------------------------------------------------------------------------
function baseRoundActive() {
  return {
    phase: "roundActive",
    round: {
      number: 3,
      flagSeed: 123,
      answerIso: "FR",
      startedAt: 1000,
      currentStep: 2,
      stepStartedAt: 1500,
      // outcome ABSENT (unresolved)
      private: {
        t2: { lockedRound: 3, wrongIso: "BE", wrongStep: 1 }, // current round
        t3: { lockedRound: 2, wrongIso: "NL", wrongStep: 4 }, // STALE straggler
      },
      results: {},
    },
    teams: {
      t1: { name: "A", total: 500 },
      t2: { name: "B", total: 200 },
      t3: { name: "C", total: 0 },
    },
  };
}

const CFG = { steps: 8, base: 1000, min: 100, now: 10000, autoAdvanceMs: 15000 };

test("resolveOutcome win: winner settles, others zero, totals absolute, atStep from snapshot", () => {
  const gs = resolveOutcome(baseRoundActive(), { kind: "win", team: "t1", roundNumber: 3 }, CFG);
  assert.equal(gs.phase, "reveal");
  assert.deepEqual(gs.round.outcome, { kind: "win", team: "t1", atStep: 2 });
  // atStep = snapshot currentStep (2) → 875 points
  assert.equal(gs.round.results.t1.correct, true);
  assert.equal(gs.round.results.t1.atStep, 2);
  assert.equal(gs.round.results.t1.points, 875);
  assert.equal(gs.round.results.t1.rangOut, false);
  // absolute total = prior 500 + 875
  assert.equal(gs.teams.t1.total, 1375);
  assert.equal(gs.teams.t1.reachedTotalAt, 3);
  // other teams zero, totals untouched
  assert.equal(gs.round.results.t2.correct, false);
  assert.equal(gs.round.results.t2.points, 0);
  assert.equal(gs.teams.t2.total, 200);
  // S6 fields authored from cfg.now
  assert.equal(gs.round.revealAt, 10000);
  assert.equal(gs.round.autoAdvanceAt, 25000);
  // private is dropped from the replacement state
  assert.equal(gs.round.private, undefined);
});

test("resolveOutcome win: lockedRound filter — current discloses, stale does not", () => {
  const gs = resolveOutcome(baseRoundActive(), { kind: "win", team: "t1", roundNumber: 3 }, CFG);
  // t2 rang wrong THIS round → disclosed
  assert.equal(gs.round.results.t2.rangOut, true);
  assert.equal(gs.round.results.t2.wrongIso, "BE");
  assert.equal(gs.round.results.t2.wrongStep, 1);
  // t3's private is a stale straggler (lockedRound 2 !== 3) → NOT disclosed
  assert.equal(gs.round.results.t3.rangOut, false);
  assert.equal(gs.round.results.t3.wrongIso, undefined);
  assert.equal(gs.round.results.t3.wrongStep, undefined);
});

test("resolveOutcome win: aborts on null state / stale round / already resolved", () => {
  assert.equal(resolveOutcome(null, { kind: "win", team: "t1", roundNumber: 3 }, CFG), undefined);
  // stale round number
  assert.equal(
    resolveOutcome(baseRoundActive(), { kind: "win", team: "t1", roundNumber: 2 }, CFG),
    undefined
  );
  // already resolved (non-null outcome)
  const resolved = baseRoundActive();
  resolved.round.outcome = { kind: "win", team: "t2", atStep: 1 };
  assert.equal(
    resolveOutcome(resolved, { kind: "win", team: "t1", roundNumber: 3 }, CFG),
    undefined
  );
  // wrong phase
  const reveal = baseRoundActive();
  reveal.phase = "reveal";
  assert.equal(
    resolveOutcome(reveal, { kind: "win", team: "t1", roundNumber: 3 }, CFG),
    undefined
  );
});

test("resolveOutcome bust: all zero, no total change, disclosures still filtered", () => {
  const gs = resolveOutcome(baseRoundActive(), { kind: "bust", roundNumber: 3 }, CFG);
  assert.equal(gs.phase, "reveal");
  assert.deepEqual(gs.round.outcome, { kind: "bust" });
  for (const t of ["t1", "t2", "t3"]) {
    assert.equal(gs.round.results[t].correct, false);
    assert.equal(gs.round.results[t].points, 0);
  }
  // totals unchanged
  assert.equal(gs.teams.t1.total, 500);
  assert.equal(gs.teams.t2.total, 200);
  assert.equal(gs.teams.t3.total, 0);
  // disclosure filter still applies on bust
  assert.equal(gs.round.results.t2.rangOut, true);
  assert.equal(gs.round.results.t3.rangOut, false);
});

test("resolveOutcome: does not mutate the input gameState", () => {
  const gs = baseRoundActive();
  const snapshot = JSON.parse(JSON.stringify(gs));
  resolveOutcome(gs, { kind: "win", team: "t1", roundNumber: 3 }, CFG);
  assert.deepEqual(gs, snapshot);
});

// ---------------------------------------------------------------------------
// advanceState
// ---------------------------------------------------------------------------
// roundCount 3 → effective 3 (world pool has 9); so round 3's reveal → gameOver.
const ADV_CFG = { gameSeed: "seed-1", difficulty: "world", roundCount: 3, target: 0, pool: POOL, now: 5000 };

test("advanceState: lobby → round 1", () => {
  const gs = { phase: "lobby", teams: { t1: { total: 0 } } };
  const next = advanceState(gs, 0, ADV_CFG);
  assert.equal(next.phase, "roundActive");
  assert.equal(next.round.number, 1);
  assert.ok(next.round.answerIso);
  assert.equal(next.round.currentStep, 1);
  assert.deepEqual(next.round.private, {});
  assert.deepEqual(next.round.results, {});
  assert.equal(next.round.outcome, undefined); // absent, not null
});

test("advanceState: reveal → next round", () => {
  const gs = {
    phase: "reveal",
    round: { number: 1, outcome: { kind: "bust" } },
    teams: { t1: { total: 0 } },
  };
  const next = advanceState(gs, 1, ADV_CFG);
  assert.equal(next.phase, "roundActive");
  assert.equal(next.round.number, 2);
  const expected = flagForRound(ADV_CFG, "seed-1", 2, POOL);
  assert.equal(next.round.answerIso, expected.answerIso);
});

test("advanceState: reveal → gameOver when round budget is spent", () => {
  const gs = {
    phase: "reveal",
    round: { number: 3, outcome: { kind: "win", team: "t1", atStep: 1 } },
    teams: { t1: { total: 1000 }, t2: { total: 500 } },
  };
  const next = advanceState(gs, 3, ADV_CFG);
  assert.equal(next.phase, "gameOver");
});

test("advanceState: reveal → gameOver when target reached", () => {
  const cfg = { ...ADV_CFG, roundCount: 100, target: 900 };
  const gs = {
    phase: "reveal",
    round: { number: 2, outcome: { kind: "win", team: "t1", atStep: 1 } },
    teams: { t1: { total: 950 }, t2: { total: 300 } },
  };
  assert.equal(advanceState(gs, 2, cfg).phase, "gameOver");
});

test("advanceState: idempotent / epoch-guarded aborts", () => {
  // null state
  assert.equal(advanceState(null, 0, ADV_CFG), undefined);
  // already advanced past lobby
  const active = { phase: "roundActive", round: { number: 1 }, teams: {} };
  assert.equal(advanceState(active, 0, ADV_CFG), undefined);
  // reveal but stale fromRound
  const reveal = { phase: "reveal", round: { number: 2, outcome: { kind: "bust" } }, teams: {} };
  assert.equal(advanceState(reveal, 1, ADV_CFG), undefined);
  // reveal but unresolved outcome
  const unresolved = { phase: "reveal", round: { number: 2 }, teams: {} };
  assert.equal(advanceState(unresolved, 2, ADV_CFG), undefined);
});

// ---------------------------------------------------------------------------
// roundConduct
// ---------------------------------------------------------------------------
const RC_CFG = { steps: 8, stepMs: 1500, graceMs: 3000 };

test("roundConduct: owner busts on step completion + grace, not before", () => {
  const gs = {
    phase: "roundActive",
    round: { number: 1, currentStep: 8, startedAt: 0, stepStartedAt: 1000 },
    teams: {},
  };
  // grace not elapsed
  assert.equal(roundConduct(gs, 1000 + 2999, true, RC_CFG), "continue");
  // grace elapsed
  assert.equal(roundConduct(gs, 1000 + 3000, true, RC_CFG), "resolve-bust");
  // owner does NOT bust before the final step
  const early = { ...gs, round: { ...gs.round, currentStep: 5 } };
  assert.equal(roundConduct(early, 1e9, true, RC_CFG), "continue");
});

test("roundConduct: non-owner uses the server-corrected dead-man deadline", () => {
  const gs = {
    phase: "roundActive",
    round: { number: 1, currentStep: 3, startedAt: 1000, stepStartedAt: 2000 },
    teams: {},
  };
  // deadline = 1000 + 8*1500 + 3*3000 = 22000
  assert.equal(roundConduct(gs, 21999, false, RC_CFG), "continue");
  assert.equal(roundConduct(gs, 22000, false, RC_CFG), "resolve-bust");
});

test("roundConduct: reveal-phase advance — owner at autoAdvanceAt, non-owner +3·grace", () => {
  const gs = {
    phase: "reveal",
    round: { number: 1, outcome: { kind: "bust" }, autoAdvanceAt: 5000 },
    teams: {},
  };
  assert.equal(roundConduct(gs, 4999, true, RC_CFG), "continue");
  assert.equal(roundConduct(gs, 5000, true, RC_CFG), "advance");
  // non-owner waits +3*3000
  assert.equal(roundConduct(gs, 5000 + 8999, false, RC_CFG), "continue");
  assert.equal(roundConduct(gs, 5000 + 9000, false, RC_CFG), "advance");
});

test("roundConduct: a held reveal (autoAdvanceAt null) never auto-advances", () => {
  const gs = {
    phase: "reveal",
    round: { number: 1, outcome: { kind: "bust" }, autoAdvanceAt: null },
    teams: {},
  };
  assert.equal(roundConduct(gs, 1e9, true, RC_CFG), "continue");
  assert.equal(roundConduct(gs, 1e9, false, RC_CFG), "continue");
});

test("roundConduct: resolved roundActive / lobby / null → continue", () => {
  assert.equal(roundConduct(null, 0, true, RC_CFG), "continue");
  assert.equal(roundConduct({ phase: "lobby" }, 0, true, RC_CFG), "continue");
  const resolved = {
    phase: "roundActive",
    round: { number: 1, currentStep: 8, startedAt: 0, stepStartedAt: 0, outcome: { kind: "win", team: "t1", atStep: 1 } },
    teams: {},
  };
  assert.equal(roundConduct(resolved, 1e9, true, RC_CFG), "continue");
});

test("roundConduct: NEVER reads round/private (§5.2 contract)", () => {
  // A private that throws if touched — roundConduct must not access it.
  const mkRound = (extra) => {
    const r = { number: 1, currentStep: 8, startedAt: 0, stepStartedAt: 0, autoAdvanceAt: 0, ...extra };
    Object.defineProperty(r, "private", {
      get() {
        throw new Error("roundConduct read round/private");
      },
      enumerable: true,
    });
    return r;
  };
  assert.doesNotThrow(() =>
    roundConduct({ phase: "roundActive", round: mkRound(), teams: {} }, 1e9, true, RC_CFG)
  );
  assert.doesNotThrow(() =>
    roundConduct({ phase: "roundActive", round: mkRound(), teams: {} }, 1e9, false, RC_CFG)
  );
  assert.doesNotThrow(() =>
    roundConduct(
      { phase: "reveal", round: mkRound({ outcome: { kind: "bust" } }), teams: {} },
      1e9,
      false,
      RC_CFG
    )
  );
});

// ---------------------------------------------------------------------------
// gameWinner / carryStandings
// ---------------------------------------------------------------------------
test("gameWinner: highest total wins", () => {
  const teams = { t1: { total: 500 }, t2: { total: 900 }, t3: { total: 100 } };
  assert.equal(gameWinner(teams), "t2");
});

test("gameWinner: tie on total → fewer rounds to reach it", () => {
  const teams = {
    t1: { total: 1000, reachedTotalAt: 5 },
    t2: { total: 1000, reachedTotalAt: 3 },
    t3: { total: 500 },
  };
  assert.equal(gameWinner(teams), "t2");
});

test("gameWinner: tie on total and rounds → lowest slot id", () => {
  const teams = {
    t2: { total: 1000, reachedTotalAt: 4 },
    t1: { total: 1000, reachedTotalAt: 4 },
  };
  assert.equal(gameWinner(teams), "t1");
});

test("gameWinner: empty → null", () => {
  assert.equal(gameWinner({}), null);
});

test("carryStandings: zeroes totals by default, sets hostTeam, preserves identity", () => {
  const teams = {
    t1: { name: "A", deviceId: "d1", total: 100, reachedTotalAt: 2 },
    t2: { name: "B", deviceId: "d2", total: 50 },
  };
  const { teams: out, hostTeam } = carryStandings(teams, "t2");
  assert.equal(hostTeam, "t2");
  assert.equal(out.t1.total, 0);
  assert.equal(out.t2.total, 0);
  assert.equal(out.t1.reachedTotalAt, undefined);
  assert.equal(out.t1.name, "A");
  assert.equal(out.t1.deviceId, "d1");
});

test("carryStandings: carries totals for a season when cfg.carry", () => {
  const teams = { t1: { total: 100 }, t2: { total: 50 } };
  const { teams: out } = carryStandings(teams, "t1", { carry: true });
  assert.equal(out.t1.total, 100);
  assert.equal(out.t2.total, 50);
});

// ---------------------------------------------------------------------------
// choiceUnlocked / versionCompatible
// ---------------------------------------------------------------------------
test("choiceUnlocked: gated on choiceUnlockStep", () => {
  assert.equal(choiceUnlocked(4, { choiceUnlockStep: 5 }), false);
  assert.equal(choiceUnlocked(5, { choiceUnlockStep: 5 }), true);
  assert.equal(choiceUnlocked(6, { choiceUnlockStep: 5 }), true);
});

test("versionCompatible: both dataset and rules versions must match", () => {
  const bundled = { datasetVersion: "1.0.0", rulesVersion: "3.1" };
  assert.equal(versionCompatible({ datasetVersion: "1.0.0", rulesVersion: "3.1" }, bundled), true);
  assert.equal(versionCompatible({ datasetVersion: "1.0.1", rulesVersion: "3.1" }, bundled), false);
  assert.equal(versionCompatible({ datasetVersion: "1.0.0", rulesVersion: "3.0" }, bundled), false);
  assert.equal(versionCompatible(null, bundled), false);
});
