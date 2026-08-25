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
  lockedOutTeams,
  advanceState,
  roundConduct,
  gameWinner,
  celebrationSpec,
  carryStandings,
  shouldFollowRoom,
  versionCompatible,
  hash,
  eligiblePool,
  effectiveRoundCount,
  winAttemptOutcome,
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

// ---------------------------------------------------------------------------
// lockedOutTeams — TV "guessed wrong" hint detection (Item 4)
// ---------------------------------------------------------------------------
test("lockedOutTeams: only CURRENT-round lockouts, sorted, content-free", () => {
  // baseRoundActive has t2 locked THIS round (3) and t3 a stale straggler (2).
  const teams = lockedOutTeams(baseRoundActive().round);
  assert.deepEqual(teams, ["t2"]); // t3's lockedRound 2 !== 3 → excluded
});

test("lockedOutTeams: multiple current lockouts returned sorted", () => {
  const round = {
    number: 5,
    private: {
      t3: { lockedRound: 5, wrongIso: "NL", wrongStep: 2 },
      t1: { lockedRound: 5, wrongIso: "BE", wrongStep: 1 },
      t2: { lockedRound: 4, wrongIso: "DE", wrongStep: 3 }, // stale → excluded
    },
  };
  assert.deepEqual(lockedOutTeams(round), ["t1", "t3"]);
});

test("lockedOutTeams: no private / no round / empty → []", () => {
  assert.deepEqual(lockedOutTeams(null), []);
  assert.deepEqual(lockedOutTeams({ number: 1 }), []);
  assert.deepEqual(lockedOutTeams({ number: 1, private: {} }), []);
  // A reveal round drops `private` entirely → nothing to hint.
  assert.deepEqual(lockedOutTeams({ number: 1, results: {} }), []);
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

// celebrationSpec — the game-over win moment (pure mapping; the DOM/CSS/confetti
// glue in screen-flag.js is UI-only and not unit-tested).
test("celebrationSpec: no win → inert (no burst, no color)", () => {
  const s = celebrationSpec({ won: false });
  assert.equal(s.tier, "none");
  assert.equal(s.winVar, null);
  assert.equal(s.confettiCount, 0);
  assert.equal(s.crown, false);
});

test("celebrationSpec: team win → that slot's color takeover + burst", () => {
  const s = celebrationSpec({ won: true, teamSlot: "t3" });
  assert.equal(s.tier, "win");
  assert.equal(s.winVar, "var(--team-3)");
  assert.ok(s.confettiCount > 0);
  assert.equal(s.crown, true);
});

test("celebrationSpec: champion → gold, louder than a plain win", () => {
  const win = celebrationSpec({ won: true, teamSlot: "t1" });
  const champ = celebrationSpec({ won: true, teamSlot: "t1", champion: true });
  assert.equal(champ.tier, "champion");
  assert.equal(champ.winVar, "var(--accent)");
  assert.ok(champ.confettiCount > win.confettiCount);
  assert.equal(champ.crown, true);
});

test("celebrationSpec: unknown/invalid slot → falls back to gold, never undefined", () => {
  for (const bad of [null, "", "t5", "t0", "tX", "team-2"]) {
    const s = celebrationSpec({ won: true, teamSlot: bad });
    assert.equal(s.winVar, "var(--accent)");
    assert.equal(s.tier, "champion");
  }
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

test("carryStandings: winnerOnly carries only the winner slot (F6)", () => {
  const teams = {
    t1: { name: "A", deviceId: "d1", total: 900, reachedTotalAt: 3 },
    t2: { name: "B", deviceId: "d2", total: 100 },
    t3: { name: "C", deviceId: "d3", total: 50 },
  };
  const { teams: out, hostTeam } = carryStandings(teams, "t1", { winnerOnly: true });
  assert.equal(hostTeam, "t1");
  assert.deepEqual(Object.keys(out), ["t1"]);
  assert.equal(out.t1.total, 0); // fresh game → zeroed
  assert.equal(out.t1.reachedTotalAt, undefined);
  assert.equal(out.t1.deviceId, "d1"); // deviceId preserved for resume
  assert.equal(out.t1.name, "A");
});

test("carryStandings: season overrides winnerOnly — full roster, totals kept", () => {
  // A season's whole point is persisting every team's running total, so dropping
  // non-winner slots would silently lose returning devices' totals: carry wins.
  const teams = { t1: { total: 100 }, t2: { total: 50 }, t3: { total: 200 } };
  const { teams: out } = carryStandings(teams, "t1", {
    carry: true,
    winnerOnly: true,
  });
  assert.deepEqual(Object.keys(out).sort(), ["t1", "t2", "t3"]);
  assert.equal(out.t1.total, 100);
  assert.equal(out.t2.total, 50);
  assert.equal(out.t3.total, 200);
});

// ---------------------------------------------------------------------------
// shouldFollowRoom (TV/subscriber nextRoom follow chain, F3 / SPEC §1530)
// ---------------------------------------------------------------------------
const overRoom = (nextRoom) => ({
  gameState: { phase: "gameOver" },
  nextRoom,
});

test("shouldFollowRoom: follows a valid unvisited pointer on gameOver", () => {
  assert.equal(shouldFollowRoom(overRoom("BCDFGH"), "AAAAAA", new Set()), "BCDFGH");
});

test("shouldFollowRoom: ignores nextRoom === current room", () => {
  assert.equal(shouldFollowRoom(overRoom("AAAAAA"), "AAAAAA", new Set()), null);
});

test("shouldFollowRoom: ignores an invalid nextRoom code", () => {
  assert.equal(shouldFollowRoom(overRoom("bad"), "AAAAAA", new Set()), null);
  assert.equal(shouldFollowRoom(overRoom(undefined), "AAAAAA", new Set()), null);
});

test("shouldFollowRoom: cycle guard — a visited code is never re-followed", () => {
  // A → B → A: with {A, B} already visited, B's pointer back to A returns null.
  const followed = new Set(["AAAAAA", "BCDFGH"]);
  assert.equal(shouldFollowRoom(overRoom("AAAAAA"), "BCDFGH", followed), null);
});

test("shouldFollowRoom: gameOver gate — no follow in lobby/roundActive", () => {
  const room = { gameState: { phase: "lobby" }, nextRoom: "BCDFGH" };
  assert.equal(shouldFollowRoom(room, "AAAAAA", new Set()), null);
  room.gameState.phase = "roundActive";
  assert.equal(shouldFollowRoom(room, "AAAAAA", new Set()), null);
});

test("shouldFollowRoom: null/absent room → null", () => {
  assert.equal(shouldFollowRoom(null, "AAAAAA", new Set()), null);
  assert.equal(shouldFollowRoom({}, "AAAAAA", new Set()), null);
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

// ---------------------------------------------------------------------------
// eligiblePool (now exported) + effectiveRoundCount — the round-budget clamp
// that used to be copy-pasted across flag.js/flag-ui.js/screen-flag.js.
// ---------------------------------------------------------------------------
test("eligiblePool: world = every eligible entry (ineligible dropped)", () => {
  const world = eligiblePool(POOL, "world");
  assert.equal(world.length, WORLD_SIZE);
  assert.ok(!world.some((e) => e.iso2 === "XX")); // explicit eligible:false excluded
});

test("eligiblePool: easy/expert filter to the tier; unknown → mixed pool", () => {
  assert.deepEqual(
    eligiblePool(POOL, "easy").map((e) => e.iso2).sort(),
    ["BR", "US"]
  );
  assert.deepEqual(
    eligiblePool(POOL, "expert").map((e) => e.iso2).sort(),
    ["RO", "TD"]
  );
  // Unknown difficulty falls back to the full mixed pool (documented behavior).
  assert.equal(eligiblePool(POOL, "nonsense").length, WORLD_SIZE);
});

test("eligiblePool: a missing `eligible` flag counts as eligible", () => {
  const pool = [{ iso2: "AA", name: "A", tier: "world" }]; // no eligible key
  assert.equal(eligiblePool(pool, "world").length, 1);
});

test("effectiveRoundCount: clamps roundCount to the eligible pool size", () => {
  // 9 eligible world flags; asking for 20 clamps to 9.
  assert.equal(effectiveRoundCount({ difficulty: "world", roundCount: 20 }, POOL), 9);
  // Asking for fewer than the pool is honored.
  assert.equal(effectiveRoundCount({ difficulty: "world", roundCount: 5 }, POOL), 5);
  // Easy tier has 2 flags; a bigger request clamps to 2.
  assert.equal(effectiveRoundCount({ difficulty: "easy", roundCount: 5 }, POOL), 2);
});

test("effectiveRoundCount: absent roundCount defaults to the whole pool", () => {
  assert.equal(effectiveRoundCount({ difficulty: "world" }, POOL), WORLD_SIZE);
  assert.equal(effectiveRoundCount({ difficulty: "expert" }, POOL), 2);
});

test("effectiveRoundCount: matches gameFlags' own clamp (no phone/TV drift)", () => {
  // The whole point of exporting this: the sequence length and "Round N / M"
  // must agree. gameFlags clamps internally the same way.
  const cfg = { difficulty: "world", roundCount: 100 };
  const seq = gameFlags("seed-x", effectiveRoundCount(cfg, POOL), "world", POOL);
  assert.equal(seq.length, effectiveRoundCount(cfg, POOL));
  assert.equal(seq.length, WORLD_SIZE);
});

// ---------------------------------------------------------------------------
// winAttemptOutcome — the §4.2 win-abort taxonomy as a pure classifier.
// Every branch mirrors a case doWinAttempt handled inline before extraction.
// ---------------------------------------------------------------------------
test("winAttemptOutcome: null snapshot (empty cache) → retry (case a)", () => {
  assert.equal(winAttemptOutcome(null, 3, "t1"), "retry");
});

test("winAttemptOutcome: still live, same round, unresolved → retry (a/b/c)", () => {
  const gs = { phase: "roundActive", round: { number: 3 } }; // outcome absent
  assert.equal(winAttemptOutcome(gs, 3, "t1"), "retry");
});

test("winAttemptOutcome: my own win already committed → won (case e)", () => {
  const gs = { phase: "reveal", round: { number: 3, outcome: { kind: "win", team: "t1" } } };
  assert.equal(winAttemptOutcome(gs, 3, "t1"), "won");
});

test("winAttemptOutcome: a rival's win serialized first → lost (case d)", () => {
  const gs = { phase: "reveal", round: { number: 3, outcome: { kind: "win", team: "t2" } } };
  assert.equal(winAttemptOutcome(gs, 3, "t1"), "lost");
});

test("winAttemptOutcome: the round busted → bust (case f)", () => {
  const gs = { phase: "reveal", round: { number: 3, outcome: { kind: "bust" } } };
  assert.equal(winAttemptOutcome(gs, 3, "t1"), "bust");
});

test("winAttemptOutcome: round genuinely advanced past me → over (case g)", () => {
  // The snapshot has moved on to round 4 (unresolved) — not my round, not retry.
  const gs = { phase: "roundActive", round: { number: 4 } };
  assert.equal(winAttemptOutcome(gs, 3, "t1"), "over");
  // Or advanced to gameOver with no round at all.
  assert.equal(winAttemptOutcome({ phase: "gameOver" }, 3, "t1"), "over");
});
