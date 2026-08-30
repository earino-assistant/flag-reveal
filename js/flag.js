// js/flag.js — Flag Reveal pure decision-logic module.
//
// This is the unit-tested "brain" of the reference implementation. Every export
// is a PURE function of its inputs: no DOM, no network, no Firebase, no
// `Math.random`, no `Date.now`. Cross-device determinism depends on it — two
// phones deriving the same flag sequence, the same reveal plan, and the same
// easy-mode option list from the same seed is the whole point (SPEC-v3.1 §8.1).
//
// The concurrency spine (SPEC-v3.1 §4) lives here as two pure cores —
// `resolveOutcome` (the resolveRound transaction) and `advanceState` (the
// advanceRound transaction) — plus `roundConduct`, the per-snapshot decision
// each phone runs. The Firebase glue (js/firebase.js, built separately) wraps
// these in `runTransaction(..., {applyLocally:false})`; it owns no logic.

import { isValidRoomCode } from "./roomcode.js";

// ---------------------------------------------------------------------------
// Constants (spec defaults; every real caller passes a locked `cfg`, §8.1).
// ---------------------------------------------------------------------------
const STEPS = 8;
const BASE = 1000;
const MIN = 100;
const GRACE_MS = 3000;
const STEP_MS = 1500;
const AUTO_ADVANCE_MS = 15000; // revealAt + 15s (§2)
const MAX_BLUR = 20; // px, blur→sharp track start (§3 revealPlan)

// ---------------------------------------------------------------------------
// Deterministic PRNG + hashing (no Math.random — determinism is a correctness
// property, not a nicety). xmur3 folds a string to a uint32 seed; mulberry32 is
// a fast, well-distributed 32-bit generator. Same seed → same stream on every
// device and every JS engine.
// ---------------------------------------------------------------------------

// Fold an arbitrary string to a uint32 seed.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 13);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// mulberry32: number seed → () => float in [0, 1). Exported so seeded callers
// outside flag.js (daily.js's curated tier allocation) draw from the SAME PRNG
// the party game uses instead of reimplementing it and drifting.
export function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fold a string seed to uint32 (exported for callers that want a raw seed).
export function hashSeed(str) {
  return xmur3(String(str));
}

// Per-round derivation seed: flagSeed = hash(gameSeed, number). Deterministic
// on every device; `gameSeed` is coerced to string so numbers/strings agree.
// Analytics' `roundKey` (§12) is a truncation of this same value.
export function hash(gameSeed, number) {
  return xmur3(String(gameSeed) + ":" + String(number));
}

// Fisher–Yates shuffle without replacement, driven by an injected rng. Pure:
// returns a new array, never mutates its input. Exported alongside mulberry32
// for the same single-source-of-truth reason.
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Pool selection (spec §8, §8.4).
// ---------------------------------------------------------------------------

// The eligible pool for a difficulty setting. Four explicit, strictly-nested
// pools (each one a superset-or-harder step, not a re-mix):
//
//   easy       = tier `easy` only
//   default    = `easy` + `world`            — the friendly party mix (DEFAULT)
//   hard       = `world` + `expert`          — no easy flags
//   everything = `easy` + `world` + `expert` — the full deck
//
// The difficulty SETTING values (easy/default/hard/everything) are distinct
// from the DATA tiers in flags.json (easy/world/expert); `world` is a tier, not
// a setting. An unknown/absent difficulty falls back to `default`.
//
// Entries are `eligible: false` unless explicitly true-or-absent — we treat a
// missing `eligible` as eligible so a lean fixture pool "just works", and only
// an explicit `eligible: false` excludes.
//
// Exported so the phone and the TV derive the setting's pool size from the SAME
// filter flag.js uses internally, instead of each re-deriving it (the old
// private `poolSize` copies in flag-ui.js / screen-flag.js).
const TIER_MAP = {
  easy:        ["easy"],
  default:     ["easy", "world"],
  hard:        ["world", "expert"],
  everything:  ["easy", "world", "expert"],
};

export function eligiblePool(pool, difficulty) {
  const eligible = (pool || []).filter((e) => e && e.eligible !== false);
  const tiers = TIER_MAP[difficulty] || TIER_MAP.default;
  return eligible.filter((e) => tiers.includes(e.tier));
}

// The pool-clamped round budget: min(requested, |eligible pool|). `requested`
// defaults to the whole eligible pool when cfg.roundCount is absent. This is the
// single source of truth for "Round N / M": the clamp used to be copy-pasted at
// four+ call sites (flag.js twice, flag-ui.js, screen-flag.js), which meant a
// future eligibility change could make the phone and TV disagree about M.
export function effectiveRoundCount(cfg, pool) {
  const difficulty = (cfg && cfg.difficulty) || "default";
  const size = eligiblePool(pool, difficulty).length;
  const requested = cfg && cfg.roundCount != null ? cfg.roundCount : size;
  return Math.min(requested, size);
}

// ---------------------------------------------------------------------------
// 1. gameFlags — the whole game's deterministic, repeat-free flag sequence.
// ---------------------------------------------------------------------------
// Canonically ISO-sorts the eligible tier BEFORE the seeded shuffle (§8.1), so
// the derived order is independent of flags.json's own ordering. Repeat-free by
// construction (shuffle without replacement). Easy-first-round guard: an
// easy-mode game opens on an easy-tier flag. Clamps to the pool length so a
// roundCount larger than the pool never crashes (§8.1).
export function gameFlags(gameSeed, effectiveRoundCount, difficulty, pool) {
  const sorted = eligiblePool(pool, difficulty)
    .slice()
    .sort((a, b) => (a.iso2 < b.iso2 ? -1 : a.iso2 > b.iso2 ? 1 : 0));
  const rng = mulberry32(hashSeed(gameSeed));
  const seq = shuffle(sorted, rng);

  // Easy-first guard: if the opening flag isn't easy-tier, promote the first
  // easy-tier entry to the front. (With `easy` difficulty the whole pool is
  // already easy-tier, so this is a no-op there; it is a defensive postcondition
  // that survives any future pool-mapping change.)
  if (difficulty === "easy" && seq.length && seq[0].tier !== "easy") {
    const idx = seq.findIndex((e) => e.tier === "easy");
    if (idx > 0) {
      const [e] = seq.splice(idx, 1);
      seq.unshift(e);
    }
  }

  const isos = seq.map((e) => e.iso2);
  const n = Math.max(0, Math.min(effectiveRoundCount, isos.length));
  return isos.slice(0, n);
}

// ---------------------------------------------------------------------------
// 2. flagForRound — round `number`'s flag + its per-round flagSeed.
// ---------------------------------------------------------------------------
// `config` carries the locked settings (difficulty, roundCount). The answer is
// `gameFlags(...)[number-1]`; the round's reveal/option seed is
// `hash(gameSeed, number)`. Because both derive from (gameSeed, number), an
// owner refresh re-authors the identical round — no resample (§8.1).
export function flagForRound(config, gameSeed, number, pool) {
  const difficulty = (config && config.difficulty) || "default";
  const seq = gameFlags(gameSeed, effectiveRoundCount(config, pool), difficulty, pool);
  return { answerIso: seq[number - 1], flagSeed: hash(gameSeed, number) };
}

// ---------------------------------------------------------------------------
// 3. revealPlan — seeded tile order + monotone blur schedule (pure data).
// ---------------------------------------------------------------------------
// `gridN²` tile indices, shuffled by flagSeed, plus a blur track that decreases
// monotonically from MAX_BLUR to 0 across `steps`. The partition of tiles into
// per-step groups is recomputed (deterministically) in `exposedAt`, so the plan
// itself stays a minimal {tileOrder, blur} payload.
export function revealPlan(flagSeed, steps = STEPS, gridN = 4) {
  const total = gridN * gridN;
  const rng = mulberry32(flagSeed >>> 0);
  const tiles = [];
  for (let i = 0; i < total; i++) tiles.push(i);
  const tileOrder = shuffle(tiles, rng);

  const blur = [];
  for (let k = 0; k < steps; k++) {
    // k=0 → MAX_BLUR, k=steps-1 → 0. Strictly decreasing for steps > 1.
    const v = steps > 1 ? (MAX_BLUR * (steps - 1 - k)) / (steps - 1) : 0;
    blur.push(Math.round(v * 100) / 100);
  }
  return { tileOrder, blur };
}

// Per-step group sizes for `total` tiles across `steps` groups. Remainder is
// front-loaded deterministically (§8.4: ceil per step, remainder loaded). Sum
// of counts === total, so every tile is exposed by the final step.
function groupCounts(total, steps) {
  const base = Math.floor(total / steps);
  const rem = total % steps;
  const counts = [];
  for (let i = 0; i < steps; i++) counts.push(base + (i < rem ? 1 : 0));
  return counts;
}

// ---------------------------------------------------------------------------
// 4. exposedAt — which tiles are de-occluded through `step`, and the blur there.
// ---------------------------------------------------------------------------
// Cumulative: the set of tiles a renderer paints by `step` (all tiles revealed
// up to and including it). Clamps out-of-range steps (step<1 → nothing yet;
// step>steps → the full flag).
export function exposedAt(plan, step) {
  const steps = plan.blur.length;
  const total = plan.tileOrder.length;
  const counts = groupCounts(total, steps);

  if (step < 1) return { tiles: [], blurPx: plan.blur[0] != null ? plan.blur[0] : MAX_BLUR };
  const s = step > steps ? steps : step;
  let cum = 0;
  for (let i = 0; i < s; i++) cum += counts[i];
  return { tiles: plan.tileOrder.slice(0, cum), blurPx: plan.blur[s - 1] };
}

// ---------------------------------------------------------------------------
// 5. chooseOptions — easy-mode 4-option set, identical on every device (§1.3).
// ---------------------------------------------------------------------------
// Correct ISO + 3 same-tier distractors, then the four order-shuffled — all by a
// single flagSeed-seeded rng stream, so every phone/TV computes the identical
// list and order. Falls back to other eligible entries if a tier has < 3
// distractors (noted; unusual for the curated pool).
export function chooseOptions(flagSeed, answerIso, pool) {
  const rng = mulberry32(flagSeed >>> 0);
  const entry = (pool || []).find((e) => e.iso2 === answerIso);
  const tier = entry ? entry.tier : undefined;
  const eligible = (pool || []).filter((e) => e.eligible !== false && e.iso2 !== answerIso);

  const sameTier = eligible.filter((e) => e.tier === tier);
  const distract = shuffle(sameTier, rng)
    .slice(0, 3)
    .map((e) => e.iso2);

  if (distract.length < 3) {
    const rest = shuffle(
      eligible.filter((e) => !distract.includes(e.iso2)),
      rng
    ).map((e) => e.iso2);
    for (const iso of rest) {
      if (distract.length >= 3) break;
      distract.push(iso);
    }
  }

  return shuffle([answerIso, ...distract], rng);
}

// ---------------------------------------------------------------------------
// 6. choiceUnlocked — are the easy-mode buttons tappable yet? (§1.3 game-theory)
// ---------------------------------------------------------------------------
export function choiceUnlocked(currentStep, cfg) {
  const unlock = cfg && cfg.choiceUnlockStep != null ? cfg.choiceUnlockStep : 5;
  return currentStep >= unlock;
}

// ---------------------------------------------------------------------------
// 6b. Guess mode — "First correct wins" (lockout) vs "Multiple guesses" (§1.7).
// ---------------------------------------------------------------------------
// The host picks one of two lockout policies at room creation, locked into
// settings like difficulty/inputMode (§8.1):
//   - default ("First correct wins"): a wrong ring ends that team's round —
//     they are locked out until the next flag (`cfg.multiGuess` absent/false).
//   - "Multiple guesses" (`cfg.multiGuess === true`): a wrong ring is still
//     recorded (for beats + the TV hint) but does NOT lock the team out — they
//     keep guessing until they get it right, the round busts, or a rival wins.
//
// Only the CLIENT's re-guess gate changes: `shouldLockOut(cfg) === false` tells
// flag-ui not to set `myLockRound` and to keep the input live. The arbitration
// is untouched — `resolveOutcome` already trusts the ringing team as the winner
// and never assumes a prior wrong-ringer is out (a team with a current-round
// private wrong record can still win; see the multi-guess test). No new
// transaction, no new phase flip (CLAUDE.md).
export function shouldLockOut(cfg) {
  return !(cfg && cfg.multiGuess);
}

// The aggregate analytics dimension for the guess mode — rides `flag_ring` and
// `flag_round` next to `difficulty`/`inputMode` so "First correct wins" vs
// "Multiple guesses" is separable downstream. Aggregate-only (no PII).
export function guessModeLabel(cfg) {
  return cfg && cfg.multiGuess ? "multi" : "single";
}

// ---------------------------------------------------------------------------
// 7. scoreRing — points for a correct ring at `atStep` (§1.7).
// ---------------------------------------------------------------------------
// max(min, round(base × (steps − atStep + 1) / steps)). Earlier = more; the
// step integer IS the clock (no speed-within-step bonus → clock-skew-immune).
export function scoreRing(atStep, steps = STEPS, base = BASE, min = MIN) {
  return Math.max(min, Math.round((base * (steps - atStep + 1)) / steps));
}

// ---------------------------------------------------------------------------
// 8. Answer normalization + autocomplete index (§1.6).
// ---------------------------------------------------------------------------
// Fold case, strip diacritics, drop apostrophes, collapse punctuation/space,
// drop a leading "the ". "Côte d'Ivoire" → "cote divoire".
export function normalizeName(s) {
  let out = String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/['’`]/g, "") // drop apostrophes with no gap (d'ivoire → divoire)
    .replace(/[^a-z0-9]+/g, " ") // any other punctuation → space
    .trim()
    .replace(/\s+/g, " ");
  if (out.startsWith("the ")) out = out.slice(4);
  return out;
}

// normalizeAnswer(guess, answerIso, aliases) → bool. `aliases` is the list of
// acceptable name strings for the answer country (canonical name + aliases);
// returns true iff the guess normalizes to one of them. Used only by the
// optional free-text mode (§1.6) — the default typeahead compares ISO codes
// directly. `answerIso` is part of the spec signature (the caller selects the
// alias list by it); the match itself is name-based.
export function normalizeAnswer(guess, answerIso, aliases) {
  const g = normalizeName(guess);
  if (!g) return false;
  return (aliases || []).some((name) => normalizeName(name) === g);
}

// buildAnswerIndex(dataset) → Map<normalizedName, iso[]>. The value is an
// ARRAY: a normalized key with length > 1 is a collision ("congo" → [CG, CD]).
// The typeahead expands a colliding key into distinct disambiguated rows; the
// optional free-text mode accepts a bare colliding guess iff answerIso is in the
// array (§1.6).
export function buildAnswerIndex(dataset) {
  const index = new Map();
  for (const entry of dataset || []) {
    if (!entry) continue;
    const names = [entry.name, ...(entry.aliases || [])];
    for (const name of names) {
      const key = normalizeName(name);
      if (!key) continue;
      let isos = index.get(key);
      if (!isos) {
        isos = [];
        index.set(key, isos);
      }
      if (!isos.includes(entry.iso2)) isos.push(entry.iso2);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// 9. resolveOutcome — pure core of the resolveRound transaction (§4.2/§4.3).
// ---------------------------------------------------------------------------
// Returns the FULL replacement gameState on success, or `undefined` to abort.
// This is the epoch-guarded terminal-state arbitration: win and bust compete
// for the same `outcome`; whichever the server serializes first commits, the
// loser's updater sees a non-null outcome and aborts.

// Disclosure of a team's private wrong-ring, FILTERED on lockedRound (§4.3):
// only a private write stamped with the CURRENT round.number is disclosed. A
// straggler from a prior round (lockedRound !== number) is treated as
// not-having-rung — the stale-write fix (REQUIRED 4).
function discloseFor(round, tN) {
  const priv = round.private && round.private[tN];
  if (priv && priv.lockedRound === round.number) {
    return { rangOut: true, wrongIso: priv.wrongIso, wrongStep: priv.wrongStep };
  }
  return { rangOut: false };
}

// Team slots that have locked THEMSELVES out with a wrong ring in the CURRENT
// round — PRESENCE ONLY, never the guessed country. Drives the TV's transient
// "guessed wrong" hint (screen-flag.js): the passive screen surfaces the FACT of
// a mid-round wrong ring without disclosing its content. Filtered on
// `lockedRound === round.number` (the same straggler guard as discloseFor, §4.3),
// so a delayed prior-round write never fabricates a hint. Returns a sorted slot
// list; `wrongIso`/`wrongStep` are deliberately NOT read — the guess stays hidden
// until reveal's beats (privacy §5.2: disclose the fact, never the content).
export function lockedOutTeams(round) {
  if (!round || !round.private) return [];
  const out = [];
  for (const tN of Object.keys(round.private)) {
    const p = round.private[tN];
    if (p && p.lockedRound === round.number) out.push(tN);
  }
  return out.sort();
}

export function resolveOutcome(gameState, attempt, cfg = {}) {
  // Empty-local-cache first run (§4.2 case a): cannot resolve without state.
  if (gameState == null) return undefined;

  const round = gameState.round;
  // Epoch guard: right phase, right round, still unresolved (`== null`: an
  // unresolved outcome is an ABSENT key, never a stored null — §2).
  if (gameState.phase !== "roundActive") return undefined;
  if (!round || round.number !== attempt.roundNumber) return undefined;
  if (round.outcome != null) return undefined;

  const teams = gameState.teams || {};
  const teamIds = Object.keys(teams);
  const now = cfg.now != null ? cfg.now : 0; // writer offset-estimate (§1.4)
  const autoAdvanceMs = cfg.autoAdvanceMs != null ? cfg.autoAdvanceMs : AUTO_ADVANCE_MS;

  // Clone teams (absolute settlement recomputed from the snapshot, never an
  // increment — §4.2/§13).
  const newTeams = {};
  for (const t of teamIds) newTeams[t] = { ...teams[t] };

  let outcome;
  const results = {};

  if (attempt.kind === "win") {
    // atStep is the SERVER snapshot's currentStep, never a client value (§1.4).
    const atStep = round.currentStep;
    const points = scoreRing(atStep, cfg.steps || STEPS, cfg.base || BASE, cfg.min || MIN);
    const winner = attempt.team;
    outcome = { kind: "win", team: winner, atStep };

    for (const t of teamIds) {
      if (t === winner) {
        results[t] = { correct: true, atStep, points, rangOut: false };
      } else {
        results[t] = { correct: false, points: 0, ...discloseFor(round, t) };
      }
    }
    if (newTeams[winner]) {
      newTeams[winner].total = (teams[winner].total || 0) + points;
      newTeams[winner].reachedTotalAt = round.number;
    }
  } else {
    // Bust: everyone zero, no total change; wrong rings still disclosed (§1.5).
    outcome = { kind: "bust" };
    for (const t of teamIds) {
      results[t] = { correct: false, points: 0, ...discloseFor(round, t) };
    }
  }

  // Full replacement round. `private` is DROPPED (§4.3) — disclosed values now
  // live in results/*; nothing else reads private post-settlement.
  const newRound = {
    number: round.number,
    flagSeed: round.flagSeed,
    answerIso: round.answerIso,
    startedAt: round.startedAt,
    currentStep: round.currentStep,
    stepStartedAt: round.stepStartedAt,
    outcome,
    results,
    revealAt: now,
    autoAdvanceAt: now + autoAdvanceMs,
  };

  return { ...gameState, phase: "reveal", round: newRound, teams: newTeams };
}

// ---------------------------------------------------------------------------
// 10. advanceState — pure core of the advanceRound transaction (§4.4).
// ---------------------------------------------------------------------------
// lobby → roundActive (round 1) and reveal → (roundActive | gameOver).
// Epoch-guarded, idempotent (a duplicate sees the already-advanced phase and
// aborts), deterministic (fresh round derived from (gameSeed, fromRound+1)).

// Whether the game ends AT the reveal of `fromRound`: target reached, or the
// (pool-clamped) round budget is spent (§1.8).
function isGameOver(gameState, fromRound, cfg) {
  const target = cfg.target != null ? cfg.target : 0;
  const teams = gameState.teams || {};
  if (target > 0) {
    const totals = Object.values(teams).map((t) => (t && t.total) || 0);
    const maxTotal = totals.length ? Math.max(...totals) : 0;
    if (maxTotal >= target) return true;
  }
  return fromRound >= effectiveRoundCount(cfg, cfg.pool || []);
}

export function advanceState(gameState, fromRound, cfg = {}) {
  if (gameState == null) return undefined; // empty cache (§4.2 case a)
  const now = cfg.now != null ? cfg.now : 0;

  // A fresh, unresolved round (outcome ABSENT; private/results reset — §4.4).
  const startRound = (number) => {
    const { answerIso, flagSeed } = flagForRound(cfg, cfg.gameSeed, number, cfg.pool || []);
    return {
      number,
      flagSeed,
      answerIso,
      startedAt: now, // transaction-authored offset-estimate (§1.4)
      currentStep: 1,
      stepStartedAt: now,
      results: {},
      private: {},
    };
  };

  if (gameState.phase === "lobby") {
    // Round-1 start. fromRound is 0 (advancing "from before round 1").
    if (fromRound !== 0) return undefined;
    return { ...gameState, phase: "roundActive", round: startRound(1) };
  }

  if (gameState.phase === "reveal") {
    const round = gameState.round;
    // Epoch guard: right round, resolved.
    if (!round || round.number !== fromRound) return undefined;
    if (round.outcome == null) return undefined;

    if (isGameOver(gameState, fromRound, cfg)) {
      return { ...gameState, phase: "gameOver" };
    }
    return { ...gameState, phase: "roundActive", round: startRound(fromRound + 1) };
  }

  // roundActive / gameOver / unknown → cannot advance.
  return undefined;
}

// endsGameOnAdvance(gameState, fromRound, cfg) → bool. Pure mirror of the
// gameOver branch of advanceState: true iff advancing from the reveal of
// `fromRound` would land in gameOver (target reached, or the round budget spent).
// Exposed so the phone that COMMITS the advance can emit the game_over analytics
// event at-most-once without re-deriving the round budget itself. Reads no
// private/*, flips no phase, writes nothing (SPEC §4.4, CLAUDE.md — this only
// classifies the same transition advanceState already decides).
export function endsGameOnAdvance(gameState, fromRound, cfg = {}) {
  if (!gameState || gameState.phase !== "reveal") return false;
  const round = gameState.round;
  if (!round || round.number !== fromRound) return false;
  if (round.outcome == null) return false;
  return isGameOver(gameState, fromRound, cfg);
}

// ---------------------------------------------------------------------------
// 11. roundConduct — the per-snapshot decision every phone runs (§4.4).
// ---------------------------------------------------------------------------
// Returns "continue" | "resolve-bust" | "advance". A `win` is NEVER decided
// here — only a correct ringer attempts it (§4.2). This function NEVER reads
// round/private (test-enforced, §5.2).
export function roundConduct(gameState, serverNow, isOwner, cfg = {}) {
  if (gameState == null) return "continue";
  const round = gameState.round;
  if (!round) return "continue";

  const steps = cfg.steps || STEPS;
  const stepMs = cfg.stepMs || STEP_MS;
  const graceMs = cfg.graceMs || GRACE_MS;

  if (gameState.phase === "roundActive" && round.outcome == null) {
    if (isOwner) {
      // Owner bust gate = STEP COMPLETION (not wall-clock), then a grace window
      // measured from the final step's stepStartedAt (§1.4).
      if (round.currentStep === steps && serverNow >= round.stepStartedAt + graceMs) {
        return "resolve-bust";
      }
      return "continue";
    }
    // Non-owner dead-man deadline, server-corrected, anchored on startedAt so it
    // still fires even if a dead owner froze currentStep below STEPS (§4.4).
    if (serverNow >= round.startedAt + steps * stepMs + 3 * graceMs) {
      return "resolve-bust";
    }
    return "continue";
  }

  if (gameState.phase === "reveal" && round.outcome != null) {
    // A held reveal (autoAdvanceAt == null) is respected — no fallback fires.
    if (round.autoAdvanceAt == null) return "continue";
    if (isOwner) {
      if (serverNow >= round.autoAdvanceAt) return "advance";
      return "continue";
    }
    // Non-owner reveal-phase fallback: +3·graceMs behind the owner (§4.4).
    if (serverNow >= round.autoAdvanceAt + 3 * graceMs) return "advance";
    return "continue";
  }

  return "continue";
}

// ---------------------------------------------------------------------------
// 11b. winAttemptOutcome — the §4.2 abort taxonomy as a pure classifier.
// ---------------------------------------------------------------------------
// When a phone's `resolveRound({kind:"win"})` transaction ABORTS (returned
// falsy), the phone re-reads the latest snapshot and decides what actually
// happened. This is that decision, extracted from doWinAttempt so it can be
// unit-tested against every §4.2 case. Returns one of:
//   "retry" — a/b/c benign: still live (or no snapshot yet) → try again.
//   "won"   — e: my own win already committed (my ack was merely lost).
//   "lost"  — d: a RIVAL's win serialized first (my correct ring was contested).
//   "bust"  — f: the round busted before my win landed.
//   "over"  — g: the round genuinely advanced past me.
// `myTeam` is the caller's slot; the committed-vs-aborted split stays in the UI
// (it is the transaction's own return value, not a property of the snapshot).
export function winAttemptOutcome(gameState, roundNumber, myTeam) {
  const gs = gameState;
  const r = gs && gs.round;
  const oc = r && r.outcome;
  // Still resolvable (or empty local cache) → benign, retry.
  if (!gs || (gs.phase === "roundActive" && r && r.number === roundNumber && oc == null)) {
    return "retry";
  }
  if (oc && oc.kind === "win" && oc.team === myTeam) return "won";
  if (oc && oc.kind === "win") return "lost";
  if (oc && oc.kind === "bust") return "bust";
  return "over";
}

// winRetryExhausted(winState, attemptCount, max) → bool. The pure decision behind
// flag-ui's retryWin bail-out: true when a win-attempt retry loop has spent its
// whole budget while the phone is STILL {phase:"trying"} for a round — its ring
// never resolved because a flaky network swallowed every retry. The caller then
// drops winState so the buzzer re-arms on the next tap (with an honest status)
// instead of freezing forever on "Ringing in…". False whenever the outcome has
// already resolved (won/lost/bust/over) — those won the resolution race and must
// stand; the reset must never clobber them (§4.2 tail).
export function winRetryExhausted(winState, attemptCount, max) {
  return !!winState && winState.phase === "trying" && attemptCount >= max;
}

// hostStalled(round, cfg, now) → bool. A DISPLAY-ONLY staleness cue for non-owner
// phones (zero authority, zero writes — CLAUDE.md): true when the reveal clock
// hasn't advanced for more than 2× stepMs while it still SHOULD be advancing
// (currentStep < steps). The owning phone drives currentStep every stepMs (writing
// stepStartedAt); a backgrounded/locked host freezes that write, so a long gap
// since stepStartedAt with steps still to go is the visible symptom of a sleeping
// host. Never fires at the final step (cadence legitimately stops there, waiting on
// the bust grace) or once the round is resolved. Pure; the caller only renders a
// hint and clears it when the step advances.
export function hostStalled(round, cfg, now) {
  if (!round || round.outcome != null) return false;
  const steps = (cfg && cfg.steps) || STEPS;
  const stepMs = (cfg && cfg.stepMs) || STEP_MS;
  if (round.currentStep == null || round.currentStep >= steps) return false;
  if (round.stepStartedAt == null) return false;
  return now - round.stepStartedAt > 2 * stepMs;
}

// tvAdvanceNote(round, cfg, now) → the reveal-phase advance note the TV shows, or
// null when it should show nothing. PURE (no DOM). The TV calls this only in the
// reveal branch, but it guards defensively: a missing round or an unresolved one
// (outcome absent — RTDB stores no null, §2) yields null. A held/paused reveal
// (autoAdvanceAt == null — includes a stale snapshot whose outcome landed before
// the key) shows the paused note. Otherwise it counts down: the final round
// (effectiveRoundCount reached, mirroring flag-ui.js#isFinalRound) heads to the
// scoreboard, every other round to the next flag. N = seconds remaining, ceil'd
// and clamped at 0. Only round.number / round.autoAdvanceAt / round.outcome
// matter; the pool arrives via cfg.pool exactly as the phone reads it.
export function tvAdvanceNote(round, cfg, now) {
  if (!round) return null;
  if (round.outcome == null) return null;
  if (round.autoAdvanceAt == null) return "Host paused — next round when they're ready";
  const n = Math.max(0, Math.ceil((round.autoAdvanceAt - now) / 1000));
  const eff = effectiveRoundCount(cfg || {}, (cfg && cfg.pool) || []);
  const isFinal = eff > 0 && round.number >= eff;
  return isFinal ? `Final scores in ${n}s…` : `Next round in ${n}s…`;
}

// ---------------------------------------------------------------------------
// 12. gameWinner + carryStandings — game-over fold and next-game carry (§1.8/§7).
// ---------------------------------------------------------------------------
// Deterministic on identical data (no write — the crown needs none, §1.8).
// Tie-break: highest total → fewest rounds to reach it (reachedTotalAt, lower is
// better) → lowest slot id.
export function gameWinner(teams, cfg = {}) {
  const ids = Object.keys(teams || {});
  if (!ids.length) return null;
  let best = null;
  for (const id of ids) {
    const t = teams[id] || {};
    const cand = {
      id,
      total: t.total || 0,
      // Fewer rounds to reach the total wins the tie; unset → worst (Infinity).
      reached: t.reachedTotalAt != null ? t.reachedTotalAt : Infinity,
    };
    if (best === null) {
      best = cand;
      continue;
    }
    if (cand.total > best.total) best = cand;
    else if (cand.total === best.total) {
      if (cand.reached < best.reached) best = cand;
      else if (cand.reached === best.reached && cand.id < best.id) best = cand;
    }
  }
  return best ? best.id : null;
}

// carryStandings(teams, winnerTeam, cfg?) → {teams, hostTeam}. Zeroes totals for
// a fresh game by default (or carries them for a "season" via cfg.carry, §7).
// Preserves name/deviceId; sets hostTeam = winnerTeam (winner becomes the reveal
// owner next game).
//
// cfg.winnerOnly (owner-approved amendment to SPEC-v3.1 ~§1356, which specifies
// full-carry — see docs/tv-stability-analysis.md "F6 amendment"): carry ONLY the
// winner's slot into the fresh game. Every other guest re-claims by deviceId via
// the auto-follow + `tryClaim` resume path, so a phone that isn't open at game
// over no longer leaves a ghost slot the TV counts as a live player. winnerOnly
// is deliberately IGNORED in season mode (cfg.carry): a season's whole point is
// persisting every team's running total across games, and dropping non-winner
// slots would silently lose returning devices' totals — so season keeps the full
// roster (totals intact) and only the fresh-game path prunes to the winner.
export function carryStandings(teams, winnerTeam, cfg = {}) {
  const carry = cfg.carry === true;
  const winnerOnly = cfg.winnerOnly === true && !carry;
  const out = {};
  for (const id of Object.keys(teams || {})) {
    if (winnerOnly && id !== winnerTeam) continue;
    const t = teams[id] || {};
    const next = { ...t };
    if (carry) {
      next.total = t.total || 0;
    } else {
      next.total = 0;
      delete next.reachedTotalAt;
    }
    out[id] = next;
  }
  return { teams: out, hostTeam: winnerTeam };
}

// shouldFollowRoom(room, currentCode, followedCodes) → the next room code to
// follow, or null. A finished (gameOver) room that grows a valid `nextRoom`
// pointer steers every subscriber — the TV included — into the fresh room's
// lobby. Pure: the caller owns the `followedCodes` Set and the re-subscribe.
// Guards mirror GeoParty's follow chain (SPEC-v3.1 "nextRoom + followedCodes
// chain — Verbatim", §1530): the room exists, its phase is gameOver, the pointer
// is a valid code, it isn't the current room, and it hasn't been visited (cycle
// guard). The gameOver gate keeps a TV from chasing a pointer written into a
// still-live room.
export function shouldFollowRoom(room, currentCode, followedCodes) {
  if (!room) return null;
  const gs = room.gameState || {};
  if (gs.phase !== "gameOver") return null;
  const next = room.nextRoom;
  if (!isValidRoomCode(next)) return null;
  if (next === currentCode) return null;
  if (followedCodes && followedCodes.has(next)) return null;
  return next;
}

// ---------------------------------------------------------------------------
// 12b. confettiSpec — the pure, deterministic game-over confetti generator
// (cribbed from GeoParty's js/fx.js confettiSpec). The old TV burst was a
// one-shot lockstep fall of identical strips; this returns per-strip specs with
// varied fall duration/delay, a horizontal drift (sway), a randomized spin, and
// size scaling, so the CSS loop varies instead of marching. Seeded (no
// Math.random) → stable per game and unit-testable. A `champion` gets a richer,
// gold-weighted burst; a plain win gets the colorful palette leaned toward the
// winner's own team color (accentColor). Reduced motion → NO confetti at all.
// screen-flag.js#celebrate renders these into looping .tv-confetti spans.
// ---------------------------------------------------------------------------

// The colorful ordinary-win palette and the champion's gold-weighted set. Both
// frozen so the render layer can't mutate them.
export const CONFETTI_COLORS = Object.freeze(
  ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a", "#f4f4f6"]);
export const CONFETTI_GOLD = Object.freeze(
  ["#ffd700", "#ffcf3f", "#ffe89a", "#f6b73c", "#fff4c2"]);

export const CONFETTI_TV_COUNT = 90;  // sparse-but-full TV loop default
export const CONFETTI_MAX = 160;      // hard cap (champion, still cheap)

// A plain win weights ~40% of the strips to the winner's own team color instead
// of the fixed palette ("your color takes the room"). Champion bursts ignore
// this — gold is the whole point.
export const ACCENT_WEIGHT = 0.4;

function confettiSeedInt(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  return hashSeed(String(seed == null ? "confetti" : seed));
}

// { count, seed, tier, reducedMotion, accentColor } → an array of strip specs.
// Same inputs always yield the same array (deterministic for tests and for a
// stable loop per game). Each strip:
//   left      0..100 (% of width)
//   color     one of the tier's palette, or the accent color (see below)
//   durationS positive fall duration (s)
//   delayS    >= 0 start delay (s)
//   driftVw   horizontal sway at the bottom (vw, signed)
//   spinDeg   total rotation over the fall (deg, >= 360)
//   sizeScale > 0 strip-size multiplier
// accentColor: a CSS color (the winner's team color, e.g. "var(--team-2)"). A
// strip below ACCENT_WEIGHT takes it instead of a palette pick. Ignored for a
// champion (gold only). `count` is the FINAL strip count (celebrationSpec
// already bakes the champion's larger burst in) — capped at CONFETTI_MAX.
export function confettiSpec({
  count, seed, tier, reducedMotion = false, accentColor = null,
} = {}) {
  if (reducedMotion === true) return [];   // reduced motion → no confetti
  const champion = tier === "champion";
  const base = Number.isFinite(count) && count > 0
    ? Math.floor(count) : CONFETTI_TV_COUNT;
  const n = Math.min(CONFETTI_MAX, base);
  const palette = champion ? CONFETTI_GOLD : CONFETTI_COLORS;
  const useAccent = !champion && typeof accentColor === "string" && !!accentColor;
  const rand = mulberry32(confettiSeedInt(seed));
  const round1 = (x) => Math.round(x * 10) / 10;
  const round2 = (x) => Math.round(x * 100) / 100;
  const bits = [];
  for (let i = 0; i < n; i++) {
    const rColor = rand();
    const rLeft = rand();
    const rDur = rand();
    const rDelay = rand();
    const rDrift = rand();
    const rSpin = rand();
    const rSize = rand();
    // Champion biases toward the gold end (squared → front-loaded).
    const pick = champion ? rColor * rColor : rColor;
    const idx = Math.min(palette.length - 1, Math.floor(pick * palette.length));
    const color = useAccent && rColor < ACCENT_WEIGHT ? accentColor : palette[idx];
    bits.push({
      left: round1(rLeft * 100),
      color,
      durationS: round2(2.6 + rDur * (champion ? 2.6 : 3.4)),
      delayS: round2(rDelay * (champion ? 2.5 : 3.8)),
      driftVw: round1((rDrift * 2 - 1) * (champion ? 10 : 7)),
      spinDeg: 360 + Math.floor(rSpin * 720),
      sizeScale: round2(champion ? 1.1 + rSize * 0.7 : 0.85 + rSize * 0.6),
    });
  }
  return bits;
}

// ---------------------------------------------------------------------------
// 12c. celebrationSpec — the game-over win moment (cribbed from GeoParty's
// "Your Color Takes the Room", references/win-celebration-ui.md).
// ---------------------------------------------------------------------------
// Pure: maps a decided winner to the celebration's tier / color / burst size so
// the TV render (screen-flag.js) is thin glue. No DOM, no write — the win is
// already captured, so this adds NO analytics event. The winner's team slot
// drives a color takeover (`--win` → var(--team-N)) and the confetti accent; a
// `champion` goes gold (var(--accent)), louder and gold-only, keeping the crown.
// An unknown/invalid slot falls back to gold rather than an undefined color.
// `seed` (the game seed) is passed straight through to confettiSpec so the burst
// is stable per game. Color is never the sole signal — the caller still renders
// "👑 name wins" text (accessibility).
export function celebrationSpec({
  won = false, champion = false, teamSlot = null, seed = null,
} = {}) {
  if (!won) {
    return { tier: "none", winVar: null, accentColor: null, confettiCount: 0, seed: null, crown: false };
  }
  const m = /^t([1-4])$/.exec(teamSlot || "");
  if (champion || !m) {
    return {
      tier: "champion", winVar: "var(--accent)", accentColor: null,
      confettiCount: Math.round(CONFETTI_TV_COUNT * 1.4), seed, crown: true,
    };
  }
  const winVar = `var(--team-${m[1]})`;
  return { tier: "win", winVar, accentColor: winVar, confettiCount: CONFETTI_TV_COUNT, seed, crown: true };
}

// ---------------------------------------------------------------------------
// 12d. revealMapSpec — the two reveal maps as a pure spec (TV reveal dressing).
// ---------------------------------------------------------------------------
// At reveal the answer country is public, so the TV shows two maps: a zoomed-OUT
// "where on Earth" view with a marker, and a zoomed-IN view framed to the
// country's WHOLE-multipolygon bbox. This is the ONLY decision layer —
// js/tv-maps.js is thin Leaflet glue that executes the returned spec. The
// centroid `table` is injected as an ARGUMENT (shape { iso2: { c:[lat,lng],
// b:[minLng,minLat,maxLng,maxLat] } }) so flag.js stays import-free and tests
// inject fixtures.
//
// Returns null for an unknown iso or a missing table. Otherwise:
//   world:   { center, spanDeg, marker } — world-context. `spanDeg` is the
//            target longitude span (a comfortable ~1/3 of the world); the glue
//            turns it into a concrete Leaflet zoom via `worldZoomFor` once it
//            knows the container width. `center`/`marker` are the centroid.
//   borders: { bounds, maxZoom, pad, marker } — bounds is the whole-country bbox
//            verbatim; the glue pads it by `pad` (fraction, so immediate
//            neighbors show) and caps at `maxZoom` (6 — a 135px strip at z8 shows
//            a city block; z6 shows ~3° of neighbors around a microstate) so a
//            microstate still frames with its surroundings. marker is the
//            centroid on both maps.
export function revealMapSpec(iso2, table) {
  if (!table) return null;
  const key = String(iso2 == null ? "" : iso2).toLowerCase();
  const entry = table[key];
  if (!entry || !entry.c || !entry.b) return null;
  const c = entry.c; // [lat, lng]
  const b = entry.b; // [minLng, minLat, maxLng, maxLat]
  return {
    world: { center: c, spanDeg: 120, marker: c },
    borders: { bounds: b, maxZoom: 6, pad: 0.18, marker: c },
  };
}

// worldZoomFor(containerWidthPx, spanDeg) → a FRACTIONAL Leaflet zoom that shows
// roughly `spanDeg` degrees of longitude across a `containerWidthPx`-wide map.
// Leaflet's whole world (360°) is 256 * 2^z px wide, so the zoom whose width
// spans `spanDeg` is z = log2(360 * w / (256 * spanDeg)). Integer flooring used
// to collapse this to a coarse grid — at the real ~486px map column the only
// choices were z2 (171° visible, Europe-tight) or z3 (85°), nothing near the
// 120° target. Leaflet supports fractional zoom (zoomSnap 0.25), so we QUANTIZE
// z to the 0.25 grid (round, not floor — the nearest snap lands the visible span
// within ~[105, 135]°) and clamp to [1, 4.5] (a world map is never useful below
// 1, and past 4.5 it stops being "world context"). At the ~486px column a 120°
// target now lands on z2.5 (~121° visible); a wider 1200px map on z3.75 (~125°).
// A zero/absent width (not laid out yet) falls back to a sensible 2.5.
export function worldZoomFor(containerWidthPx, spanDeg) {
  const w = Number(containerWidthPx);
  if (!(w > 0)) return 2.5; // graceful-zero contract: fractional default
  const span = Number(spanDeg) > 0 ? Number(spanDeg) : 360;
  const z = Math.log2((360 * w) / (256 * span));
  const q = Math.round(z * 4) / 4; // zoomSnap 0.25 grid
  return Math.max(1, Math.min(4.5, q));
}

// ---------------------------------------------------------------------------
// 13. versionCompatible — refuse to derive on a dataset/rules skew (§8.1).
// ---------------------------------------------------------------------------
export function versionCompatible(room, bundled) {
  return (
    !!room &&
    !!bundled &&
    room.datasetVersion === bundled.datasetVersion &&
    room.rulesVersion === bundled.rulesVersion
  );
}
