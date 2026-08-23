// flag-ui.js — the Flag Reveal player phone (every player, incl. the reveal
// owner, runs this). Logic-light glue: it wires the pure decision logic in
// js/flag.js to the DOM and to Firebase via js/firebase.js. Every rule calls
// into flag.js; this file owns no game logic.
//
// The hard contracts it upholds (SPEC-v3.1 §3/§4/§5/§13):
//   - Phase-changing writes are the three transactions in firebase.js only;
//     this file never bare-writes a phase.
//   - The reveal owner CANCELS its cadence/hold timers BEFORE attempting its
//     own resolveRound/advanceRound (same-client "set"-cancel rule, §2).
//   - The win path branches the full abort taxonomy (§4.2): benign aborts
//     retry, an own-team pre-existing win renders "you won", only a genuinely
//     advanced round renders "round over".
//   - PRIVACY (§5.2): no renderer and no live-play decision reads
//     round/private/*. The ONLY private read here is the owning phone
//     restoring ITS OWN lockout on resume (explicitly allowed, §5.1).
//   - The clock is subscribed from .info/serverTimeOffset; atStep is never
//     sent from the client (the transaction reads it from the snapshot).

import {
  writeRoom,
  updateRoom,
  subscribeRoom,
  claimTeamSlot,
  resolveRound,
  advanceRound,
  subscribeServerTimeOffset,
  onConnectionChange,
  subscribeHeartbeat,
} from "./firebase.js";
import {
  roundConduct,
  gameWinner,
  carryStandings,
  chooseOptions,
  choiceUnlocked,
  buildAnswerIndex,
  normalizeName,
  hash,
  versionCompatible,
} from "./flag.js";
import { renderReveal } from "./reveal-render.js";
import { FLAGS, byIso2 } from "./flags-data.js";
import { makeRoomCode, isValidRoomCode, deviceId } from "./roomcode.js";
import { GAME_DEFAULTS, BUNDLED_VERSIONS } from "../config.js";
import { track, openBanner } from "./consent.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const dev = deviceId();
let code = null;
let room = null;
let myTeam = null;
let myName = "";
let wantJoin = false; // joining and not yet holding a slot
let cfg = defaultCfg();

let serverTimeOffset = 0;
const serverNow = () => Date.now() + serverTimeOffset;

let screenBeatAt = 0;
const screenLive = () => Date.now() - screenBeatAt < 10000;
const modeStr = () => (screenLive() ? "tv" : "phone");

// Cadence / transaction sequencing
let cadenceTimer = null;
let opInFlight = false;

// Per-round local state
let currentRoundNumber = null;
let myLockRound = null; // the round number this phone is locked out of
let winState = null; // {roundNumber, phase:'trying'|'won'|'lost'|'bust'|'over'}
let winAttempts = 0;

// Emission dedup
const emittedRounds = new Set(); // roundKey → flag_round emitted
const ringed = new Set(); // `${roundKey}:${correct}` → flag_ring emitted
let committedOutcome = null; // {number, kind} when MY transaction committed

// Typeahead source
const NAMES = FLAGS.map((f) => ({ iso2: f.iso2, name: f.name }));
const NAME_INDEX = FLAGS.map((f) => ({
  iso2: f.iso2,
  name: f.name,
  keys: [f.name, ...(f.aliases || [])].map(normalizeName),
}));
void buildAnswerIndex; // index built lazily where the free-text mode would use it

const LS_SESSION = "flagreveal_session";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function defaultCfg() {
  const d = GAME_DEFAULTS;
  return {
    steps: d.STEPS,
    base: d.BASE,
    min: d.MIN,
    stepMs: d.stepMs,
    graceMs: d.graceMs,
    autoAdvanceMs: d.autoAdvanceMs,
    target: d.target,
    roundCount: d.roundCount,
    difficulty: d.difficulty,
    inputMode: d.inputMode,
    choiceUnlockStep: d.choiceUnlockStep,
    gridN: d.gridN,
    revealAspect: d.revealAspect,
    gameSeed: null,
    pool: FLAGS,
    now: 0,
  };
}

function cfgFromRoom(r) {
  const s = (r && r.settings) || {};
  const d = GAME_DEFAULTS;
  return {
    steps: s.steps || d.STEPS,
    base: s.base || d.BASE,
    min: s.min || d.MIN,
    stepMs: s.stepMs || d.stepMs,
    graceMs: s.graceMs || d.graceMs,
    autoAdvanceMs: s.autoAdvanceMs || d.autoAdvanceMs,
    target: s.target != null ? s.target : d.target,
    roundCount: s.roundCount != null ? s.roundCount : d.roundCount,
    difficulty: s.difficulty || d.difficulty,
    inputMode: s.inputMode || d.inputMode,
    choiceUnlockStep: s.choiceUnlockStep || d.choiceUnlockStep,
    gridN: s.gridN || d.gridN,
    revealAspect: s.revealAspect || d.revealAspect,
    gameSeed: r ? r.gameSeed : null,
    pool: FLAGS,
    now: 0,
  };
}

// A cfg snapshot carrying a server-corrected `now` for transaction-authored
// timestamps (§1.4 — these land as writer offset-estimates, tolerated by the
// ≥3·graceMs deadline slack).
const cfgNow = () => ({ ...cfg, now: serverNow() });

const roundKey = (n) => String(hash(cfg.gameSeed, n));
const isOwner = () => !!myTeam && !!room && room.hostTeam === myTeam;

function makeSeed() {
  return "g-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const SCREENS = ["p-home", "p-lobby", "p-round", "p-reveal", "p-gameover"];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
function setStatus(msg) {
  $("roundStatus").textContent = msg || "";
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
function saveSession() {
  try {
    localStorage.setItem(LS_SESSION, JSON.stringify({ code, team: myTeam }));
  } catch {
    /* private mode */
  }
}
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSION) || "null");
  } catch {
    return null;
  }
}
function clearSession() {
  try {
    localStorage.removeItem(LS_SESSION);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Cadence (reveal owner only) + same-client cancel discipline (§2)
// ---------------------------------------------------------------------------
function stopCadence() {
  if (cadenceTimer) {
    clearTimeout(cadenceTimer);
    cadenceTimer = null;
  }
}
// The one client that mixes plain writes with its own transactions is the
// reveal owner. Cancel timers BEFORE any transaction this phone attempts, so a
// stray cadence tick can't cancel the owner's own resolve/advance with "set".
function cancelOwnerTimers() {
  stopCadence();
}
function scheduleCadence() {
  stopCadence();
  cadenceTimer = setTimeout(tickCadence, cfg.stepMs);
}
function tickCadence() {
  cadenceTimer = null;
  const gs = room && room.gameState;
  if (!gs || gs.phase !== "roundActive") return;
  const r = gs.round;
  if (!r || r.outcome != null || !isOwner()) return;
  if (r.currentStep < cfg.steps) {
    updateRoom(code, {
      "gameState/round/currentStep": r.currentStep + 1,
      "gameState/round/stepStartedAt": serverNow(),
    });
    if (r.currentStep + 1 < cfg.steps) scheduleCadence();
  }
}
function syncCadence() {
  const gs = room && room.gameState;
  const r = gs && gs.round;
  const shouldRun =
    isOwner() &&
    gs &&
    gs.phase === "roundActive" &&
    r &&
    r.outcome == null &&
    r.currentStep < cfg.steps;
  if (shouldRun && !cadenceTimer) scheduleCadence();
  if (!shouldRun && cadenceTimer && (!gs || gs.phase !== "roundActive")) {
    stopCadence();
  }
}

// ---------------------------------------------------------------------------
// roundConduct — per-snapshot fallback transaction attempts (§4.4)
// ---------------------------------------------------------------------------
function runConduct() {
  const gs = room && room.gameState;
  if (!gs) return;
  const r = gs.round;
  const action = roundConduct(gs, serverNow(), isOwner(), cfg);
  if (action === "continue" || opInFlight) return;

  if (action === "resolve-bust") {
    opInFlight = true;
    cancelOwnerTimers(); // §2: cancel plain-write timers before our transaction
    resolveRound(code, { kind: "bust", roundNumber: r.number }, cfgNow())
      .then((committed) => {
        if (committed) committedOutcome = { number: r.number, kind: "bust" };
      })
      .catch(() => {})
      .finally(() => {
        opInFlight = false;
      });
  } else if (action === "advance") {
    opInFlight = true;
    cancelOwnerTimers();
    advanceRound(code, r.number, cfgNow())
      .catch(() => {})
      .finally(() => {
        opInFlight = false;
      });
  }
}

// ---------------------------------------------------------------------------
// Ringing (§4.2)
// ---------------------------------------------------------------------------
function commitGuess(iso2, displayedStep) {
  const gs = room && room.gameState;
  const r = gs && gs.round;
  if (!iso2 || !r || gs.phase !== "roundActive" || r.outcome != null) return;
  if (myLockRound === r.number) return; // already locked out this round
  if (winState && winState.roundNumber === r.number && winState.phase === "trying") {
    return; // a win attempt is already in flight
  }

  if (iso2 === r.answerIso) {
    attemptWin(r.number, r.currentStep);
  } else {
    // Wrong ring: lock self out, write own private lockout (§5). No other phone
    // or renderer reads this during the round.
    myLockRound = r.number;
    updateRoom(code, {
      ["gameState/round/private/" + myTeam]: {
        lockedRound: r.number,
        wrongStep: displayedStep,
        wrongIso: iso2,
      },
    });
    emitRing({ correct: false, contested: false, atStep: displayedStep, points: 0 }, r.number);
    setStatus("Wrong — you're locked out this round. 🙈");
    renderRoundControls();
  }
}

function attemptWin(roundNumber, displayedStep) {
  winState = { roundNumber, phase: "trying" };
  winAttempts = 0;
  cancelOwnerTimers(); // §2: owner cancels before its own transaction
  setStatus("Ringing in…");
  doWinAttempt(roundNumber, displayedStep);
}

function retryWin(roundNumber, displayedStep) {
  const gs = room && room.gameState;
  const r = gs && gs.round;
  const stillLive =
    !gs ||
    (gs.phase === "roundActive" && r && r.number === roundNumber && r.outcome == null);
  if (stillLive && winAttempts++ < 40) {
    setTimeout(() => doWinAttempt(roundNumber, displayedStep), 120);
  }
}

function doWinAttempt(roundNumber, displayedStep) {
  resolveRound(code, { kind: "win", team: myTeam, roundNumber }, cfgNow())
    .then((committed) => {
      if (committed) {
        committedOutcome = { number: roundNumber, kind: "win" };
        winState = { roundNumber, phase: "won" };
        return; // the reveal (and emission) render when the snapshot flips
      }
      // Aborted — branch the full taxonomy (§4.2) on the LATEST snapshot.
      const gs = room && room.gameState;
      const r = gs && gs.round;
      const oc = r && r.outcome;
      if (
        !gs ||
        (gs.phase === "roundActive" && r && r.number === roundNumber && oc == null)
      ) {
        retryWin(roundNumber, displayedStep); // a/b/c benign → retry
        return;
      }
      if (oc && oc.kind === "win" && oc.team === myTeam) {
        // e: my commit landed but the ack was lost — you won.
        committedOutcome = committedOutcome || { number: roundNumber, kind: "win" };
        winState = { roundNumber, phase: "won" };
        return;
      }
      if (oc && oc.kind === "win") {
        // d: rival beat me — a correct-but-losing (contested) ring.
        winState = { roundNumber, phase: "lost" };
        emitRing(
          { correct: true, contested: true, atStep: displayedStep, points: 0 },
          roundNumber
        );
        setStatus("So close — someone rang first! 😤");
        return;
      }
      if (oc && oc.kind === "bust") {
        winState = { roundNumber, phase: "bust" };
        setStatus("Round busted before it landed.");
        return;
      }
      winState = { roundNumber, phase: "over" }; // g: genuinely advanced
    })
    .catch(() => retryWin(roundNumber, displayedStep));
}

function emitRing({ correct, contested, atStep, points }, roundNumber) {
  const rk = roundKey(roundNumber);
  const k = rk + ":" + (correct ? 1 : 0);
  if (ringed.has(k)) return;
  ringed.add(k);
  track("flag_ring", {
    mode: modeStr(),
    team: myTeam,
    atStep,
    correct,
    points,
    contested,
    difficulty: cfg.difficulty,
    inputMode: cfg.inputMode,
    roundKey: rk,
  });
}

// ---------------------------------------------------------------------------
// Join / create / resume
// ---------------------------------------------------------------------------
async function createRoom() {
  const difficulty = $("createDifficulty").value;
  const inputMode = $("createInput").value;
  myName = ($("homeName").value || "").trim() || "Player 1";
  const d = GAME_DEFAULTS;
  const settings = {
    roundCount: d.roundCount,
    target: d.target,
    stepMs: d.stepMs,
    gridN: d.gridN,
    revealAspect: d.revealAspect,
    base: d.BASE,
    min: d.MIN,
    steps: d.STEPS,
    choiceUnlockStep: d.choiceUnlockStep,
    scoreProfile: "standard",
    difficulty,
    inputMode,
  };
  const c = makeRoomCode();
  const state = {
    createdAt: Date.now(),
    mode: "flag",
    gameSeed: makeSeed(),
    datasetVersion: BUNDLED_VERSIONS.datasetVersion,
    rulesVersion: BUNDLED_VERSIONS.rulesVersion,
    settings,
    hostTeam: "t1",
    gameState: { phase: "lobby", teams: {} },
  };
  try {
    await writeRoom(c, state);
    const ok = await claimTeamSlot(c, "t1", { name: myName, deviceId: dev, total: 0 });
    if (!ok) throw new Error("could not claim host slot");
  } catch {
    $("createErr").textContent = "Couldn't create the room. Check your connection.";
    return;
  }
  myTeam = "t1";
  track("front_door_create", { mode: "phone" });
  enterRoom(c);
  saveSession();
}

function joinRoom(c, name) {
  myName = (name || "").trim() || "Player";
  wantJoin = true;
  enterRoom(c);
}

// Claim (or resume) a slot once we can see room state.
async function tryClaim() {
  if (!wantJoin || myTeam || !room) return;
  const gs = room.gameState || {};
  if (!versionCompatible(room, BUNDLED_VERSIONS)) {
    $("joinErr").textContent = "Update your app to join this game.";
    wantJoin = false;
    return;
  }
  const teams = gs.teams || {};
  // Resume: a slot already carries my device (e.g. a carried "play again" slot).
  for (const tN of ["t1", "t2", "t3", "t4"]) {
    if (teams[tN] && teams[tN].deviceId === dev) {
      myTeam = tN;
      wantJoin = false;
      saveSession();
      return;
    }
  }
  // Otherwise claim the first free slot.
  for (const tN of ["t1", "t2", "t3", "t4"]) {
    if (!teams[tN]) {
      const ok = await claimTeamSlot(code, tN, { name: myName, deviceId: dev, total: 0 });
      if (ok) {
        myTeam = tN;
        wantJoin = false;
        saveSession();
        track("team_joined", {
          mode: modeStr(),
          team_count: Object.keys(room.gameState.teams || {}).length,
        });
        return;
      }
    }
  }
  if (!myTeam) {
    $("joinErr").textContent = "Room is full (4 players max).";
    wantJoin = false;
  }
}

let unsubRoom = null;
function enterRoom(c2) {
  code = c2;
  if (unsubRoom) unsubRoom();
  subscribeServerTimeOffset((off) => {
    serverTimeOffset = off || 0;
  });
  onConnectionChange((up) => {
    $("connPill").classList.toggle("hidden", up);
  });
  subscribeHeartbeat(code, (ts) => {
    if (ts) screenBeatAt = Date.now();
  });
  unsubRoom = subscribeRoom(code, onSnapshot);
}

function leaveRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = null;
  stopCadence();
  clearSession();
  code = null;
  room = null;
  myTeam = null;
  wantJoin = false;
  location.href = "player.html";
}

// ---------------------------------------------------------------------------
// The snapshot handler — the single render entry point
// ---------------------------------------------------------------------------
function onSnapshot(snap) {
  room = snap;
  if (!room) {
    // Room vanished (or never existed).
    if (wantJoin) $("joinErr").textContent = "No such room.";
    return;
  }
  cfg = cfgFromRoom(room);

  // Follow a finished room's pointer to the next game.
  if (room.nextRoom && isValidRoomCode(room.nextRoom) && room.nextRoom !== code) {
    location.href = "player.html?room=" + room.nextRoom;
    return;
  }

  if (wantJoin && !myTeam) {
    // Claiming/resuming may set myTeam without producing a new write (the resume
    // path finds an existing slot), so re-render when it settles rather than
    // relying on another snapshot.
    tryClaim().then(() => {
      render();
      syncCadence();
      runConduct();
    });
  }

  render();
  syncCadence();
  runConduct();
}

function render() {
  const gs = room.gameState || {};
  const phase = gs.phase || "lobby";

  if (!myTeam) {
    // Still on home until we hold a slot.
    return;
  }

  if (phase === "lobby") {
    renderLobby(gs);
    showScreen("p-lobby");
  } else if (phase === "roundActive") {
    prepRound(gs);
    renderRound(gs);
    showScreen("p-round");
  } else if (phase === "reveal") {
    renderRevealScreen(gs);
    showScreen("p-reveal");
  } else if (phase === "gameOver") {
    renderGameOver(gs);
    showScreen("p-gameover");
  }
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function renderLobby(gs) {
  $("lobbyCode").textContent = code;
  $("lobbyMode").textContent = screenLive()
    ? "📺 A TV is connected — eyes up there."
    : "📱 No TV — the flag reveals on your phone.";
  const teams = gs.teams || {};
  const ul = $("lobbyTeams");
  ul.innerHTML = "";
  for (const tN of ["t1", "t2", "t3", "t4"]) {
    const t = teams[tN];
    if (!t) continue;
    const li = document.createElement("li");
    li.className = "team-row team-" + tN.slice(1);
    const you = tN === myTeam ? " (you)" : "";
    const host = room.hostTeam === tN ? " 👑" : "";
    li.textContent = `${t.name}${you}${host}`;
    ul.appendChild(li);
  }
  const owner = isOwner();
  const enough = Object.keys(teams).length >= 1;
  $("btnStart").classList.toggle("hidden", !(owner && enough));
  $("lobbyNote").textContent = owner
    ? "Start when everyone's in."
    : "Waiting for the host to start…";
}

// ---------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------
function prepRound(gs) {
  const r = gs.round;
  if (!r) return;
  if (currentRoundNumber !== r.number) {
    currentRoundNumber = r.number;
    winState = null;
    myLockRound = null;
    committedOutcome = committedOutcome && committedOutcome.number === r.number ? committedOutcome : null;
    const inp = $("buzzInput");
    if (inp) inp.value = "";
    hideSuggest();
    setStatus("");
  }
  // Restore MY OWN lockout across a refresh — allowed for the owning phone only
  // (§5.1), filtered on lockedRound === round.number.
  const mine = r.private && r.private[myTeam];
  if (mine && mine.lockedRound === r.number) myLockRound = r.number;
}

function renderRound(gs) {
  const r = gs.round;
  if (!r) return;
  const effRounds = Math.min(cfg.roundCount, poolSize());
  $("roundHeader").textContent = `Round ${r.number}${effRounds ? " / " + effRounds : ""}`;
  $("roundMode").textContent = screenLive() ? "📺 on the TV" : "📱 on your phone";

  // Reveal render (used when there's no TV; harmless mirror when there is).
  renderReveal($("roundReveal"), {
    flagSeed: r.flagSeed,
    currentStep: r.currentStep,
    gridN: cfg.gridN,
    steps: cfg.steps,
    iso2: r.answerIso,
    revealAspect: cfg.revealAspect,
    full: false,
  });

  renderRoundControls();
}

function renderRoundControls() {
  const gs = room.gameState || {};
  const r = gs.round;
  if (!r) return;
  const locked =
    myLockRound === r.number ||
    (winState && winState.roundNumber === r.number && winState.phase !== "trying" && winState.phase !== "won");

  if (cfg.inputMode === "choice") {
    $("buzzTypeahead").classList.add("hidden");
    $("buzzChoice").classList.remove("hidden");
    renderChoices(r, locked);
  } else {
    $("buzzChoice").classList.add("hidden");
    $("buzzTypeahead").classList.remove("hidden");
    $("buzzInput").disabled = !!locked;
    if (locked) hideSuggest();
  }
}

function renderChoices(r, locked) {
  const box = $("choiceButtons");
  const unlocked = choiceUnlocked(r.currentStep, cfg);
  if (box._seed !== r.flagSeed) {
    box.innerHTML = "";
    const opts = chooseOptions(r.flagSeed >>> 0, r.answerIso, FLAGS);
    for (const iso of opts) {
      const b = document.createElement("button");
      b.className = "choice-btn";
      const e = byIso2(iso);
      b.textContent = e ? e.name : iso.toUpperCase();
      b.dataset.iso = iso;
      b.addEventListener("click", () => commitGuess(iso, r.currentStep));
      box.appendChild(b);
    }
    box._seed = r.flagSeed;
  }
  for (const b of box.children) b.disabled = locked || !unlocked;
  $("choiceLock").textContent = unlocked
    ? "Tap the country!"
    : "👀 Look at the flag first!";
}

// ---------------------------------------------------------------------------
// Typeahead
// ---------------------------------------------------------------------------
function suggestFor(query) {
  const q = normalizeName(query);
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const e of NAME_INDEX) {
    let rank = 2;
    for (const k of e.keys) {
      if (k.startsWith(q)) {
        rank = Math.min(rank, 0);
        break;
      }
      if (k.includes(q)) rank = Math.min(rank, 1);
    }
    if (rank === 0) starts.push(e);
    else if (rank === 1) contains.push(e);
  }
  return starts.concat(contains).slice(0, 6);
}
function renderSuggest(query) {
  const gs = room && room.gameState;
  const r = gs && gs.round;
  if (!r) return;
  const list = suggestFor(query);
  const ul = $("buzzSuggest");
  ul.innerHTML = "";
  if (!list.length) {
    hideSuggest();
    return;
  }
  for (const e of list) {
    const li = document.createElement("li");
    li.textContent = e.name;
    li.dataset.iso = e.iso2;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      commitFromInput(e.iso2);
    });
    ul.appendChild(li);
  }
  ul.classList.remove("hidden");
}
function hideSuggest() {
  const ul = $("buzzSuggest");
  if (ul) ul.classList.add("hidden");
}
function commitFromInput(iso2) {
  const gs = room && room.gameState;
  const r = gs && gs.round;
  if (!r) return;
  $("buzzInput").value = "";
  hideSuggest();
  commitGuess(iso2, r.currentStep);
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------
function renderRevealScreen(gs) {
  const r = gs.round;
  if (!r) return;
  const oc = r.outcome || {};
  const teams = gs.teams || {};
  const answer = byIso2(r.answerIso);

  // At-most-once analytics for the committing phone + the winner's own ring.
  emitRevealAnalytics(gs, r, oc);

  $("revealHeader").textContent = `Round ${r.number}`;
  renderReveal($("revealFlag"), {
    flagSeed: r.flagSeed,
    gridN: cfg.gridN,
    steps: cfg.steps,
    iso2: r.answerIso,
    revealAspect: cfg.revealAspect,
    full: true,
  });
  $("revealAnswer").textContent = answer ? answer.name : r.answerIso.toUpperCase();

  const resultEl = $("revealResult");
  if (oc.kind === "win") {
    const wt = teams[oc.team];
    const pts = (r.results && r.results[oc.team] && r.results[oc.team].points) || 0;
    const mine = oc.team === myTeam;
    resultEl.textContent = mine
      ? `🎉 You got it at step ${oc.atStep} — +${pts}!`
      : `${wt ? wt.name : oc.team} rang it at step ${oc.atStep} — +${pts}.`;
    resultEl.className = "reveal-result " + (mine ? "good" : "");
  } else {
    resultEl.textContent = `Nobody got it — it was ${answer ? answer.name : ""}! 🙈`;
    resultEl.className = "reveal-result bad";
  }

  renderBoard($("revealBoard"), teams);
  renderBeats($("revealBeats"), r.results || {}, teams);

  // Owner controls + auto-advance note.
  const owner = isOwner();
  $("btnNext").classList.toggle("hidden", !owner);
  $("btnHold").classList.toggle("hidden", !owner || r.autoAdvanceAt == null);
  if (r.autoAdvanceAt == null) {
    $("revealNote").textContent = owner ? "Held. Tap Next when ready." : "Host is holding the reveal…";
  } else {
    const left = Math.max(0, Math.ceil((r.autoAdvanceAt - serverNow()) / 1000));
    $("revealNote").textContent = `Next round in ${left}s…`;
  }
}

function emitRevealAnalytics(gs, r, oc) {
  const rk = roundKey(r.number);
  // The winner's own correct ring.
  if (oc.kind === "win" && oc.team === myTeam) {
    const pts = (r.results && r.results[myTeam] && r.results[myTeam].points) || 0;
    emitRing({ correct: true, contested: false, atStep: oc.atStep, points: pts }, r.number);
  }
  // flag_round — only the phone whose transaction committed, at most once.
  if (committedOutcome && committedOutcome.number === r.number && !emittedRounds.has(rk)) {
    emittedRounds.add(rk);
    const results = r.results || {};
    let ringCount = 0;
    for (const t of Object.keys(results)) {
      if (results[t] && (results[t].correct || results[t].rangOut)) ringCount++;
    }
    track("flag_round", {
      mode: modeStr(),
      outcome: oc.kind === "win" ? "won" : "busted",
      winningStep: oc.kind === "win" ? oc.atStep : null,
      ringCount,
      difficulty: cfg.difficulty,
      inputMode: cfg.inputMode,
      roundNumber: r.number,
      roundKey: rk,
    });
  }
}

function renderBoard(ul, teams) {
  ul.innerHTML = "";
  const rows = Object.keys(teams)
    .map((tN) => ({ tN, ...teams[tN] }))
    .sort((a, b) => (b.total || 0) - (a.total || 0));
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "team-row team-" + row.tN.slice(1);
    const you = row.tN === myTeam ? " (you)" : "";
    li.innerHTML = `<span>${escapeHtml(row.name)}${you}</span><span class="score">${row.total || 0}</span>`;
    ul.appendChild(li);
  }
}

function renderBeats(box, results, teams) {
  box.innerHTML = "";
  for (const tN of Object.keys(results)) {
    const res = results[tN];
    if (res && res.rangOut && res.wrongIso) {
      const t = teams[tN];
      const wrong = byIso2(res.wrongIso);
      const div = document.createElement("div");
      div.className = "beat";
      div.textContent = `😅 ${t ? t.name : tN} rang ${
        wrong ? wrong.name : res.wrongIso.toUpperCase()
      } at step ${res.wrongStep}`;
      box.appendChild(div);
    }
  }
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function renderGameOver(gs) {
  const teams = gs.teams || {};
  const winner = gameWinner(teams, cfg);
  const wt = teams[winner];
  const iWon = winner === myTeam;
  $("goWinner").textContent = wt
    ? `${iWon ? "👑 You win" : "👑 " + wt.name + " wins"} — ${wt.total || 0} pts!`
    : "—";
  renderBoard($("goBoard"), teams);
  $("btnPlayAgain").classList.toggle("hidden", !iWon);
}

async function playAgain() {
  const gs = room.gameState || {};
  const teams = gs.teams || {};
  const winner = gameWinner(teams, cfg);
  if (winner !== myTeam) return;
  const { teams: newTeams, hostTeam } = carryStandings(teams, winner);
  const c2 = makeRoomCode();
  const state = {
    createdAt: Date.now(),
    mode: "flag",
    gameSeed: makeSeed(),
    datasetVersion: BUNDLED_VERSIONS.datasetVersion,
    rulesVersion: BUNDLED_VERSIONS.rulesVersion,
    settings: room.settings,
    hostTeam,
    gameState: { phase: "lobby", teams: newTeams },
  };
  try {
    await writeRoom(c2, state);
    await updateRoom(code, { nextRoom: c2 }); // subscribers follow the pointer
    track("next_game", { mode: modeStr() });
    location.href = "player.html?room=" + c2;
  } catch {
    toast("Couldn't start the next game.");
  }
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------
function poolSize() {
  const diff = cfg.difficulty;
  return FLAGS.filter(
    (f) => f.eligible !== false && (diff === "world" || f.tier === diff)
  ).length;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

// ---------------------------------------------------------------------------
// Wire the DOM + boot
// ---------------------------------------------------------------------------
function wire() {
  $("btnShowCreate").addEventListener("click", () => {
    $("createPanel").classList.toggle("hidden");
  });
  $("btnCreate").addEventListener("click", createRoom);
  $("btnJoin").addEventListener("click", () => {
    const c2 = ($("homeCode").value || "").trim().toUpperCase();
    if (!isValidRoomCode(c2)) {
      $("joinErr").textContent = "Enter a 6-letter room code.";
      return;
    }
    track("front_door_join", { mode: "phone" });
    joinRoom(c2, $("homeName").value);
  });
  $("homeCode").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  $("btnLeave").addEventListener("click", leaveRoom);
  $("btnStart").addEventListener("click", () => {
    cancelOwnerTimers();
    advanceRound(code, 0, cfgNow()).catch(() => toast("Couldn't start."));
  });

  // Buzzer typeahead
  const inp = $("buzzInput");
  inp.addEventListener("input", () => renderSuggest(inp.value));
  inp.addEventListener("focus", () => renderSuggest(inp.value));
  inp.addEventListener("blur", () => setTimeout(hideSuggest, 120));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const list = suggestFor(inp.value);
      if (list.length) commitFromInput(list[0].iso2);
    } else if (e.key === "Escape") {
      hideSuggest();
    }
  });

  // Reveal controls
  $("btnNext").addEventListener("click", () => {
    const r = room.gameState && room.gameState.round;
    if (!r) return;
    cancelOwnerTimers();
    advanceRound(code, r.number, cfgNow()).catch(() => {});
  });
  $("btnHold").addEventListener("click", () => {
    updateRoom(code, { "gameState/round/autoAdvanceAt": null }).catch(() => {});
  });

  // Game over
  $("btnPlayAgain").addEventListener("click", playAgain);
  $("btnNewGame").addEventListener("click", () => {
    clearSession();
    location.href = "player.html";
  });

  $("btnPrivacy").addEventListener("click", openBanner);

  // Resume banner / URL routing.
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get("room") || "").toUpperCase();
  if (params.get("create") === "1") {
    $("createPanel").classList.remove("hidden");
  }
  if (isValidRoomCode(urlRoom)) {
    joinRoom(urlRoom, "");
    return;
  }
  const sess = loadSession();
  if (sess && isValidRoomCode(sess.code)) {
    $("resumeCode").textContent = sess.code;
    $("pResume").classList.remove("hidden");
    $("btnResume").addEventListener("click", () => joinRoom(sess.code, ""));
  }
}

// Keep the reveal-note countdown ticking even without new snapshots.
setInterval(() => {
  if (room && room.gameState && room.gameState.phase === "reveal") {
    const r = room.gameState.round;
    if (r && r.autoAdvanceAt != null) {
      const left = Math.max(0, Math.ceil((r.autoAdvanceAt - serverNow()) / 1000));
      const note = $("revealNote");
      if (note && !$("p-reveal").classList.contains("hidden")) {
        note.textContent = `Next round in ${left}s…`;
      }
    }
    runConduct(); // ensure a dead-owner fallback still fires on a quiet feed
  } else if (room && room.gameState && room.gameState.phase === "roundActive") {
    runConduct(); // non-owner bust deadline can pass with no new snapshot
  }
}, 1000);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire, { once: true });
} else {
  wire();
}

// Referenced only to satisfy the NAMES export intent (kept for the free-text
// alias path documented in flag.js §1.6); avoids an unused-import lint.
void NAMES;
