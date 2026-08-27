// tests/tv-sound.test.js — the pure core of the TV room sound layer
// (js/tv-sound.js). The synthesis (WebAudio oscillators) is thin glue; every
// DECISION about whether a sound fires lives in soundState/soundDecisions and is
// tested here with no browser, no AudioContext and no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  soundState,
  soundDecisions,
  tickPitch,
  TICK_LO_HZ,
  TICK_HI_HZ,
} from "../js/tv-sound.js";

const STEPS = 12;

// A room snapshot as the TV receives it (only the fields the sound layer reads).
const room = ({ phase = "roundActive", round = null, teams = {} } = {}) => ({
  gameState: { phase, ...(round ? { round } : {}), teams },
});

const activeRound = (number, currentStep) => ({ number, currentStep });
// A settled round: RTDB stores no nulls, so an UNRESOLVED round simply has no
// `outcome` key — never `outcome: null`.
const winRound = (number, atStep = 4) => ({
  number,
  currentStep: atStep,
  outcome: { kind: "win", team: "t1", atStep },
});
const bustRound = (number) => ({
  number,
  currentStep: STEPS,
  outcome: { kind: "bust" },
});

const st = (opts, steps = STEPS) => soundState(room(opts), steps);
const kinds = (prev, next) => soundDecisions(prev, next).map((d) => d.kind);

// ---------------------------------------------------------------------------
// soundState — the projection
// ---------------------------------------------------------------------------

test("soundState projects only the fields that can make a sound", () => {
  const s = st({
    phase: "roundActive",
    round: activeRound(3, 5),
    teams: { t2: { name: "B" }, t1: { name: "A" } },
  });
  assert.deepEqual(s, {
    phase: "roundActive",
    roundNumber: 3,
    currentStep: 5,
    steps: STEPS,
    outcomeKind: null,
    teamKeys: ["t1", "t2"], // sorted, so key order in the snapshot is irrelevant
  });
});

test("soundState tolerates an empty / partial room", () => {
  assert.deepEqual(soundState(null, STEPS), {
    phase: "lobby",
    roundNumber: null,
    currentStep: null,
    steps: STEPS,
    outcomeKind: null,
    teamKeys: [],
  });
  // A non-positive or missing `steps` degrades to null (tickPitch holds the low
  // end) rather than producing a bogus pitch curve.
  assert.equal(soundState(room({}), 0).steps, null);
  assert.equal(soundState(room({}), undefined).steps, null);
});

test("soundState reads an absent outcome as null, never a thrown key", () => {
  assert.equal(st({ round: activeRound(1, 2) }).outcomeKind, null);
  assert.equal(st({ phase: "reveal", round: winRound(1) }).outcomeKind, "win");
  assert.equal(st({ phase: "reveal", round: bustRound(1) }).outcomeKind, "bust");
});

// ---------------------------------------------------------------------------
// soundDecisions — priming
// ---------------------------------------------------------------------------

test("the first snapshot primes and sounds nothing", () => {
  // A TV attaching mid-reveal must not sting for a round it never watched, and
  // a TV attaching to a full lobby must not blip once per team already there.
  assert.deepEqual(soundDecisions(null, st({ phase: "reveal", round: winRound(2) })), []);
  assert.deepEqual(
    soundDecisions(null, st({ phase: "lobby", teams: { t1: {}, t2: {}, t3: {} } })),
    []
  );
  assert.deepEqual(soundDecisions(null, null), []);
  assert.deepEqual(soundDecisions(st({}), null), []);
});

// ---------------------------------------------------------------------------
// soundDecisions — win / bust
// ---------------------------------------------------------------------------

test("a round settling on a win stings once", () => {
  const prev = st({ phase: "roundActive", round: activeRound(1, 4) });
  const next = st({ phase: "reveal", round: winRound(1, 4) });
  assert.deepEqual(kinds(prev, next), ["winSting"]);
  // Snapshot echoes of the SAME settled round are silent (heartbeats re-render).
  assert.deepEqual(kinds(next, next), []);
});

test("a round settling on a bust womps once", () => {
  const prev = st({ phase: "roundActive", round: activeRound(1, 12) });
  const next = st({ phase: "reveal", round: bustRound(1) });
  assert.deepEqual(kinds(prev, next), ["bustWomp"]);
  assert.deepEqual(kinds(next, next), []);
});

test("the NEXT round's win stings even though the outcome kind is unchanged", () => {
  // Keyed on (round number, outcome kind): round 1 win → round 2 win must fire.
  const r1 = st({ phase: "reveal", round: winRound(1) });
  const r2 = st({ phase: "reveal", round: winRound(2) });
  assert.deepEqual(kinds(r1, r2), ["winSting"]);
});

test("advancing into gameOver does not re-sting the finishing round", () => {
  const reveal = st({ phase: "reveal", round: winRound(3) });
  const over = st({ phase: "gameOver", round: winRound(3) });
  assert.deepEqual(kinds(reveal, over), []);
});

test("a fresh unresolved round is silent", () => {
  const reveal = st({ phase: "reveal", round: winRound(1) });
  const fresh = st({ phase: "roundActive", round: activeRound(2, 1) });
  assert.deepEqual(kinds(reveal, fresh), []);
});

// ---------------------------------------------------------------------------
// soundDecisions — the scrubber tick
// ---------------------------------------------------------------------------

test("a step advance during roundActive ticks, carrying step + steps", () => {
  const prev = st({ phase: "roundActive", round: activeRound(1, 3) });
  const next = st({ phase: "roundActive", round: activeRound(1, 4) });
  assert.deepEqual(soundDecisions(prev, next), [
    { kind: "tick", step: 4, steps: STEPS },
  ]);
});

test("an unchanged step is deduped (snapshot echoes re-render the same step)", () => {
  const s = st({ phase: "roundActive", round: activeRound(1, 4) });
  assert.deepEqual(kinds(s, s), []);
});

test("a step that jumps by more than one ticks exactly once", () => {
  const prev = st({ phase: "roundActive", round: activeRound(1, 2) });
  const next = st({ phase: "roundActive", round: activeRound(1, 6) });
  assert.deepEqual(soundDecisions(prev, next), [
    { kind: "tick", step: 6, steps: STEPS },
  ]);
});

test("a step never ticks backwards, across rounds, or outside roundActive", () => {
  const at5 = st({ phase: "roundActive", round: activeRound(1, 5) });
  // A late/stale echo of an earlier step.
  assert.deepEqual(kinds(at5, st({ phase: "roundActive", round: activeRound(1, 3) })), []);
  // Round 1 step 5 → round 2 step 1 is a new round, not an advance.
  assert.deepEqual(kinds(at5, st({ phase: "roundActive", round: activeRound(2, 1) })), []);
  // The reveal renders the full flag; that is the sting's job, not a tick.
  assert.deepEqual(kinds(at5, st({ phase: "reveal", round: winRound(1, 6) })), ["winSting"]);
});

// ---------------------------------------------------------------------------
// soundDecisions — the lobby join blip
// ---------------------------------------------------------------------------

test("a team joining the lobby blips", () => {
  const prev = st({ phase: "lobby", teams: { t1: {} } });
  const next = st({ phase: "lobby", teams: { t1: {}, t2: {} } });
  assert.deepEqual(kinds(prev, next), ["joinBlip"]);
});

test("two teams joining at once blip once, not twice", () => {
  const prev = st({ phase: "lobby", teams: { t1: {} } });
  const next = st({ phase: "lobby", teams: { t1: {}, t2: {}, t3: {} } });
  assert.deepEqual(kinds(prev, next), ["joinBlip"]);
});

test("a team leaving the lobby is silent", () => {
  const prev = st({ phase: "lobby", teams: { t1: {}, t2: {} } });
  const next = st({ phase: "lobby", teams: { t1: {} } });
  assert.deepEqual(kinds(prev, next), []);
});

test("a swap (one leaves, one joins) still blips — a join happened", () => {
  const prev = st({ phase: "lobby", teams: { t1: {}, t2: {} } });
  const next = st({ phase: "lobby", teams: { t1: {}, t3: {} } });
  assert.deepEqual(kinds(prev, next), ["joinBlip"]);
});

test("an unchanged lobby is silent on every echo", () => {
  const s = st({ phase: "lobby", teams: { t1: {}, t2: {} } });
  assert.deepEqual(kinds(s, s), []);
});

test("teams only blip in the lobby, never mid-game", () => {
  const prev = st({ phase: "roundActive", round: activeRound(1, 2), teams: { t1: {} } });
  const next = st({
    phase: "roundActive",
    round: activeRound(1, 2),
    teams: { t1: {}, t2: {} },
  });
  assert.deepEqual(kinds(prev, next), []);
});

// ---------------------------------------------------------------------------
// tickPitch
// ---------------------------------------------------------------------------

test("tickPitch rises from the first step to the last", () => {
  assert.equal(tickPitch(1, STEPS), TICK_LO_HZ);
  assert.equal(tickPitch(STEPS, STEPS), TICK_HI_HZ);
  const mid = tickPitch(Math.ceil(STEPS / 2), STEPS);
  assert.ok(mid > TICK_LO_HZ && mid < TICK_HI_HZ);
  // Monotonic across the whole reveal.
  for (let i = 2; i <= STEPS; i++) assert.ok(tickPitch(i, STEPS) > tickPitch(i - 1, STEPS));
});

test("tickPitch is clamped and degrades to the low end on bad input", () => {
  assert.equal(tickPitch(0, STEPS), TICK_LO_HZ);
  assert.equal(tickPitch(-4, STEPS), TICK_LO_HZ);
  assert.equal(tickPitch(STEPS + 9, STEPS), TICK_HI_HZ);
  assert.equal(tickPitch(3, null), TICK_LO_HZ);
  assert.equal(tickPitch(null, STEPS), TICK_LO_HZ);
  assert.equal(tickPitch(1, 1), TICK_LO_HZ);
});

// ---------------------------------------------------------------------------
// Purity — the decision layer must stay side-effect free
// ---------------------------------------------------------------------------

test("soundDecisions mutates neither argument", () => {
  const prev = st({ phase: "lobby", teams: { t1: {} } });
  const next = st({ phase: "lobby", teams: { t1: {}, t2: {} } });
  const prevCopy = JSON.parse(JSON.stringify(prev));
  const nextCopy = JSON.parse(JSON.stringify(next));
  soundDecisions(prev, next);
  assert.deepEqual(prev, prevCopy);
  assert.deepEqual(next, nextCopy);
});
