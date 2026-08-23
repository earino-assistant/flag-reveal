// firebase.js — Firebase init + typed room helpers for Flag Reveal.
//
// This is the ONLY module that imports the Firebase SDK (pinned CDN, 10.12.2,
// app + database only — matching GeoParty). `roomRef()` is the sole room-path
// composer, so every read/write/subscribe/transaction lives under `rooms/`.
//
// Flag Reveal reuses the GeoParty sync kernel but adds a first-class contended-
// write primitive GeoParty lacks: epoch-guarded terminal-outcome arbitration
// over the `gameState` subtree. There are exactly THREE transactional writes —
// `claimTeamSlot`, `resolveRound` (roundActive → reveal; win OR bust), and
// `advanceRound` (lobby/reveal → roundActive/gameOver). Every other write is a
// bare `update()`/`set()`. The pure decision cores live in `js/flag.js`
// (`resolveOutcome`, `advanceState`); this layer owns no logic — it only wraps
// them in `runTransaction(..., {applyLocally:false})` and returns
// `res.committed` so the CALLER decides retry vs. mis-render (§4.2).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../config.js";
import { resolveOutcome, advanceState } from "./flag.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// roomRef() is the single choke point every room read/write/subscribe/
// transaction routes through — the one place a Firebase path is composed, so
// every room lives under `rooms/`, always.
export function roomRef(code, path = "") {
  return ref(db, `rooms/${code}${path ? "/" + path : ""}`);
}

export async function readRoom(code) {
  const snap = await get(roomRef(code));
  return snap.exists() ? snap.val() : null;
}

export function writeRoom(code, state) {
  return set(roomRef(code), state);
}

// Multi-path update relative to the room root, e.g.
// updateRoom("KWPF", { "gameState/round/currentStep": 4 }). The ONLY non-
// transactional writer into gameState (cadence, wrong-ring private/*, S6 hold).
// It NEVER changes phase — every phase-changing write is a transaction below.
export function updateRoom(code, patch) {
  return update(roomRef(code), patch);
}

export function deleteRoom(code) {
  return remove(roomRef(code));
}

// Subscribe to full room state. Returns an unsubscribe function.
export function subscribeRoom(code, callback) {
  return onValue(roomRef(code), (snap) => {
    callback(snap.exists() ? snap.val() : null);
  });
}

// ---------------------------------------------------------------------------
// The three transactional writes — the ONLY non-`update()` writes to gameState.
// ---------------------------------------------------------------------------

// Atomic claim of a free team slot. The transaction commits ONLY if the slot is
// still empty, so two phones racing for t2 can't both land on it — the loser
// sees `res.committed === false` and retries on the next free slot. In Flag
// Reveal the slot lives under gameState (its common ancestor with round/results
// for the resolution transaction), so this transacts gameState/teams/{teamId}
// (spec §2). Guard-local degenerate case of the kernel's compare-and-set.
export async function claimTeamSlot(code, teamId, team) {
  const res = await runTransaction(
    roomRef(code, `gameState/teams/${teamId}`),
    (cur) => {
      if (cur !== null) return undefined; // taken — abort
      return team;
    }
  );
  return res.committed;
}

// resolveRound — the terminal-outcome transaction (roundActive → reveal, win OR
// bust). Only a phone that evaluated its OWN guess as correct calls with
// {kind:"win", team, roundNumber}; the owner/fallbacks call with
// {kind:"bust", roundNumber}. `resolveOutcome` (pure, flag.js) commits ONLY when
// phase === "roundActive", round.number matches, and outcome == null; whichever
// terminal outcome the server serializes first wins, and stale/duplicate ops
// abort. `atStep` is read from the SERVER snapshot's currentStep, never a client
// value.
//
// applyLocally:false is MANDATORY. The default (true) optimistically applies the
// updater's result to the local cache and fires local onValue events on the
// ancestor rooms/{CODE} subscription — so a LOSING ringer's phone would briefly
// hold a full settlement locally (phase:reveal, itself as winner, and every
// rival's private/* disclosed into results/* mid-round — a render-contract
// breach — plus a false "you won" flash) before the server rejects and re-runs.
// Returns res.committed; the CALLER handles the abort taxonomy (§4.2), never here.
export async function resolveRound(code, attempt, cfg) {
  const res = await runTransaction(
    roomRef(code, "gameState"),
    (gs) => resolveOutcome(gs, attempt, cfg),
    { applyLocally: false }
  );
  return res.committed;
}

// advanceRound — the epoch-guarded, idempotent round advance (lobby → roundActive
// for round 1, and reveal → roundActive|gameOver). Runnable by the reveal owner
// OR, past the reveal-phase dead-man deadline, ANY non-owner phone (never the
// TV). `fromRound` is the round the caller believes is current (the epoch guard);
// the fresh round is a deterministic function of (gameSeed, number), so racing
// advancers agree and the transaction makes it happen exactly once.
//
// applyLocally:false is MANDATORY here too — an optimistically-applied advance
// would flash the next round's blank state (and re-render every subscriber)
// before the server confirms the winner of the advance race. Returns
// res.committed; the CALLER decides retry vs. mis-render (§4.2).
export async function advanceRound(code, fromRound, cfg) {
  const res = await runTransaction(
    roomRef(code, "gameState"),
    (gs) => advanceState(gs, fromRound, cfg),
    { applyLocally: false }
  );
  return res.committed;
}

// ---------------------------------------------------------------------------
// Screen presence + connection/clock subscriptions.
// ---------------------------------------------------------------------------

// The ONLY thing the TV ever writes (spec §2, §3). The TV runs no transaction,
// never flips a phase, never advances — it writes only its heartbeat.
export function writeScreenHeartbeat(code) {
  return set(roomRef(code, "screenHeartbeat"), Date.now());
}

// Watch the one field the screen owns. Returns an unsubscribe function.
export function subscribeHeartbeat(code, callback) {
  return onValue(roomRef(code, "screenHeartbeat"), (snap) => {
    callback(snap.exists() ? snap.val() : null);
  });
}

// Connection status via the SDK's special path; drives the "reconnecting" pill
// on both views (spec §12). Returns an unsubscribe function.
export function onConnectionChange(callback) {
  return onValue(ref(db, ".info/connected"), (snap) => {
    callback(snap.val() === true);
  });
}

// Server-corrected clock: SUBSCRIBE to `.info/serverTimeOffset` (ms), don't read
// it once — Firebase re-estimates the offset on every reconnect, and the whole
// server-corrected-clock fix (§1.4) exists to avoid a stale one-shot skew. The
// callback fires with the current offset on subscribe and on every re-estimate;
// callers compute serverNow() = Date.now() + offset. Returns an unsubscribe fn.
export function subscribeServerTimeOffset(callback) {
  return onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
    callback(snap.val() || 0);
  });
}
