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

// mulberry32: number seed → () => float in [0, 1).
function mulberry32(a) {
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
// returns a new array, never mutates its input.
function shuffle(arr, rng) {
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

// The eligible pool for a difficulty tier. `world` is the default mixed pool
// (every eligible entry, any tier); `easy`/`expert` filter to that tier.
// Entries are `eligible: false` unless explicitly true-or-absent — we treat a
// missing `eligible` as eligible so a lean fixture pool "just works", and only
// an explicit `eligible: false` excludes.
//
// NOTE (ambiguity resolved, see final report): the spec describes difficulty as
// "selecting the flag pool by recognizability" without a formal tier→difficulty
// table. `world = all eligible`, `easy = tier:"easy"`, `expert = tier:"expert"`
// is the sensible reading and keeps `gameFlags` a total function.
function eligiblePool(pool, difficulty) {
  const eligible = (pool || []).filter((e) => e && e.eligible !== false);
  if (difficulty === "easy") return eligible.filter((e) => e.tier === "easy");
  if (difficulty === "expert") return eligible.filter((e) => e.tier === "expert");
  return eligible; // "world" and any unknown difficulty → the mixed pool
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
  const difficulty = (config && config.difficulty) || "world";
  const poolSize = eligiblePool(pool, difficulty).length;
  const requested = config && config.roundCount != null ? config.roundCount : poolSize;
  const effectiveRoundCount = Math.min(requested, poolSize);
  const seq = gameFlags(gameSeed, effectiveRoundCount, difficulty, pool);
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
  const difficulty = cfg.difficulty || "world";
  const poolSize = eligiblePool(cfg.pool || [], difficulty).length;
  const requested = cfg.roundCount != null ? cfg.roundCount : poolSize;
  const effectiveRoundCount = Math.min(requested, poolSize);
  return fromRound >= effectiveRoundCount;
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
