// tests/partyrecap.test.js — unit tests for the pure module js/partyrecap.js,
// the phone game-over round-recap fold + card/guess derivation. The *-ui.js
// wiring (the fold call site, the lobby reset, the card DOM) is thin glue, so
// every decision lives here under test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recordPartyRound,
  partyRecapCards,
  recapTeamResult,
  recapTeamResults,
} from "../js/partyrecap.js";

// A settled reveal round as resolveOutcome leaves it: answerIso/flagSeed plus a
// per-team results map. t1 won at step 3; t2 rang out wrong; t3 never rang.
const winRound = (number, over = {}) => ({
  number,
  answerIso: "fr",
  flagSeed: 12345,
  outcome: { kind: "win", team: "t1", atStep: 3 },
  results: {
    t1: { correct: true, atStep: 3, points: 60, rangOut: false },
    t2: { correct: false, points: 0, rangOut: true, wrongIso: "it", wrongStep: 5 },
    t3: { correct: false, points: 0, rangOut: false },
  },
  ...over,
});

const bustRound = (number, over = {}) => ({
  number,
  answerIso: "jp",
  flagSeed: 999,
  outcome: { kind: "bust" },
  results: {
    t1: { correct: false, points: 0, rangOut: true, wrongIso: "kr", wrongStep: 6 },
    t2: { correct: false, points: 0, rangOut: false },
  },
  ...over,
});

/* ---------------- recordPartyRound ---------------- */

test("recordPartyRound: a win round → one entry carrying answer, seed, results", () => {
  const out = recordPartyRound([], winRound(1), { mode: "party" });
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 1);
  assert.equal(out[0].answerIso, "fr");
  assert.equal(out[0].flagSeed, 12345);
  assert.equal(out[0].mode, "party");
  assert.equal(out[0].results.t1.correct, true);
  assert.equal(out[0].results.t1.atStep, 3);
  assert.equal(out[0].results.t2.rangOut, true);
  assert.equal(out[0].results.t2.wrongIso, "it");
  assert.equal(out[0].results.t2.wrongStep, 5);
});

test("recordPartyRound: idempotent by round number (re-fold on every echo)", () => {
  const one = recordPartyRound([], winRound(1));
  const again = recordPartyRound(one, winRound(1));
  assert.equal(again, one, "same round number → SAME reference, no append");
  assert.equal(again.length, 1);
});

test("recordPartyRound: distinct round numbers accumulate in fold order", () => {
  let h = [];
  h = recordPartyRound(h, winRound(1));
  h = recordPartyRound(h, bustRound(2));
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((e) => e.number), [1, 2]);
});

test("recordPartyRound: never mutates the input array", () => {
  const h0 = [];
  const h1 = recordPartyRound(h0, winRound(1));
  assert.equal(h0.length, 0);
  assert.notEqual(h1, h0);
});

test("recordPartyRound: no round / no number / no answer → unchanged reference", () => {
  const h = [{ number: 1, answerIso: "fr", results: {} }];
  assert.equal(recordPartyRound(h, null), h);
  assert.equal(recordPartyRound(h, { answerIso: "fr" }), h, "missing number");
  assert.equal(recordPartyRound(h, { number: 2 }), h, "missing answerIso");
  assert.equal(recordPartyRound(h, { number: 0, answerIso: "fr" }), h, "number <= 0");
});

test("recordPartyRound: missing results map → empty results, still recorded", () => {
  const out = recordPartyRound([], { number: 1, answerIso: "fr", flagSeed: 1 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].results, {});
});

test("recordPartyRound: non-array history is tolerated", () => {
  const out = recordPartyRound(undefined, winRound(1));
  assert.equal(out.length, 1);
});

/* ---------------- partyRecapCards ---------------- */

test("partyRecapCards: sorted ascending with totalRounds = max number", () => {
  const h = [bustRound(3), winRound(1), bustRound(2)].map((r) => recordPartyRound([], r)[0]);
  const cards = partyRecapCards(h);
  assert.deepEqual(cards.map((c) => c.number), [1, 2, 3]);
  assert.ok(cards.every((c) => c.totalRounds === 3));
});

test("partyRecapCards: empty / nullish in → []", () => {
  assert.deepEqual(partyRecapCards([]), []);
  assert.deepEqual(partyRecapCards(null), []);
  assert.deepEqual(partyRecapCards(undefined), []);
});

test("partyRecapCards: drops malformed entries", () => {
  const cards = partyRecapCards([
    { number: 1, answerIso: "fr", results: {} },
    { number: 0, answerIso: "jp" }, // bad number
    { number: 2 }, // no answer
    null,
  ]);
  assert.deepEqual(cards.map((c) => c.number), [1]);
});

/* ---------------- recapTeamResult ---------------- */

test("recapTeamResult: correct → guessIso is the answer, atStep carried", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  assert.deepEqual(recapTeamResult(card, "t1"), {
    status: "correct",
    guessIso: "fr",
    atStep: 3,
  });
});

test("recapTeamResult: wrong ring → the player's own wrongIso is the guess", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  assert.deepEqual(recapTeamResult(card, "t2"), {
    status: "wrong",
    guessIso: "it",
    atStep: 5,
  });
});

test("recapTeamResult: never rang → missed, no guess to show", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  assert.deepEqual(recapTeamResult(card, "t3"), {
    status: "missed",
    guessIso: null,
    atStep: null,
  });
});

test("recapTeamResult: unknown team (spectator / left) → missed", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  assert.equal(recapTeamResult(card, "t9").status, "missed");
  assert.equal(recapTeamResult(card, null).status, "missed");
});

test("recapTeamResult: bust round, winner's slot also just missed", () => {
  const card = partyRecapCards([recordPartyRound([], bustRound(2))[0]])[0];
  assert.deepEqual(recapTeamResult(card, "t1"), {
    status: "wrong",
    guessIso: "kr",
    atStep: 6,
  });
  assert.equal(recapTeamResult(card, "t2").status, "missed");
});

/* ---------------- recapTeamResults (TV: every team's story) ---------------- */

const TEAMS = {
  t1: { name: "Red", total: 60 },
  t2: { name: "Blue", total: 0 },
  t3: { name: "Green", total: 0 },
};

test("recapTeamResults: one row per team, carrying resolved name + own guess", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  const rows = recapTeamResults(card, TEAMS);
  assert.deepEqual(rows, [
    { team: "t1", name: "Red", status: "correct", guessIso: "fr", atStep: 3 },
    { team: "t2", name: "Blue", status: "wrong", guessIso: "it", atStep: 5 },
    { team: "t3", name: "Green", status: "missed", guessIso: null, atStep: null },
  ]);
});

test("recapTeamResults: sorted by slot id for a stable auto-cycle order", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  const rows = recapTeamResults(card, { t3: { name: "Z" }, t1: { name: "A" }, t2: { name: "M" } });
  assert.deepEqual(rows.map((r) => r.team), ["t1", "t2", "t3"]);
});

test("recapTeamResults: a team present only in results (left the standings) still shows", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  const rows = recapTeamResults(card, { t1: { name: "Red" } });
  assert.deepEqual(rows.map((r) => r.team), ["t1", "t2", "t3"]);
  // No name in teams → falls back to the slot id (never crashes on masking).
  assert.equal(rows.find((r) => r.team === "t2").name, "t2");
});

test("recapTeamResults: nullish teams → rows come from the card's results", () => {
  const card = partyRecapCards([recordPartyRound([], winRound(1))[0]])[0];
  const rows = recapTeamResults(card, null);
  assert.deepEqual(rows.map((r) => r.team), ["t1", "t2", "t3"]);
  assert.ok(rows.every((r) => r.name === r.team));
});
