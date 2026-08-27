// tv-sound.js — the TV's room sound layer. The phone pops for the player who
// rang in; this gives the ROOM the payoff: a win sting, a bust womp, a soft
// scrubber tick as the flag uncovers, and a blip when someone joins the lobby.
//
// PASSIVE-TV CONTRACT (unchanged): this module is presentation only. It reads
// nothing from Firebase, writes nothing, runs no transaction and flips no phase.
// It is handed the state the TV already renders and decides what to sound.
//
// Shape, same as the rest of the repo: the DECISION is a pure function
// (soundState + soundDecisions — no DOM, no WebAudio, unit-tested in
// tests/tv-sound.test.js); the synthesis below is thin, best-effort glue.
//
// Audio discipline is inherited wholesale from js/ui-common.js — the same single
// AudioContext (getCtx), the same primeAudio() unlock, the same reduced-motion
// gate. Nothing here creates a second context.

import { getCtx, prefersReducedMotion } from "./ui-common.js";

// ---------------------------------------------------------------------------
// Pure core — no DOM, no WebAudio.
// ---------------------------------------------------------------------------

// Project a room snapshot down to the handful of fields that can make a sound.
// `steps` is the round length from the effective config (the glue knows it; this
// module does not read config). Pure: same snapshot in, same state out.
export function soundState(room, steps) {
  const gs = (room && room.gameState) || {};
  const r = gs.round || null;
  const teams = gs.teams || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    phase: gs.phase || "lobby",
    roundNumber: r ? num(r.number) : null,
    currentStep: r ? num(r.currentStep) : null,
    steps: num(steps) && steps > 0 ? steps : null,
    // RTDB stores no nulls: an unresolved round has NO `outcome` key at all, so
    // absent → null here (never `=== null` comparisons downstream).
    outcomeKind: (r && r.outcome && r.outcome.kind) || null,
    teamKeys: Object.keys(teams).sort(),
  };
}

// The whole decision: what should sound on the transition prev → next?
// Returns a (possibly empty) list of `{kind, ...}` descriptors.
//
//   winSting  — the round settled on a win
//   bustWomp  — the round settled on a bust
//   tick      — `currentStep` advanced during roundActive (one tick per
//               advance, even if the step jumped by more than one)
//   joinBlip  — the lobby's team set GREW
//
// `prev == null` is the first snapshot: it PRIMES the state and sounds nothing.
// A TV attaching mid-game must not sting for a round it never watched, and must
// not blip once per team already in the lobby.
export function soundDecisions(prev, next) {
  if (!next || !prev) return [];
  const out = [];
  const sameRound = prev.roundNumber === next.roundNumber;

  // Terminal outcome. Keyed on (round number, outcome kind) so a snapshot echo
  // of the same settled round never re-stings, while the NEXT round's win — the
  // same `outcomeKind` value — still does.
  if (next.outcomeKind === "win" || next.outcomeKind === "bust") {
    if (!sameRound || prev.outcomeKind !== next.outcomeKind) {
      out.push({ kind: next.outcomeKind === "win" ? "winSting" : "bustWomp" });
    }
  }

  // Scrubber tick — only a strict advance inside the SAME live round. Echoes of
  // an unchanged `currentStep` compare equal and are dropped here; the glue
  // keeps a second `lastTickStep` guard for belt and braces.
  if (
    next.phase === "roundActive" &&
    sameRound &&
    next.currentStep != null &&
    prev.currentStep != null &&
    next.currentStep > prev.currentStep
  ) {
    out.push({ kind: "tick", step: next.currentStep, steps: next.steps });
  }

  // Lobby join — diff the team KEYS, not the count: a team leaving as another
  // joins is still a join. A pure removal adds no key and stays silent.
  if (next.phase === "lobby") {
    const had = new Set(prev.teamKeys || []);
    if ((next.teamKeys || []).some((k) => !had.has(k))) out.push({ kind: "joinBlip" });
  }

  return out;
}

// The tick's pitch rises with progress through the reveal, so the room hears the
// round tightening. Pure and clamped: step 1 → TICK_LO, the last step → TICK_HI,
// and a missing/degenerate `steps` holds the low end.
export const TICK_LO_HZ = 520;
export const TICK_HI_HZ = 880;
export function tickPitch(step, steps) {
  if (!Number.isFinite(step) || !Number.isFinite(steps) || steps <= 1) return TICK_LO_HZ;
  const t = Math.max(0, Math.min(1, (step - 1) / (steps - 1)));
  return TICK_LO_HZ + (TICK_HI_HZ - TICK_LO_HZ) * t;
}

// ---------------------------------------------------------------------------
// Synthesis glue — best-effort, silent under reduced motion, never throws.
// ---------------------------------------------------------------------------

// TV speakers across a room: keep every peak under this.
const MAX_GAIN = 0.2;

// The shared context IF it is safe to schedule into right now. Same bail-and-
// nudge pattern as pop() in ui-common.js: a context that was never unlocked
// inside a real gesture (autoplay-locked) stays "suspended" — never schedule
// into it, ask for a resume so the NEXT sound can land, and return null.
function readyCtx() {
  if (prefersReducedMotion()) return null;
  const ctx = getCtx();
  if (!ctx) return null;
  if (ctx.state === "suspended") {
    if (typeof ctx.resume === "function") ctx.resume().catch(() => {});
    return null;
  }
  return ctx;
}

// One shaped note. `at` offsets from now (for two-note figures), `dur` is the
// full decay, `peak` is clamped to MAX_GAIN. Exponential ramps only (a WebAudio
// exponential ramp to 0 is illegal — hence the 0.0001 floor, as in pop()).
function note(ctx, { type = "triangle", fromHz, toHz = null, at = 0, dur, peak }) {
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, t0);
  if (toHz && toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(toHz, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.min(peak, MAX_GAIN), t0 + Math.min(0.02, dur / 3));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Win — a two-note ascending figure (C5 → G5), brighter and a good deal longer
// than the phone's single pop. This is the room's payoff moment.
export function winSting() {
  try {
    const ctx = readyCtx();
    if (!ctx) return;
    note(ctx, { fromHz: 523.25, dur: 0.17, peak: 0.17 });
    note(ctx, { fromHz: 783.99, at: 0.15, dur: 0.2, peak: 0.2 });
  } catch {
    /* audio blocked — no-op */
  }
}

// Bust — a short descending minor third (G4 → E♭4). Sympathetic, not a buzzer:
// nobody got it, the room groans together.
export function bustWomp() {
  try {
    const ctx = readyCtx();
    if (!ctx) return;
    note(ctx, { fromHz: 392.0, dur: 0.13, peak: 0.13 });
    note(ctx, { fromHz: 311.13, at: 0.12, dur: 0.18, peak: 0.14 });
  } catch {
    /* audio blocked — no-op */
  }
}

// Scrubber tick — a soft, very short blip per revealed step, pitch rising with
// progress. Quiet by design: it fires up to `steps` times a round.
export function tick(step, steps) {
  try {
    const ctx = readyCtx();
    if (!ctx) return;
    note(ctx, { fromHz: tickPitch(step, steps), dur: 0.05, peak: 0.06 });
  } catch {
    /* audio blocked — no-op */
  }
}

// Lobby join — a light rising pop, lighter than the win sting.
export function joinBlip() {
  try {
    const ctx = readyCtx();
    if (!ctx) return;
    note(ctx, { fromHz: 660, toHz: 940, dur: 0.11, peak: 0.1 });
  } catch {
    /* audio blocked — no-op */
  }
}

// Play one decision descriptor. Unknown kinds are ignored (forward-compatible).
export function playSound(d) {
  if (!d) return;
  if (d.kind === "winSting") winSting();
  else if (d.kind === "bustWomp") bustWomp();
  else if (d.kind === "tick") tick(d.step, d.steps);
  else if (d.kind === "joinBlip") joinBlip();
}

// Play a whole decision list. Wrapped so an audio failure can never break the
// render path that called it.
export function playSounds(decisions) {
  try {
    for (const d of decisions || []) playSound(d);
  } catch {
    /* audio blocked — no-op */
  }
}
