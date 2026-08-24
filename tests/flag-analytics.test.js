// tests/flag-analytics.test.js — unit tests for the pure analytics-emission
// decision logic in js/flag-analytics.js. These helpers own the at-most-once /
// dedup gates that used to live untested inline in flag-ui.js; the UI now keeps
// only the side effects (mutating the seen-set, calling track()).

import { test } from "node:test";
import assert from "node:assert/strict";

import { ringEmission, revealEmission } from "../js/flag-analytics.js";

// A representative ambient state for a single phone/round.
const RING_STATE = {
  ringed: new Set(),
  mode: "phone",
  team: "t2",
  difficulty: "world",
  inputMode: "choice",
  roundKey: "RK1",
};

// ---------------------------------------------------------------------------
// ringEmission — dedup on (roundKey, correct); full props shape.
// ---------------------------------------------------------------------------
test("ringEmission: first ring emits with the full flag_ring props", () => {
  const out = ringEmission(RING_STATE, {
    correct: true,
    contested: false,
    atStep: 4,
    points: 625,
  });
  assert.equal(out.emit, true);
  assert.equal(out.key, "RK1:1");
  assert.deepEqual(out.props, {
    mode: "phone",
    team: "t2",
    atStep: 4,
    correct: true,
    points: 625,
    contested: false,
    difficulty: "world",
    inputMode: "choice",
    roundKey: "RK1",
  });
});

test("ringEmission: a wrong ring keys on correct:0 (distinct from correct:1)", () => {
  const out = ringEmission(RING_STATE, {
    correct: false,
    contested: false,
    atStep: 6,
    points: 0,
  });
  assert.equal(out.key, "RK1:0");
  assert.equal(out.props.correct, false);
  assert.equal(out.props.points, 0);
});

test("ringEmission: a duplicate (roundKey, correct) is suppressed", () => {
  const seen = new Set(["RK1:1"]);
  const out = ringEmission(
    { ...RING_STATE, ringed: seen },
    { correct: true, contested: false, atStep: 2, points: 750 }
  );
  assert.equal(out.emit, false);
  assert.equal(out.props, null);
  // But the OTHER correctness value on the same round still emits.
  const wrong = ringEmission(
    { ...RING_STATE, ringed: seen },
    { correct: false, contested: false, atStep: 2, points: 0 }
  );
  assert.equal(wrong.emit, true);
  assert.equal(wrong.key, "RK1:0");
});

test("ringEmission: accepts an array seen-set as well as a Set", () => {
  const out = ringEmission(
    { ...RING_STATE, ringed: ["RK1:1"] },
    { correct: true, contested: false, atStep: 1, points: 1000 }
  );
  assert.equal(out.emit, false);
});

test("ringEmission: contested correct ring carries contested:true, points 0", () => {
  const out = ringEmission(RING_STATE, {
    correct: true,
    contested: true,
    atStep: 5,
    points: 0,
  });
  assert.equal(out.emit, true);
  assert.equal(out.props.contested, true);
  assert.equal(out.props.points, 0);
});

// ---------------------------------------------------------------------------
// revealEmission — the winner's own ring + the at-most-once flag_round.
// ---------------------------------------------------------------------------
const REVEAL_STATE = {
  myTeam: "t1",
  mode: "tv",
  difficulty: "expert",
  inputMode: "type",
  roundKey: "RK7",
  emittedRounds: new Set(),
  committedOutcome: null,
};

test("revealEmission: winner's own ring is surfaced with its points", () => {
  const { ownRing } = revealEmission(REVEAL_STATE, {
    roundNumber: 7,
    outcome: { kind: "win", team: "t1", atStep: 3 },
    results: { t1: { correct: true, points: 750 } },
  });
  assert.deepEqual(ownRing, { correct: true, contested: false, atStep: 3, points: 750 });
});

test("revealEmission: no own ring when another team won", () => {
  const { ownRing } = revealEmission(REVEAL_STATE, {
    roundNumber: 7,
    outcome: { kind: "win", team: "t2", atStep: 3 },
    results: { t2: { correct: true, points: 750 } },
  });
  assert.equal(ownRing, null);
});

test("revealEmission: flag_round emits only when MY transaction committed", () => {
  const event = {
    roundNumber: 7,
    outcome: { kind: "win", team: "t1", atStep: 3 },
    results: { t1: { correct: true, points: 750 }, t2: { rangOut: true } },
  };
  // Not the committer → no flag_round.
  assert.equal(revealEmission(REVEAL_STATE, event).round, null);
  // The committer for THIS round → emits, with the ringCount fold (2 rings).
  const committed = { ...REVEAL_STATE, committedOutcome: { number: 7, kind: "win" } };
  const { round } = revealEmission(committed, event);
  assert.equal(round.emit, true);
  assert.deepEqual(round.props, {
    mode: "tv",
    outcome: "won",
    winningStep: 3,
    ringCount: 2,
    difficulty: "expert",
    inputMode: "type",
    roundNumber: 7,
    roundKey: "RK7",
  });
});

test("revealEmission: a committed win for a DIFFERENT round does not emit", () => {
  const committed = { ...REVEAL_STATE, committedOutcome: { number: 6, kind: "win" } };
  const { round } = revealEmission(committed, {
    roundNumber: 7,
    outcome: { kind: "win", team: "t1", atStep: 3 },
    results: {},
  });
  assert.equal(round, null);
});

test("revealEmission: at-most-once — an already-emitted roundKey is suppressed", () => {
  const committed = {
    ...REVEAL_STATE,
    committedOutcome: { number: 7, kind: "win" },
    emittedRounds: new Set(["RK7"]),
  };
  const { round } = revealEmission(committed, {
    roundNumber: 7,
    outcome: { kind: "win", team: "t1", atStep: 3 },
    results: {},
  });
  assert.equal(round, null);
});

test("revealEmission: a bust reports outcome 'busted' and null winningStep", () => {
  const committed = { ...REVEAL_STATE, committedOutcome: { number: 7, kind: "bust" } };
  const { ownRing, round } = revealEmission(committed, {
    roundNumber: 7,
    outcome: { kind: "bust" },
    results: { t2: { rangOut: true }, t3: { rangOut: true } },
  });
  assert.equal(ownRing, null); // no winner
  assert.equal(round.props.outcome, "busted");
  assert.equal(round.props.winningStep, null);
  assert.equal(round.props.ringCount, 2);
});

test("revealEmission: ringCount folds correct OR rangOut, ignores idle teams", () => {
  const committed = { ...REVEAL_STATE, committedOutcome: { number: 7, kind: "win" } };
  const { round } = revealEmission(committed, {
    roundNumber: 7,
    outcome: { kind: "win", team: "t1", atStep: 2 },
    results: {
      t1: { correct: true, points: 875 }, // counts
      t2: { rangOut: true }, // counts
      t3: { correct: false, points: 0 }, // idle — does NOT count
      t4: {}, // idle — does NOT count
    },
  });
  assert.equal(round.props.ringCount, 2);
});
