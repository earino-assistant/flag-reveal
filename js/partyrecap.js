// partyrecap.js — pure round-history accumulator + card derivation for the
// phone game-over "round recap" (the band above the winner line). Mirrors
// GeoParty's js/partyrecap.js, but flag-based.
//
// Flag Party keeps only the CURRENT round in the RTDB gameState; every earlier
// round is overwritten in place (there is no history node in the schema). So
// each device folds a memory-only accumulator at every reveal echo. This module
// is that fold plus the pure card/guess derivation; js/flag-ui.js is the thin
// glue that draws the cards from the vendored flag SVGs. No DOM, no Firebase,
// no network — same discipline as js/flag.js. Read-only over already-settled
// state: it never runs a transaction and never flips a phase.

const finite = (n) => typeof n === "number" && Number.isFinite(n);

// The fold: record one REVEALED round into the memory-only history and return
// the (new) accumulator. Called from the render path, which re-runs on every
// Firebase echo — so it is IDEMPOTENT (a round.number already present is a
// no-op) and PURE (never mutates `history`; on append it returns a NEW array;
// on a no-op it returns the SAME reference so glue can cheaply skip a redraw).
//
// Source: the reveal round's public settled fields — answerIso, flagSeed, and
// results (per-team correct/wrong + step, populated by resolveOutcome at
// reveal). round/private is never read (it is dropped at settlement anyway).
// `mode` is passed by the glue (it knows its mode statically) and only tags the
// entry for later use; it does not change what is recorded.
export function recordPartyRound(history, round, { mode } = {}) {
  const hist = Array.isArray(history) ? history : [];
  // Nothing to record: no round, no valid number, or no settled answer yet.
  if (!round || !finite(round.number) || round.number <= 0) return history;
  if (!round.answerIso) return history;
  // Idempotence: the fold is re-called on every state echo.
  if (hist.some((e) => e.number === round.number)) return history;

  const src = round.results || {};
  const results = {};
  for (const tN of Object.keys(src)) {
    const r = src[tN] || {};
    results[tN] = {
      correct: !!r.correct,
      atStep: finite(r.atStep) ? r.atStep : null,
      rangOut: !!r.rangOut,
      wrongIso: r.wrongIso || null,
      wrongStep: finite(r.wrongStep) ? r.wrongStep : null,
    };
  }
  return hist.concat({
    number: round.number,
    answerIso: round.answerIso,
    flagSeed: finite(round.flagSeed) ? round.flagSeed : null,
    mode: mode || null,
    results,
  });
}

// One card per recorded round, sorted by round number ascending; malformed
// entries dropped. totalRounds = the highest round number present (honest when
// the game ended early on the point target, tolerant of a device that missed a
// reveal snapshot). Empty/nullish in → [].
export function partyRecapCards(history) {
  const hist = Array.isArray(history) ? history : [];
  const valid = hist.filter((e) => e && finite(e.number) && e.number > 0 && e.answerIso);
  if (!valid.length) return [];
  const totalRounds = valid.reduce((m, e) => Math.max(m, e.number), 0);
  return valid
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((e) => ({
      number: e.number,
      totalRounds,
      answerIso: e.answerIso,
      flagSeed: e.flagSeed != null ? e.flagSeed : null,
      results: e.results || {},
    }));
}

// A single team's story for one recap card — what THIS device's player did:
//   { status: "correct" | "wrong" | "missed", guessIso, atStep }
// - correct: they rang the right flag; their guess WAS the answer.
// - wrong:   they rang out on a wrong flag (wrongIso is their own guess).
// - missed:  they never rang this round (no guess to show).
// Only the player's OWN result should be passed here (privacy §5.2: a phone
// shows its own guess and the shared answer, never another team's guessed
// country). Nothing here is a team name.
export function recapTeamResult(card, teamId) {
  const r = (card && card.results && card.results[teamId]) || null;
  if (!r) return { status: "missed", guessIso: null, atStep: null };
  if (r.correct) {
    return { status: "correct", guessIso: card.answerIso, atStep: finite(r.atStep) ? r.atStep : null };
  }
  if (r.rangOut && r.wrongIso) {
    return { status: "wrong", guessIso: r.wrongIso, atStep: finite(r.wrongStep) ? r.wrongStep : null };
  }
  return { status: "missed", guessIso: null, atStep: null };
}
