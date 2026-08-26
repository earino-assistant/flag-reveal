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
  updateRoom,
  subscribeRoom,
  claimRoomCode,
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
  hash,
  versionCompatible,
  eligiblePool,
  effectiveRoundCount,
  winAttemptOutcome,
  winRetryExhausted,
  shouldLockOut,
  guessModeLabel,
  endsGameOnAdvance,
  hostStalled,
} from "./flag.js";
import { ringEmission, revealEmission } from "./flag-analytics.js";
import { recordPartyRound, partyRecapCards, recapTeamResult } from "./partyrecap.js";
import { escapeHtml, toast, suggestFor, pop, primeAudio, vibrate } from "./ui-common.js";
import { renderReveal } from "./reveal-render.js";
import { FLAGS, byIso2, flagAssetPath } from "./flags-data.js";
import { isValidRoomCode, deviceId } from "./roomcode.js";
import { GAME_DEFAULTS, BUNDLED_VERSIONS } from "../config.js";
import { track, openBanner } from "./consent.js";
import { drawQr } from "./qr.js";
import { partyShareText, withUtm } from "./share.js";
import { shareText } from "./share-ui.js";

// Round-pace presets (host choice at room creation). The pure engine reads
// cfg.stepMs (reveal cadence + the owner bust gate) and cfg.graceMs (grace +
// the fallback deadline slack), so a pace is nothing but a locked (stepMs,
// graceMs) pair persisted into the room's settings. `label` drives the lobby
// note; the engine never sees it.
const PACE = {
  chill: { label: "Chill", stepMs: 2500, graceMs: 4000 },
  classic: { label: "Classic", stepMs: 1500, graceMs: 3000 },
  fast: { label: "Fast", stepMs: 900, graceMs: 2000 },
};
const paceOf = (id) => PACE[id] || PACE.classic;

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

// Memory-only round history for the game-over recap. Flag Party keeps only the
// CURRENT round in RTDB, so we fold each reveal into this list as the echoes
// arrive (recordPartyRound is idempotent by round number). Reset when a game
// returns to the lobby; a fresh game reloads the page anyway (see playAgain).
let partyHistory = [];

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
let gameOverEmitted = false; // game_over is emitted at-most-once by the advancer

// Typeahead source. The NAME_INDEX + suggestFor ranking now lives in
// ui-common.js (shared, identical to the Daily's); NAMES is the free-text alias
// list kept on life support for §1.6.
const NAMES = FLAGS.map((f) => ({ iso2: f.iso2, name: f.name }));
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
    multiGuess: d.multiGuess,
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
    multiGuess: s.multiGuess === true,
    pace: s.pace || "classic",
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
  // #p-create is a pre-game sibling (not a game phase); hide it whenever a real
  // phase screen takes over so it can't linger over the lobby.
  $("p-create").classList.add("hidden");
}
// Flip between the home and create screens (both pre-game). Drops the pre-paint
// html.want-create class so the CSS override yields to these .hidden toggles,
// and keeps the URL in sync so a refresh restores the same screen.
function showCreate(on, focusFirst) {
  $("p-home").classList.toggle("hidden", on);
  $("p-create").classList.toggle("hidden", !on);
  document.documentElement.classList.remove("want-create");
  try {
    history.replaceState(null, "", on ? "player.html?create=1" : "player.html");
  } catch { /* restricted history (file://) — leave the URL as-is */ }
  if (on && focusFirst) $("createDifficulty").focus();
}
function setStatus(msg) {
  $("roundStatus").textContent = msg || "";
}

// Your own correct ring gets a single subtle WebAudio pop (ui-common.pop, the
// phone's 540→900 Hz variant), once per round — poppedRound guards the repeat.
let poppedRound = null;

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
    // Does this advance end the game? Decided from the CURRENT snapshot (pure);
    // only used to emit game_over if OUR transaction is the one that commits.
    const willEnd = endsGameOnAdvance(gs, r.number, cfg);
    advanceRound(code, r.number, cfgNow())
      .then((committed) => {
        if (committed && willEnd) emitGameOver(r.number);
      })
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

  vibrate([15]); // a short tactile tick the instant a ring lands (Android)

  if (iso2 === r.answerIso) {
    attemptWin(r.number, r.currentStep);
  } else {
    // Wrong ring. In "First correct wins" (default) this locks the team out for
    // the round; in "Multiple guesses" (cfg.multiGuess) it does NOT — the team
    // keeps guessing. Either way we write the same private wrong-ring record
    // (§5): it feeds the reveal beats and the TV's transient hint, and no other
    // phone or renderer reads it during the round. The ONLY difference is the
    // local re-guess gate (myLockRound) and the copy.
    const lock = shouldLockOut(cfg);
    if (lock) myLockRound = r.number;
    updateRoom(code, {
      ["gameState/round/private/" + myTeam]: {
        lockedRound: r.number,
        wrongStep: displayedStep,
        wrongIso: iso2,
      },
    });
    emitRing({ correct: false, contested: false, atStep: displayedStep, points: 0 }, r.number);
    setStatus(lock ? "Wrong — you're locked out this round. 🙈" : "Wrong — keep looking! 👀");
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

const WIN_RETRY_MAX = 40;
function retryWin(roundNumber, displayedStep) {
  const gs = room && room.gameState;
  const r = gs && gs.round;
  const stillLive =
    !gs ||
    (gs.phase === "roundActive" && r && r.number === roundNumber && r.outcome == null);
  if (stillLive && winAttempts < WIN_RETRY_MAX) {
    winAttempts++;
    setTimeout(() => doWinAttempt(roundNumber, displayedStep), 120);
    return;
  }
  // No more retries: the budget is spent (a flaky network swallowed every attempt),
  // or the round slipped away without our ring resolving. Don't leave the buzzer
  // bricked on "Ringing in…" — drop winState so the next tap re-arms, with an
  // honest status. winRetryExhausted guards the common still-live-but-out-of-budget
  // case; either way we only touch OUR own in-flight round and NEVER a resolved
  // outcome (won/lost/bust/over won the race and must stand).
  const exhausted = winRetryExhausted(winState, winAttempts, WIN_RETRY_MAX);
  if (
    (exhausted || !stillLive) &&
    winState &&
    winState.phase === "trying" &&
    winState.roundNumber === roundNumber
  ) {
    winState = null;
    winAttempts = 0;
    setStatus("Couldn't reach the server — ring again.");
    renderRoundControls();
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
      // Aborted — classify the §4.2 taxonomy against the LATEST snapshot (pure).
      const gs = room && room.gameState;
      const outcome = winAttemptOutcome(gs, roundNumber, myTeam);
      if (outcome === "retry") {
        retryWin(roundNumber, displayedStep); // a/b/c benign → retry
      } else if (outcome === "won") {
        // e: my commit landed but the ack was lost — you won.
        committedOutcome = committedOutcome || { number: roundNumber, kind: "win" };
        winState = { roundNumber, phase: "won" };
      } else if (outcome === "lost") {
        // d: rival beat me — a correct-but-losing (contested) ring.
        winState = { roundNumber, phase: "lost" };
        emitRing(
          { correct: true, contested: true, atStep: displayedStep, points: 0 },
          roundNumber
        );
        setStatus("So close — someone rang first! 😤");
      } else if (outcome === "bust") {
        winState = { roundNumber, phase: "bust" };
        setStatus("Time ran out just before your ring landed.");
      } else {
        winState = { roundNumber, phase: "over" }; // g: genuinely advanced
      }
    })
    .catch(() => retryWin(roundNumber, displayedStep));
}

function emitRing({ correct, contested, atStep, points }, roundNumber) {
  const decision = ringEmission(
    {
      ringed,
      mode: modeStr(),
      team: myTeam,
      difficulty: cfg.difficulty,
      inputMode: cfg.inputMode,
      guessMode: guessModeLabel(cfg),
      pace: cfg.pace,
      roundKey: roundKey(roundNumber),
    },
    { correct, contested, atStep, points }
  );
  if (!decision.emit) return;
  ringed.add(decision.key);
  track("flag_ring", decision.props);
}

// game_over — emitted at-most-once by the phone whose advanceRound transaction
// COMMITTED the game-ending advance (the same committed-path discipline that gates
// flag_round). Aggregates only, no identifiers: mode, how many rounds were played
// (the final round number), the live team count, and the locked difficulty/input
// mode. `roundsPlayed` is the reveal round we advanced FROM — advancing from the
// reveal of round N into gameOver means N rounds were played.
function emitGameOver(roundsPlayed) {
  if (gameOverEmitted) return;
  gameOverEmitted = true;
  const teams = (room && room.gameState && room.gameState.teams) || {};
  track("game_over", {
    mode: modeStr(),
    roundsPlayed,
    teamCount: Object.keys(teams).length,
    difficulty: cfg.difficulty,
    inputMode: cfg.inputMode,
  });
}

// ---------------------------------------------------------------------------
// Join / create / resume
// ---------------------------------------------------------------------------
async function createRoom() {
  const difficulty = $("createDifficulty").value;
  const inputMode = $("createInput").value;
  const multiGuess = !!($("createGuessMode") && $("createGuessMode").value === "multi");
  const paceId = ($("createPace") && $("createPace").value) || "classic";
  const pace = paceOf(paceId);
  myName = ($("homeName").value || "").trim() || "Player 1";
  const d = GAME_DEFAULTS;
  const roundsRaw = parseInt(($("createRounds") && $("createRounds").value) || "", 10);
  const roundCount = Number.isFinite(roundsRaw) && roundsRaw > 0
    ? Math.min(Math.max(roundsRaw, 3), 20)
    : d.roundCount;
  const settings = {
    roundCount,
    target: d.target,
    stepMs: pace.stepMs,
    graceMs: pace.graceMs,
    pace: paceId,
    gridN: d.gridN,
    revealAspect: d.revealAspect,
    base: d.BASE,
    min: d.MIN,
    steps: d.STEPS,
    choiceUnlockStep: d.choiceUnlockStep,
    scoreProfile: "standard",
    difficulty,
    inputMode,
    multiGuess,
  };
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
  // claimRoomCode never overwrites a live room: a collision retries a fresh code
  // (and lazy-reclaims a >24h stale one), so this can't clobber someone's game.
  let c;
  try {
    c = await claimRoomCode(state);
    if (!c) throw new Error("no free room code");
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
    $("joinErr").textContent =
      "This room runs a newer version — refresh this page, then join again.";
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
          // `room` is the PRE-claim snapshot, so it doesn't include the slot we
          // just won — +1 counts the joiner themselves (the claim transaction
          // succeeded above). It's a best-effort local count: if a rival claimed
          // another slot in the same tick it can lag by one, but it never omits
          // the joiner, which is the point of a "team_count" on their own join.
          team_count: Object.keys(room.gameState.teams || {}).length + 1,
        });
        return;
      }
    }
  }
  if (!myTeam) {
    $("joinErr").textContent = "Room is full (4 teams max).";
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
    if (wantJoin) $("joinErr").textContent = "Room not found — check the code.";
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
    partyHistory = []; // fresh game (in-place lobby return); recap starts empty
    gameOverEmitted = false; // re-arm game_over for the next game
    renderLobby(gs);
    showScreen("p-lobby");
  } else if (phase === "roundActive") {
    prepRound(gs);
    renderRound(gs);
    showScreen("p-round");
  } else if (phase === "reveal") {
    // Fold this settled round into the recap history (idempotent per echo).
    partyHistory = recordPartyRound(partyHistory, gs.round);
    renderRevealScreen(gs);
    showScreen("p-reveal");
  } else if (phase === "gameOver") {
    // The finishing round is still in gs.round (advanceState only flips the
    // phase) — fold it too so the last round shows even if its reveal echo was
    // missed. recordPartyRound dedupes on round number.
    partyHistory = recordPartyRound(partyHistory, gs.round);
    renderGameOver(gs);
    showScreen("p-gameover");
  }
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function renderLobby(gs) {
  $("lobbyCode").textContent = code;
  $("lobbyCode").classList.remove("skeleton"); // real code in — drop the pulse
  const owner = isOwner();

  // TV-connect callout: a code-forward card for the host; a quieter version for
  // other phones; a calm confirmation once a TV is live. The card no longer
  // echoes the room code (it's the hero right above); it points at the "Add a
  // TV" affordance + a scannable QR instead.
  const tv = $("lobbyTv");
  if (tv) {
    tv.dataset.role = owner ? "host" : "guest";
    tv.dataset.state = screenLive() ? "connected" : "waiting";
  }

  // QR joins (GeoParty parity). A phone scanning the join QR lands on
  // player.html?room=CODE (auto-join); scanning the TV QR lands a spare phone
  // on tv.html?room=CODE (redirects to the passive TV), tagged via=qr for attribution.
  // Drawn once per code — drawQr paints a fixed-resolution canvas; CSS scales
  // the display size down to the quiet lobby affordance.
  drawQrOnce("lobbyJoinQr", "join", pageUrl("player.html?room=" + code));
  drawQrOnce("lobbyTvQr", "tv", pageUrl("tv.html?room=" + code + "&via=qr"));

  // The mode note now summarises how the game is set up (a Configure detail),
  // not where the flag renders — the callout above owns the TV story.
  const diffLabel = { easy: "Easy", world: "World", expert: "Expert" }[cfg.difficulty] || cfg.difficulty;
  const inputLabel = cfg.inputMode === "choice" ? "tap to answer" : "type to answer";
  const paceLabel = paceOf(cfg.pace).label;
  const pool = eligiblePool(FLAGS, cfg.difficulty).length;
  const roundCount = pool > 0 ? effectiveRoundCount(cfg, FLAGS) : cfg.roundCount;
  const guessLabel = cfg.multiGuess ? "multiple guesses" : "first correct wins";
  // Each token labelled so the muted line reads as prose, not bare words.
  $("lobbyMode").textContent = `${paceLabel} pace · ${diffLabel} flags · ${inputLabel} · ${guessLabel} · ${roundCount} rounds`;

  const teams = gs.teams || {};
  const ul = $("lobbyTeams");
  ul.innerHTML = "";
  for (const tN of ["t1", "t2", "t3", "t4"]) {
    const t = teams[tN];
    if (!t) continue;
    const li = document.createElement("li");
    li.className = "team-row team-" + tN.slice(1);
    const you = tN === myTeam ? " (you)" : "";
    const host = room.hostTeam === tN ? " · host" : "";
    li.textContent = `${t.name}${you}${host}`;
    ul.appendChild(li);
  }
  const enough = Object.keys(teams).length >= 1;
  $("btnStart").classList.toggle("hidden", !(owner && enough));
  $("lobbyNote").textContent = owner
    ? "Start when everyone's in."
    : "Waiting for the host to start…";

  // The host phone runs the clock for everyone — a lock/background stalls the game
  // (Fix 5). Nudge the owner to keep it awake; other phones don't see this.
  const hostTip = $("lobbyHostTip");
  if (hostTip) {
    hostTip.textContent = owner
      ? "You're the host — keep this phone unlocked and plugged in while you play."
      : "";
    hostTip.classList.toggle("hidden", !owner);
  }
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
  // (§5.1), filtered on lockedRound === round.number. In "Multiple guesses" mode
  // the private record is a wrong-ring beat, NOT a lockout, so never re-gate on
  // it (shouldLockOut === false) — the phone stays live after a refresh too.
  const mine = r.private && r.private[myTeam];
  if (mine && mine.lockedRound === r.number && shouldLockOut(cfg)) myLockRound = r.number;
}

// The last round? effRounds 0 means the pool is unknown — never claim "final".
function isFinalRound(r) {
  const effRounds = effectiveRoundCount(cfg, FLAGS);
  return effRounds > 0 && r && r.number >= effRounds;
}

// Reveal "advance" button label — the final round leads to scores, not a round.
function nextRoundLabel(r, left) {
  const final = isFinalRound(r);
  if (left == null) return final ? "See final scores" : "Next round";
  return final ? `See final scores · ${left}s` : `Next round · ${left}s`;
}

function renderRound(gs) {
  const r = gs.round;
  if (!r) return;
  const effRounds = effectiveRoundCount(cfg, FLAGS);
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
  renderHostHint(r);
}

// Fix 5: a DISPLAY-ONLY "the host's screen may be asleep" nudge on non-owner
// phones when the reveal clock has frozen mid-round (hostStalled). Zero authority,
// zero writes (CLAUDE.md) — the TV stays passive, no transaction fires. It never
// shows on the owner's own phone (the owner IS the potentially-asleep host), and
// clears the instant the step advances (a fresh snapshot re-renders with a newer
// stepStartedAt). Also refreshed by the 1s interval so it appears on a quiet feed.
function renderHostHint(r) {
  const el = $("roundHostHint");
  if (!el) return;
  const stalled = !isOwner() && hostStalled(r, cfg, serverNow());
  el.textContent = stalled
    ? "The host's screen may be asleep — give their phone a tap 👋"
    : "";
  el.classList.toggle("hidden", !stalled);
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
// Typeahead — suggestFor (the ranking) is shared in ui-common.js; renderSuggest
// / hideSuggest stay here (they bind this page's elements + commit path).
// ---------------------------------------------------------------------------
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
      ? `🎉 You got it at step ${oc.atStep} of ${cfg.steps} — +${pts}!`
      : `${wt ? wt.name : oc.team} got it at step ${oc.atStep} of ${cfg.steps} — +${pts}!`;
    resultEl.className = "reveal-result " + (mine ? "good" : "");
    // Your own win: a single subtle pop + haptic buzz, once per round.
    if (mine && poppedRound !== r.number) {
      poppedRound = r.number;
      pop(540, 900);
      vibrate([10, 40, 20]);
    }
  } else {
    resultEl.textContent = `Nobody got it! 🙈`;
    resultEl.className = "reveal-result bad";
  }

  const board = $("revealBoard");
  if (Object.keys(teams).length === 1) {
    // Solo: a one-row board answers "what changed?" poorly. Borrow the Daily's
    // "Total so far — N" treatment, which already reads as running-context.
    const tN = Object.keys(teams)[0];
    board.innerHTML =
      `<div class="total-row"><span class="total-label">Total so far</span>` +
      `<span class="total-val">${teams[tN].total || 0}</span></div>`;
  } else {
    renderBoard(board, teams, r.results || {});
  }
  renderBeats($("revealBeats"), r.results || {}, teams);

  // Owner controls + auto-advance note. The pause button stays visible for the
  // owner throughout the reveal, showing a pressed state once paused.
  const owner = isOwner();
  $("btnNext").classList.toggle("hidden", !owner);
  const holdBtn = $("btnHold");
  holdBtn.classList.toggle("hidden", !owner);
  const paused = r.autoAdvanceAt == null;
  holdBtn.setAttribute("aria-pressed", paused ? "true" : "false");
  holdBtn.classList.toggle("is-active", paused);
  const note = $("revealNote");
  if (paused) {
    // No countdown to fold into the button once paused.
    $("btnNext").textContent = nextRoundLabel(r, null);
    note.textContent = owner
      ? "Paused — take your time. Tap Next round when ready."
      : "Host paused the next round…";
    note.classList.remove("hidden");
  } else {
    // Owner: countdown lives in the button label (no duplicate note).
    const left = Math.max(0, Math.ceil((r.autoAdvanceAt - serverNow()) / 1000));
    $("btnNext").textContent = nextRoundLabel(r, left);
    note.textContent = owner ? "" : `Next round in ${left}s…`;
    note.classList.toggle("hidden", owner);
  }
}

function emitRevealAnalytics(gs, r, oc) {
  const rk = roundKey(r.number);
  const decision = revealEmission(
    {
      myTeam,
      mode: modeStr(),
      difficulty: cfg.difficulty,
      inputMode: cfg.inputMode,
      guessMode: guessModeLabel(cfg),
      pace: cfg.pace,
      // The answer flag's TIER (easy | world | expert) — how hard the round
      // was, never which flag it was. answerIso itself is a banned key and can
      // never ride along.
      tier: (byIso2(r.answerIso) || {}).tier,
      roundKey: rk,
      emittedRounds,
      committedOutcome,
    },
    { roundNumber: r.number, outcome: oc, results: r.results || {} }
  );
  // The winner's own correct ring (flows through emitRing's own dedup).
  if (decision.ownRing) emitRing(decision.ownRing, r.number);
  // flag_round — only the phone whose transaction committed, at most once.
  if (decision.round && decision.round.emit) {
    emittedRounds.add(rk);
    track("flag_round", decision.round.props);
  }
}

// `results` (optional, reveal only) is this round's per-team scoring; when
// present each row gets a delta chip so the board shows what just changed.
function renderBoard(ul, teams, results) {
  ul.innerHTML = "";
  const rows = Object.keys(teams)
    .map((tN) => ({ tN, ...teams[tN] }))
    .sort((a, b) => (b.total || 0) - (a.total || 0));
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "team-row team-" + row.tN.slice(1);
    const you = row.tN === myTeam ? " (you)" : "";
    let delta = "";
    if (results) {
      const pts = (results[row.tN] && results[row.tN].points) || 0;
      delta = ` <span class="delta${pts ? "" : " zero"}">+${pts}</span>`;
    }
    li.innerHTML = `<span>${escapeHtml(row.name)}${you}</span><span class="score">${row.total || 0}${delta}</span>`;
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
      // Mode-aware suffix: a wrong ring locks a team out only in "First correct
      // wins". In "Multiple guesses" (shouldLockOut false) the team is still
      // playing, so never claim they're out.
      const suffix = shouldLockOut(cfg) ? "out this round." : "still in the round.";
      div.textContent = `😅 ${t ? t.name : tN} guessed ${
        wrong ? wrong.name : res.wrongIso.toUpperCase()
      } at step ${res.wrongStep} of ${cfg.steps} — ${suffix}`;
      box.appendChild(div);
    }
  }
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------

// This phone's own line for one recap card. Shows the player's OWN guess only —
// the answer country when they got it, their own wrong guess when they rang out,
// or nothing when they never rang. Never another team's guessed country (§5.2).
function recapGuessText(me) {
  if (me.status === "correct") {
    return me.atStep != null
      ? `✅ You got it at step ${me.atStep}`
      : "✅ You got it";
  }
  if (me.status === "wrong") {
    const g = byIso2(me.guessIso);
    return `❌ You guessed ${g ? g.name : me.guessIso.toUpperCase()}`;
  }
  return "🙈 You didn't guess this one";
}

// The game-over round recap: one card per round showing the answer (flag + name,
// shared truth) and this phone's own guess. A read-only render of partyHistory —
// no transaction, no phase flip. The answer country is not a team name, so the
// card carries no data-ph-mask; the flag image stays aria-hidden (decorative,
// the name is the label).
function renderRecap(box) {
  if (!box) return;
  const cards = partyRecapCards(partyHistory);
  box.innerHTML = "";
  if (!cards.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  for (const card of cards) {
    const ans = byIso2(card.answerIso);
    const me = recapTeamResult(card, myTeam);

    const el = document.createElement("div");
    el.className = "recap-card";

    const flag = document.createElement("img");
    flag.className = "recap-flag";
    flag.src = flagAssetPath(card.answerIso);
    flag.alt = "";
    flag.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "recap-body";

    const head = document.createElement("div");
    head.className = "recap-round";
    head.textContent = `Round ${card.number} of ${card.totalRounds}`;

    const answer = document.createElement("div");
    answer.className = "recap-answer";
    answer.textContent = ans ? ans.name : card.answerIso.toUpperCase();

    const guess = document.createElement("div");
    guess.className = "recap-guess " + me.status;
    guess.textContent = recapGuessText(me);

    body.append(head, answer, guess);
    el.append(flag, body);
    box.appendChild(el);
  }
}

function renderGameOver(gs) {
  const teams = gs.teams || {};
  const winner = gameWinner(teams, cfg);
  const wt = teams[winner];
  const iWon = winner === myTeam;
  $("goWinner").textContent = wt
    ? `${iWon ? "👑 You win" : "👑 " + wt.name + " wins"} — ${wt.total || 0} pts!`
    : "—";

  // The round recap fills the band above the winner line: each round's answer
  // (a country flag + name — shared truth) and THIS phone's own guess. It is a
  // read-only fold of already-settled rounds (partyHistory) — no transaction,
  // no phase flip. See renderRecap.
  renderRecap($("goRecap"));

  renderBoard($("goBoard"), teams);
  $("btnPlayAgain").classList.toggle("hidden", !iWon);

  // Guest guidance: only the winner's phone shows "Play again", so a non-winner
  // is left with "New game" (which leaves the auto-follow loop). Name what
  // happens next instead of a dead end. The winner's (user-entered) team name
  // renders here, so the note carries data-ph-mask (see player.html).
  const guestNote = $("goGuestNote");
  if (guestNote) {
    const showNote = !iWon && wt;
    guestNote.textContent = showNote
      ? `👑 ${wt.name} can start the next game — stay here to follow along.`
      : "";
    guestNote.classList.toggle("hidden", !showNote);
  }
}

// Share the finished game as a clipboard brag. The winning team name is
// user-entered flair (never a country); the analytics event stays aggregate.
async function sharePartyResult() {
  const gs = room.gameState || {};
  const teams = gs.teams || {};
  const winner = gameWinner(teams, cfg);
  const wt = teams[winner];
  const points = (wt && wt.total) || 0;
  const url = withUtm(pageUrl("player.html"), "party");
  const text = partyShareText({ winner: wt ? wt.name : null, points, url });
  await shareText(text, {
    event: "share_party",
    props: { mode: modeStr(), points },
    toast,
  });
}

// Copy the TV join URL (tv.html?room=CODE) so the host can send it to the
// TV — a real TV can't scan the lobby QR. The code rides in the URL that only
// ever reaches the clipboard, never a rendered surface, so nothing here needs
// masking. No analytics: this is a lobby setup helper, not a growth-loop share
// (keeping share_party's counts to actual result shares).
async function shareTvLink() {
  const url = pageUrl("tv.html?room=" + code);
  try {
    await navigator.clipboard.writeText(url);
    toast("TV link copied 📋");
  } catch {
    toast(url); // clipboard blocked: at least show the link to send by hand
  }
}

async function playAgain() {
  const gs = room.gameState || {};
  const teams = gs.teams || {};
  const winner = gameWinner(teams, cfg);
  if (winner !== myTeam) return;
  // Carry only the winner's slot forward (F6, tv-stability-analysis.md): guests
  // re-claim by deviceId via the auto-follow + tryClaim resume, so a phone that
  // isn't open at game over no longer leaves a ghost slot the TV counts as a
  // live player. Season mode keeps the full roster (carryStandings ignores
  // winnerOnly when cfg.carry, to preserve every team's running total).
  const seasonCfg = room.settings && room.settings.carry ? { carry: true } : {};
  const { teams: newTeams, hostTeam } = carryStandings(teams, winner, {
    ...seasonCfg,
    winnerOnly: true,
  });
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
    // Same collision-safe claim as createRoom — the rematch never clobbers a
    // live room that happens to share the freshly-minted code.
    const c2 = await claimRoomCode(state);
    if (!c2) throw new Error("no free room code");
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
// Absolute URL for a same-origin page (what a scanned QR must encode).
function pageUrl(rel) {
  return new URL(rel, location.href).href;
}
// Paint a QR into a canvas once per (element, payload) — re-rendering the lobby
// every snapshot must not repaint an unchanged code.
function drawQrOnce(id, tag, text) {
  const c = $(id);
  if (!c) return;
  const stamp = tag + "|" + text;
  if (c._qr === stamp) return;
  drawQr(c, text);
  c._qr = stamp;
}

// ---------------------------------------------------------------------------
// Wire the DOM + boot
// ---------------------------------------------------------------------------
function wire() {
  // Unlock WebAudio inside the first real gesture (iOS Safari autoplay policy) so
  // the win pop can actually sound — pop() itself fires in the snapshot-echo render
  // path, outside any gesture, where a never-resumed context stays silent.
  const prime = () => primeAudio();
  window.addEventListener("pointerdown", prime, { once: true });
  window.addEventListener("touchstart", prime, { once: true });

  // Create is its own screen now (not an accordion). These two just flip the
  // #p-home ↔ #p-create pair and keep the URL honest so a refresh reopens the
  // same screen (the pre-paint inline script keys off ?create=1).
  $("btnShowCreate").addEventListener("click", () => showCreate(true, true));
  $("btnCreateBack").addEventListener("click", () => showCreate(false));
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
  $("btnShareTvLink").addEventListener("click", shareTvLink);
  $("btnStart").addEventListener("click", () => {
    cancelOwnerTimers();
    advanceRound(code, 0, cfgNow()).catch(() => toast("Couldn't start — try again."));
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
    const gs = room.gameState;
    const r = gs && gs.round;
    if (!r) return;
    cancelOwnerTimers();
    const willEnd = endsGameOnAdvance(gs, r.number, cfg);
    advanceRound(code, r.number, cfgNow())
      .then((committed) => {
        if (committed && willEnd) emitGameOver(r.number);
      })
      .catch(() => {});
  });
  $("btnHold").addEventListener("click", () => {
    updateRoom(code, { "gameState/round/autoAdvanceAt": null }).catch(() => {});
  });

  // Game over
  $("btnShareParty").addEventListener("click", sharePartyResult);
  $("btnPlayAgain").addEventListener("click", playAgain);
  $("btnNewGame").addEventListener("click", () => {
    clearSession();
    location.href = "player.html";
  });

  // Both the home and create screens carry a footer Privacy button; wire every
  // .js-privacy so the consent banner reopens from either.
  document.querySelectorAll(".js-privacy").forEach((b) => b.addEventListener("click", openBanner));

  // Resume banner / URL routing.
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get("room") || "").toUpperCase();
  if (isValidRoomCode(urlRoom)) {
    joinRoom(urlRoom, "");
    return;
  }
  // Reconcile the create screen with the URL. If ?create=1, the pre-paint script
  // already showed it via html.want-create; take ownership of the .hidden state
  // and drop that class so later toggles (Back, showScreen) work normally.
  showCreate(params.get("create") === "1");
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
    if (r && r.autoAdvanceAt != null && !$("p-reveal").classList.contains("hidden")) {
      const left = Math.max(0, Math.ceil((r.autoAdvanceAt - serverNow()) / 1000));
      // Owner's countdown rides in the button label; guests see the note.
      if (isOwner()) {
        $("btnNext").textContent = nextRoundLabel(r, left);
      } else {
        $("revealNote").textContent = `Next round in ${left}s…`;
      }
    }
    runConduct(); // ensure a dead-owner fallback still fires on a quiet feed
  } else if (room && room.gameState && room.gameState.phase === "roundActive") {
    runConduct(); // non-owner bust deadline can pass with no new snapshot
    // Refresh the host-asleep hint on a quiet feed (a frozen clock produces no new
    // snapshot, so the >2×stepMs threshold must be re-checked on the timer).
    const r = room.gameState.round;
    if (r && !$("p-round").classList.contains("hidden")) renderHostHint(r);
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
