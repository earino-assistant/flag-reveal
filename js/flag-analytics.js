// flag-analytics.js — pure decision logic for the party analytics emission.
//
// CLAUDE.md puts decision logic in the pure, unit-tested layer and keeps the UI
// glue thin. The at-most-once / dedup machinery for `flag_ring` and `flag_round`
// used to live inline in flag-ui.js (emitRing / emitRevealAnalytics), untested.
// These helpers own the DECISION (should we emit? with what props?); flag-ui.js
// keeps only the side effects (mutating the seen-set, calling `track()`).
//
// Pure: no DOM, no network, no PostHog. Every input is passed in; the seen-sets
// are read but never mutated here (the caller records the returned key/roundKey
// after a successful emit, exactly as before).

// Membership check that accepts a Set (has) or an array (indexOf) so tests can
// pass a plain array and the UI can pass its live Set unchanged.
function seenHas(seen, key) {
  if (!seen) return false;
  if (typeof seen.has === "function") return seen.has(key);
  return seen.indexOf(key) >= 0;
}

// ringEmission(state, event) → { emit, key, props }
//
// The `flag_ring` dedup is on (roundKey, correct): a round emits at most one
// "correct" ring and one "wrong" ring per key. `state` carries the ambient
// context (the seen-set + the fields that are constant for this phone/round);
// `event` carries the per-ring specifics. On a duplicate, emit:false and
// props:null. The caller adds `key` to its set and calls track(props) iff emit.
export function ringEmission(state, event) {
  const rk = state.roundKey;
  const key = rk + ":" + (event.correct ? 1 : 0);
  if (seenHas(state.ringed, key)) return { emit: false, key, props: null };
  return {
    emit: true,
    key,
    props: {
      mode: state.mode,
      team: state.team,
      atStep: event.atStep,
      correct: event.correct,
      points: event.points,
      contested: event.contested,
      difficulty: state.difficulty,
      inputMode: state.inputMode,
      guessMode: state.guessMode,
      roundKey: rk,
    },
  };
}

// revealEmission(state, event) → { ownRing, round }
//
// Two independent decisions taken at reveal:
//   - ownRing: the winner's OWN correct ring (a `flag_ring` payload the caller
//     hands to the ring emitter so it flows through the same dedup). null unless
//     this phone is the winning team.
//   - round: the single `flag_round`, emitted at-most-once by the phone whose
//     resolveRound/advanceRound transaction committed (committedOutcome matches
//     this round) and only if not already emitted (emittedRounds gate). Carries
//     the ringCount fold over results/*.
export function revealEmission(state, event) {
  const oc = event.outcome || {};
  const results = event.results || {};
  const rk = state.roundKey;

  let ownRing = null;
  if (oc.kind === "win" && oc.team === state.myTeam) {
    const pts = (results[state.myTeam] && results[state.myTeam].points) || 0;
    ownRing = { correct: true, contested: false, atStep: oc.atStep, points: pts };
  }

  let round = null;
  const committed = state.committedOutcome;
  if (
    committed &&
    committed.number === event.roundNumber &&
    !seenHas(state.emittedRounds, rk)
  ) {
    let ringCount = 0;
    for (const t of Object.keys(results)) {
      if (results[t] && (results[t].correct || results[t].rangOut)) ringCount++;
    }
    round = {
      emit: true,
      props: {
        mode: state.mode,
        outcome: oc.kind === "win" ? "won" : "busted",
        winningStep: oc.kind === "win" ? oc.atStep : null,
        ringCount,
        difficulty: state.difficulty,
        inputMode: state.inputMode,
        guessMode: state.guessMode,
        roundNumber: event.roundNumber,
        roundKey: rk,
      },
    };
  }

  return { ownRing, round };
}
