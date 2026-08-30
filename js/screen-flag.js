// screen-flag.js — the Flag Reveal TV renderer. A pure-ish subscriber: it
// renders `currentStep` via the progressive reveal, standings, the winner and
// the crown, and — at reveal — the wrong-ring comedy beats from results/*.
//
// PASSIVE-TV CONTRACT (SPEC §6, §13 — do not regress):
//   - The TV writes ONLY `screenHeartbeat`.
//   - It runs NO roundConduct, NO resolveRound/advanceRound transaction, NO
//     cadence. It owns no timer that changes game state and holds no authority.
//   - It reads round/private/* ONLY for PRESENCE — which teams locked themselves
//     out this round (via lockedOutTeams, filtered on lockedRound), to pop the
//     transient "guessed wrong" hint. It NEVER reads the guessed country
//     (wrongIso/wrongStep): the hint discloses the FACT of a wrong ring, never
//     its content (privacy §5.2). Guess content is still disclosed only at
//     reveal, via results/* (the beats). All other reads are public round fields.

import {
  subscribeRoom,
  writeScreenHeartbeat,
  onConnectionChange,
  subscribeServerTimeOffset,
} from "./firebase.js";
import { renderReveal } from "./reveal-render.js";
import {
  gameWinner,
  shouldFollowRoom,
  celebrationSpec,
  confettiSpec,
  effectiveRoundCount,
  lockedOutTeams,
  shouldLockOut,
  tvAdvanceNote,
  hostStalled,
  revealMapSpec,
} from "./flag.js";
import { renderRevealMaps, destroyRevealMaps, updateRevealMaps } from "./tv-maps.js";
import CENTROIDS from "../data/country-centroids.json" with { type: "json" };
import { escapeHtml, primeAudio } from "./ui-common.js";
import { soundState, soundDecisions, playSounds } from "./tv-sound.js";
import { reconcileBoard } from "./board-juice.js";
import { FLAGS, byIso2, flagAssetPath } from "./flags-data.js";
import { recordPartyRound, partyRecapCards, recapTeamResults } from "./partyrecap.js";
import { isValidRoomCode, screenQuery, emitsScreenJoined } from "./roomcode.js";
import { GAME_DEFAULTS } from "../config.js";
import { track } from "./consent.js";
import { drawQr } from "./qr.js";

const $ = (id) => document.getElementById(id);
let code = null;
let via = "typed";
let heartbeatTimer = null;
let unsubRoom = null;
// Server-time correction (§1.4): the TV subscribes to `.info/serverTimeOffset`
// (never a one-shot read) so its reveal countdown / stall cue are anchored on the
// same server clock the owner phone writes autoAdvanceAt/stepStartedAt against.
// Display-only — the TV still writes nothing but the heartbeat (passive-TV).
let serverTimeOffset = 0;
const serverNow = () => Date.now() + serverTimeOffset;
// Rooms joined since the last manual entry — breaks nextRoom pointer cycles
// (A → B → A would otherwise re-subscribe forever). SPEC-v3.1 §1530 mandates
// this "verbatim" from the GeoParty kernel. Reset on manual entry and URL boot.
let followedCodes = new Set();
// The game-over celebration fires at-most-once per game-over entry — render()
// re-runs on every heartbeat/snapshot, but the burst must not re-fire. Reset
// whenever the phase leaves gameOver (next game / lobby) so a fresh game can
// celebrate again.
let celebrated = false;
// The two reveal maps (Items B) are built ONCE per reveal round — render() re-runs
// on every heartbeat/snapshot, and rebuilding the Leaflet maps each time would
// flicker and re-fetch tiles. `mapsRound` holds the round number the maps were
// built for; hideMaps() resets it so the next reveal rebuilds. Decorative reveal
// dressing — no write, no read beyond the public answer ISO (passive-TV).
let mapsRound = null;
// Item 4 — the transient "guessed wrong" hint. When a team rings in wrong DURING
// a round, the TV pops a brief, content-free pill (masked team name; never the
// country) that fades after ~2.5s. Pure local render — no write (passive-TV
// contract). `wrongHintSeen` holds the slots already hinted THIS round so a
// re-render on every heartbeat/step does not re-toast; it resets when the round
// number changes. `wrongHintTimer` is a render-only dismiss timer (local DOM,
// never game state).
let wrongHintSeen = new Set();
let wrongHintRound = null;
let wrongHintTimer = null;
// The TV sound layer (js/tv-sound.js). `lastSoundState` is the previous
// snapshot's projected sound state; the DECISION of what to sound lives in the
// pure soundDecisions(prev, next) — this is just the memory it diffs against.
// Null means "no previous snapshot": the next render primes it and sounds
// nothing, so a TV attaching mid-game never stings for a round it never watched.
// Reset on every room change (connect) so a follow into the next game does not
// blip once per team already in that lobby. `lastTickStep` is the belt-and-
// braces per-step dedupe for the scrubber tick (snapshot echoes re-fire); it is
// scoped to `lastTickRound` and reset when the round number changes.
let lastSoundState = null;
let lastTickStep = null;
let lastTickRound = null;
// Game-over round recap (Item 1). Flag Party keeps only the CURRENT round in
// the RTDB, so — exactly like the phone (flag-ui.js) — the TV folds a
// memory-only `partyHistory` at every reveal echo (recordPartyRound, idempotent
// per round number). At game-over it renders a SINGLE card that auto-cycles to
// the next round every few seconds (GeoParty TV style: the TV has no touch, so a
// swipe carousel is dead UI). This is a READ-ONLY fold of settled state — no
// write, no transaction, no phase flip (passive-TV contract). `recapBuilt`
// latches the build to one per game-over entry (render re-runs on every
// heartbeat); it resets whenever we leave gameOver so a fresh game rebuilds.
let partyHistory = [];
let recapCards = [];
let recapIndex = 0;
let recapTimer = null;
let recapBuilt = false;
const RECAP_CYCLE_MS = 5000;

function cfgFromRoom(room) {
  const s = (room && room.settings) || {};
  const d = GAME_DEFAULTS;
  return {
    steps: s.steps || d.STEPS,
    gridN: s.gridN || d.gridN,
    revealAspect: s.revealAspect || d.revealAspect,
    target: s.target != null ? s.target : d.target,
    roundCount: s.roundCount != null ? s.roundCount : d.roundCount,
    difficulty: s.difficulty || d.difficulty,
    stepMs: s.stepMs || d.stepMs,
    graceMs: s.graceMs || d.graceMs,
    pool: FLAGS,
  };
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// The ONLY thing the TV ever writes: its heartbeat (§6). Started only AFTER the
// room is confirmed to exist (F4/sawState) so a mistyped code never materializes
// a phantom `rooms/{WRONGCODE}/screenHeartbeat` node in Flag Party's RTDB. Every 4s
// — KEEP this cadence: the phone's `screenLive` window is 10s (flag-ui.js), so
// slower beats would flap. The `.catch` swallows offline write rejections (F5).
function startHeartbeat() {
  stopHeartbeat();
  const beat = () => writeScreenHeartbeat(code).catch(() => {});
  beat();
  heartbeatTimer = setInterval(beat, 4000);
}

function connect(c, joinVia) {
  // Tear down any live room state first — connect() doubles as the re-connect
  // used by followRoom(), and the heartbeat/subscription otherwise run forever.
  stopHeartbeat();
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  // A fresh room (manual connect or follow) — drop the old game's recap fold so
  // the next game-over never shows the previous room's rounds.
  partyHistory = [];
  stopRecapCycle();
  // A different room's first snapshot must prime, not sound (see lastSoundState).
  lastSoundState = null;
  lastTickStep = null;
  lastTickRound = null;
  // A fresh room — tear down any reveal maps from the previous room/game.
  hideMaps();

  code = c;
  via = joinVia || "typed";
  followedCodes.add(code);
  $("tvCode").textContent = code;
  $("tvCode").classList.remove("skeleton"); // real code in — drop the pulse
  $("sErr").textContent = "";
  $("s-join").classList.add("hidden");
  $("s-display").classList.remove("hidden");
  // The couch-join QR: a phone scanning it lands on player.html?room=CODE.
  const qc = $("tvJoinQrCanvas");
  if (qc) drawQr(qc, new URL("player.html?room=" + code, location.href).href);

  // Room-not-found / room-closed protocol (F4). `sawState` is per-subscription:
  // a null snapshot before the first real state means the code is wrong (→ back
  // to the join screen); a null after means the room was deleted out from under
  // us (→ "The room was closed."). Firebase `onValue` does NOT deliver null on a
  // mere disconnect (the connection pill covers that), so this is safe as-is.
  let sawState = false;
  unsubRoom = subscribeRoom(code, (room) => {
    if (!room) {
      if (sawState) leave("The room was closed.");
      else notFound("Room not found — check the code.");
      return;
    }
    if (!sawState) {
      sawState = true;
      startHeartbeat();
      // Instrument the attach ONLY now that the code resolved to a real room —
      // a mistyped code never lands a `screen_joined`, so `tv_attach_14d` counts
      // real TVs, not typos. A `follow` re-connect is the SAME physical TV
      // session carrying into the next game (not a new attach), so it is
      // deliberately NOT emitted — see docs/analytics.md. The follow-exclusion
      // rule lives in the pure `emitsScreenJoined` (roomcode.js), unit-tested.
      if (emitsScreenJoined(via)) track("screen_joined", { mode: "tv", via });
      // Keep the URL on the current room so a TV sleep/refresh rejoins it (F1).
      // Written only after sawState, so a mistyped code is never pinned.
      try {
        history.replaceState(null, "", screenQuery(code, via));
      } catch {
        /* file:// — replaceState throws on opaque origins */
      }
    }
    render(room);
  });
}

// Follow a finished room's `nextRoom` pointer into the next game (SPEC-v3.1
// §765, §1361 — subscribers, and any TV, follow the pointer). This is a pure
// re-subscribe: it tears down the old room's heartbeat + subscription and
// reconnects. The TV remains a passive subscriber — followRoom writes NOTHING
// (the only write is the heartbeat that connect() already owns).
function followRoom(next) {
  stopHeartbeat();
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  // F2: explicitly blank every mutable region before the new room's first
  // snapshot arrives, so a slow or failed follow shows an honest empty room —
  // never the previous game's board/players/QR frozen on screen.
  resetDisplay("Joining the next game…");
  connect(next, "follow");
}

// Clear every mutable render region and set an honest header. Shared by the
// follow transition (F2) and the not-found/closed leave path (F4).
function resetDisplay(header) {
  $("tvHeader").textContent = header;
  $("tvBoard").innerHTML = "";
  $("tvBeats").innerHTML = "";
  clearReveal();
  $("tvResult").textContent = "";
  $("tvComingUp").textContent = "";
  $("tvNote").textContent = "";
  $("tvAnswer").classList.add("hidden");
  hideMaps();
  hideWrongHint();
  stopRecapCycle();
  const qrWrap = $("tvJoinQr");
  if (qrWrap) qrWrap.classList.add("hidden");
}

// A code that never resolved to a room: stay on the join screen with an error,
// leaving no heartbeat behind (it was never started — F4). Drops the dead
// subscription so its callbacks stop firing against a stale code.
function notFound(message) {
  stopHeartbeat();
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  code = null;
  $("s-display").classList.add("hidden");
  $("s-join").classList.remove("hidden");
  $("sErr").textContent = message || "";
  // Item C — back on the join screen, focus the input so the next code can be
  // typed immediately (same semantics as leaveToJoin()).
  const input = $("sCode");
  if (input) input.focus();
}

// Return to the join screen after the room went away under us (F4): stop the
// heartbeat, drop the subscription, clear the DOM (F2), clear the URL (F1) and
// the follow chain, and surface a message.
function leave(message) {
  stopHeartbeat();
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  code = null;
  followedCodes = new Set();
  resetDisplay("");
  $("s-display").classList.add("hidden");
  $("s-join").classList.remove("hidden");
  $("sErr").textContent = message || "";
  // Item C — focus the code input on return to the join screen (same as
  // leaveToJoin()), so the operator can type a new code without a click.
  const input = $("sCode");
  if (input) input.focus();
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    /* file:// */
  }
}

function render(room) {
  // Follow a finished room's pointer to the next game — the same guard the
  // phone uses (js/flag-ui.js). A gameOver room that grows `nextRoom` steers
  // every subscriber, TV included, into the fresh room's lobby. The cycle guard
  // + gameOver gate live in the pure helper (F3). Null snapshots never reach
  // render — the connect() subscription handles them via the F4 protocol.
  const next = shouldFollowRoom(room, code, followedCodes);
  if (next) {
    followRoom(next);
    return;
  }
  const cfg = cfgFromRoom(room);
  const gs = room.gameState || {};
  const phase = gs.phase || "lobby";
  const r = gs.round;
  const teams = gs.teams || {};

  // Drive the whole TV layout from the phase (CSS state machine in style.css):
  //   roundActive → flag full-bleed, everything else hidden.
  //   reveal / gameOver → centered results card (answer + standings + busts).
  $("s-display").dataset.phase = phase;
  // The "guessed wrong" hint belongs to the active round only — hide it the
  // instant we leave roundActive (reveal shows the beats; lobby/gameOver show
  // nothing). The new-ring detection lives in the roundActive branch below.
  if (phase !== "roundActive") hideWrongHint();

  // The room sound layer (Change 1). Everything it needs is state the TV already
  // renders — phase, round number, currentStep, outcome, team keys — projected by
  // the pure soundState() and diffed by the pure soundDecisions(). No read is
  // added, nothing is written: still a passive TV.
  soundFor(room, cfg.steps);

  renderBoard($("tvBoard"), teams, phase === "gameOver" ? gameWinner(teams, cfg) : null);
  // The join QR belongs to the lobby only — hidden the moment play starts.
  const qrWrap = $("tvJoinQr");
  if (qrWrap) qrWrap.classList.toggle("hidden", phase !== "lobby");

  // Tear down the game-over celebration the moment we leave that phase (a fresh
  // game / lobby), so the next winner's burst can fire again (§once-only). The
  // recap card + auto-cycle timer are torn down on the same edge (and rebuilt on
  // the next game-over entry) so they never leak across phases/games.
  if (phase !== "gameOver") {
    if (celebrated) endCelebration();
    if (recapBuilt) {
      stopRecapCycle();
      // The recap-band maps ride the recap: tear them down on the SAME
      // leave-gameOver edge so lobby/roundActive return to the no-maps state.
      // Gated on recapBuilt (a once-per-gameOver latch) so this fires only on
      // the edge — never on a reveal render, which would fight renderRevealMaps.
      hideMaps();
    }
  }

  if (phase === "lobby") {
    // A fresh game (in-place lobby return) — the recap starts empty, exactly as
    // the phone does (flag-ui.js). A room change already reset it in connect().
    partyHistory = [];
    // Echo the room code into the big QR caption so it's legible across the
    // room (the top-left .tv-room label is too small at 10 feet). Masked for
    // session replay.
    $("tvJoinCode").textContent = code;
    $("tvJoinCode").classList.remove("skeleton"); // real code in — drop the pulse
    $("tvHeader").textContent = "Lobby — join on your phone";
    $("tvAnswer").classList.add("hidden");
    $("tvResult").textContent = "";
    $("tvComingUp").textContent = "";
    $("tvBeats").innerHTML = "";
    clearReveal();
    hideMaps();
    const n = Object.keys(teams).length;
    $("tvNote").textContent = n
      ? `${n} team${n === 1 ? "" : "s"} in.`
      : "Enter the room code on your phone to join.";
    return;
  }

  if (phase === "gameOver") {
    // Fold the finishing round too — advanceState only flips the phase, so the
    // last round is still in gs.round; recordPartyRound dedupes by number, so a
    // reveal echo already captured is a no-op (mirrors flag-ui.js).
    partyHistory = recordPartyRound(partyHistory, r, { mode: "tv" });
    const winner = gameWinner(teams, cfg);
    const wt = teams[winner];
    $("tvHeader").textContent = "Game over";
    clearReveal();
    $("tvAnswer").classList.add("hidden");
    // NOTE: no hideMaps() here — at gameOver the maps now RIDE the recap band,
    // unhidden and rotated by buildRecap()/the recap cycle. hideMaps() runs on
    // the leave-gameOver edge instead (the phase !== "gameOver" block above).
    $("tvResult").innerHTML = wt
      ? `👑 <strong data-ph-mask>${escapeHtml(wt.name)}</strong> wins — ${wt.total || 0} pts!`
      : "Game over";
    $("tvComingUp").textContent = "";
    $("tvBeats").innerHTML = "";
    $("tvNote").textContent = "👑 The winner's phone starts the next game.";
    // Build the auto-cycling round recap ONCE per game-over entry (render
    // re-runs on every heartbeat) — read-only fold of settled state, no write.
    if (!recapBuilt) {
      recapBuilt = true;
      buildRecap(teams);
    }
    if (wt && winner && !celebrated) celebrate(winner, room.gameSeed || code);
    return;
  }

  if (!r) return;
  // A new round → forget which teams we've already hinted (fresh lockout set).
  if (wrongHintRound !== r.number) {
    wrongHintSeen = new Set();
    wrongHintRound = r.number;
  }
  const effRounds = effectiveRoundCount(cfg, FLAGS);
  $("tvHeader").textContent = `Round ${r.number}${effRounds ? " / " + effRounds : ""}`;

  const reveal = phase === "reveal";
  renderReveal($("tvReveal"), {
    flagSeed: r.flagSeed,
    currentStep: r.currentStep,
    gridN: cfg.gridN,
    steps: cfg.steps,
    iso2: r.answerIso,
    revealAspect: cfg.revealAspect,
    full: reveal,
  });

  if (reveal) {
    // Fold this settled round into the recap history (idempotent per echo), so
    // the game-over recap has every round even for a TV that attached mid-game.
    partyHistory = recordPartyRound(partyHistory, r, { mode: "tv" });
    const oc = r.outcome || {};
    const answer = byIso2(r.answerIso);
    $("tvAnswer").textContent = answer ? answer.name : r.answerIso.toUpperCase();
    $("tvAnswer").classList.remove("hidden");
    // The two reveal maps (Items B): the answer is public now, so show a
    // world-context view + an up-close view of the country. Built ONCE per reveal
    // round (mapsRound latch) — render() re-runs on every heartbeat and rebuilding
    // would flicker. tv-maps.js reads only the args; no private/* read is added.
    if (mapsRound !== r.number) {
      mapsRound = r.number;
      if (revealMapSpec(r.answerIso, CENTROIDS)) {
        renderRevealMaps({
          worldEl: $("tvMapWorld"),
          bordersEl: $("tvMapBorders"),
          iso2: r.answerIso,
          table: CENTROIDS,
        });
        $("tvMaps").classList.remove("hidden");
      } else {
        hideMaps();
      }
    }
    if (oc.kind === "win") {
      const wt = teams[oc.team];
      const pts = (r.results && r.results[oc.team] && r.results[oc.team].points) || 0;
      $("tvResult").innerHTML = `<strong data-ph-mask>${escapeHtml(
        wt ? wt.name : oc.team
      )}</strong> got it at step ${oc.atStep} of ${cfg.steps} — +${pts}!`;
    } else {
      $("tvResult").textContent = `Nobody got it! 🙈`;
    }
    renderBeats($("tvBeats"), r.results || {}, teams, cfg.steps, shouldLockOut(cfg));
    // Coming-up line rides in the main column under the result, where all eyes
    // are; tvNote is reserved for lobby/idle states. The pure tvAdvanceNote ticks
    // the countdown to the next round (or the final scoreboard) so the couch can
    // see the timeout; it lands the paused note when the reveal is held. No timer
    // is added — snapshots/heartbeats re-render often enough for second-granularity
    // (passive-TV: no cadence). A null note falls back to the static line.
    const note = tvAdvanceNote(r, cfg, serverNow());
    $("tvComingUp").textContent = note || "Next round coming up…";
    $("tvNote").textContent = "";
  } else {
    // Item 4: surface a NEW wrong ring as a transient hint. lockedOutTeams reads
    // round/private PRESENCE only (never the country) — the FACT that a team is
    // out, masked, faded after ~2.5s. The full guess stays hidden until reveal's
    // beats. A team already in `wrongHintSeen` this round is not re-toasted.
    for (const tN of lockedOutTeams(r)) {
      if (wrongHintSeen.has(tN)) continue;
      wrongHintSeen.add(tN);
      const t = teams[tN];
      showWrongHint(t ? t.name : tN);
    }
    $("tvAnswer").classList.add("hidden");
    $("tvResult").textContent = "";
    $("tvComingUp").textContent = "";
    $("tvBeats").innerHTML = "";
    hideMaps(); // roundActive — the answer is still secret; no maps
    // Sleeping-host cue: when the owner's phone freezes mid-round, currentStep
    // stops advancing. hostStalled (pure, public fields only) detects the gap and
    // the idle line tells the couch the host's phone may be asleep. Re-rendered every
    // snapshot, so it clears itself the instant the step advances or the phase
    // changes — no timer (passive-TV contract).
    const stalled = hostStalled(r, cfg, serverNow());
    $("tvNote").textContent = stalled
      ? "The host's phone may be asleep — give it a tap 👋"
      : "Ring in on your phone!";
  }
}

// The game-over win moment — "your color takes the room" (crib: GeoParty,
// references/win-celebration-ui.md). A fast, non-blocking enhancement: flood the
// winner's team color behind the "👑 name wins" headline, fire a confetti burst
// in that color, then settle (~1.4s, CSS). Pure client render of the ALREADY
// captured winner — no write, no analytics (the win is instrumented elsewhere).
// The tier/color/burst-size mapping is the unit-tested celebrationSpec; the DOM
// + confetti below are UI-only glue. Reduced motion is handled entirely in CSS
// (bloom to its resting frame, .tv-confetti display:none) so this stays
// branch-free — we still build the nodes, CSS just hides them.
function celebrate(winnerSlot, seed) {
  const disp = $("s-display");
  const spec = celebrationSpec({ won: true, teamSlot: winnerSlot, seed });
  if (spec.tier === "none") return;
  celebrated = true;
  disp.style.setProperty("--win", spec.winVar);
  disp.classList.add("celebrate");

  const wrap = $("tvConfetti");
  if (!wrap) return;
  wrap.innerHTML = "";
  // Seeded, deterministic per-strip specs (drift/spin/size/duration variety +
  // gold-heavy champion / accent-leaning win palette) — the unit-tested pure
  // generator. Reduced motion is still handled entirely in CSS (.tv-confetti
  // display:none), so this stays branch-free: we build the looping spans and
  // CSS hides them.
  const strips = confettiSpec({
    count: spec.confettiCount,
    seed: spec.seed,
    tier: spec.tier,
    accentColor: spec.accentColor,
  });
  const frag = document.createDocumentFragment();
  for (const strip of strips) {
    const s = document.createElement("span");
    s.style.setProperty("--x", strip.left + "%");
    s.style.setProperty("--c", strip.color);
    s.style.setProperty("--dur", strip.durationS + "s");
    s.style.setProperty("--delay", strip.delayS + "s");
    s.style.setProperty("--drift", strip.driftVw + "vw");
    s.style.setProperty("--spin", strip.spinDeg + "deg");
    s.style.setProperty("--size", strip.sizeScale);
    frag.appendChild(s);
  }
  wrap.appendChild(frag);
}

// Tear the celebration down so the next game's winner can fire it afresh.
function endCelebration() {
  celebrated = false;
  const disp = $("s-display");
  if (disp) {
    disp.classList.remove("celebrate");
    disp.style.removeProperty("--win");
  }
  const wrap = $("tvConfetti");
  if (wrap) wrap.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Game-over round recap (Item 1) — an auto-cycling card of the settled rounds.
// ---------------------------------------------------------------------------

// Build the recap for a fresh game-over: derive the cards from partyHistory,
// draw the first, and — when there's more than one — start the auto-cycle. The
// TV has no touch input, so a single card cycles (GeoParty style), not a swipe
// carousel. `teams` is captured at build time (settled at game-over) and used
// only for display names (masked in the DOM) + slot ordering. Read-only: no
// write, no transaction, no phase flip.
function buildRecap(teams) {
  const box = $("tvRecap");
  if (!box) return;
  recapCards = partyRecapCards(partyHistory);
  if (!recapCards.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  recapIndex = 0;
  drawRecapCard(teams);
  // The two reveal maps ride the recap band at gameOver (owner spec: rotate them
  // in sync with the recap flags, use the ghost-box space well). Show + aim them
  // at the first card's country; the cycle below re-aims on each advance.
  // updateRevealMaps re-aims live maps in place (no rebuild/flicker) and falls
  // back to a clean build offline / on the first entry — still passive-TV.
  $("tvMaps").classList.remove("hidden");
  syncRecapMaps();
  if (recapCards.length > 1 && !recapTimer) {
    recapTimer = setInterval(() => {
      recapIndex = (recapIndex + 1) % recapCards.length;
      drawRecapCard(teams);
      syncRecapMaps();
    }, RECAP_CYCLE_MS);
  }
}

// Point the two reveal maps at the recap card currently on screen
// (recapCards[recapIndex]). Shared by the first draw and the auto-cycle so both
// stay in lock-step with the card's flag. Read-only (passive-TV).
function syncRecapMaps() {
  const card = recapCards[recapIndex];
  if (!card) return;
  updateRevealMaps({
    worldEl: $("tvMapWorld"),
    bordersEl: $("tvMapBorders"),
    iso2: card.answerIso,
    table: CENTROIDS,
  });
}

// Draw the card at recapIndex into #tvRecap: the round header, the answer flag
// (decorative, aria-hidden) + name, and one row per team with what it guessed.
// A brand-new node is built each cycle so the crossfade animation re-triggers
// (CSS drops it under prefers-reduced-motion — the content still advances).
// Team names are masked inline (data-ph-mask) for session replay; the answer
// country + each guess are shared truth (already disclosed at reveal).
function drawRecapCard(teams) {
  const box = $("tvRecap");
  if (!box) return;
  const card = recapCards[recapIndex];
  if (!card) return;
  const answer = byIso2(card.answerIso);
  const answerName = answer ? answer.name : card.answerIso.toUpperCase();

  const rows = recapTeamResults(card, teams)
    .map((row) => {
      const guessCountry = row.guessIso ? byIso2(row.guessIso) : null;
      const guessName = guessCountry
        ? guessCountry.name
        : row.guessIso
          ? row.guessIso.toUpperCase()
          : "";
      let guess;
      if (row.status === "correct") {
        guess = `✅ got it${row.atStep ? ` at step ${row.atStep}` : ""}`;
      } else if (row.status === "wrong") {
        guess = `❌ guessed ${escapeHtml(guessName)}`;
      } else {
        guess = "🙈 didn't ring";
      }
      return `<li class="tv-recap-team ${row.status}"><span class="tv-recap-name" data-ph-mask>${escapeHtml(
        row.name
      )}</span><span class="tv-recap-guess">${guess}</span></li>`;
    })
    .join("");

  box.innerHTML =
    `<div class="tv-recap-card">` +
    `<img class="tv-recap-flag" src="${escapeHtml(
      flagAssetPath(card.answerIso)
    )}" alt="" aria-hidden="true" />` +
    `<div class="tv-recap-body">` +
    `<div class="tv-recap-round">Round ${card.number} of ${card.totalRounds}</div>` +
    `<div class="tv-recap-answer">${escapeHtml(answerName)}</div>` +
    `<ul class="tv-recap-teams">${rows}</ul>` +
    `</div></div>`;
}

// Tear down the recap card + auto-cycle timer and hide the box. Idempotent —
// called on the leave-gameOver edge, on room changes (resetDisplay/connect), and
// on the reenter-code escape hatch. Clears the build latch so the next game-over
// rebuilds. The partyHistory accumulator itself is NOT cleared here (a
// gameOver → lobby → gameOver of the SAME game must keep the fold); it is reset
// on a room change (connect) and a fresh in-place game (lobby).
function stopRecapCycle() {
  if (recapTimer) {
    clearInterval(recapTimer);
    recapTimer = null;
  }
  recapBuilt = false;
  recapCards = [];
  recapIndex = 0;
  const box = $("tvRecap");
  if (box) {
    box.innerHTML = "";
    box.classList.add("hidden");
  }
}

// Item 2 — the "reenter the code" escape hatch. Leave the current room and
// return to the join screen so the user can type a different code without a
// reload. Mirrors GeoParty's leaveRoom(): stop the heartbeat, drop the
// subscription, clear the room + follow chain + recap fold + URL, and surface a
// blank join screen with the input focused. No game-state write (passive-TV):
// leaving is a pure client teardown.
function leaveToJoin() {
  stopHeartbeat();
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  code = null;
  followedCodes = new Set();
  partyHistory = [];
  if (celebrated) endCelebration();
  resetDisplay(""); // clears the board/beats/answer + the recap (stopRecapCycle)
  $("s-display").classList.add("hidden");
  $("s-join").classList.remove("hidden");
  $("sErr").textContent = "";
  const input = $("sCode");
  if (input) {
    input.value = "";
    input.focus();
  }
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    /* file:// */
  }
}

// Pop the transient "guessed wrong" hint for a team (name already resolved,
// masked in the DOM). Restart the auto-dismiss on each new ring so back-to-back
// wrong guesses each get their ~2.5s beat. Reduced motion is handled in CSS
// (the entrance animation is dropped); the show/hide is unconditional.
function showWrongHint(name) {
  const el = $("tvWrongHint");
  if (!el) return;
  el.innerHTML = `😅 <span data-ph-mask>${escapeHtml(
    name
  )}</span> guessed wrong — keep looking!`;
  el.classList.remove("hidden");
  if (wrongHintTimer) clearTimeout(wrongHintTimer);
  wrongHintTimer = setTimeout(() => {
    wrongHintTimer = null;
    el.classList.add("hidden");
  }, 2500);
}

// Clear the reveal holder INCLUDING the classes/renderState renderReveal
// stamps on the container itself (`flag-canvas`, `full`, --flag-aspect,
// _flagKey latch). innerHTML="" alone leaves a blank 3:2 "ghost flag" box
// above the gameOver recap (field-reported 2026-08-30) and can strand the
// render latch on detached nodes.
function clearReveal() {
  const el = $("tvReveal");
  if (!el) return;
  el.innerHTML = "";
  el.classList.remove("flag-canvas", "full");
  el.style.removeProperty("--flag-aspect");
  el.style.removeProperty("--flag-grid");
  delete el._flagKey;
  delete el._img;
  delete el._tiles;
}

// Tear the two reveal maps down and hide the block. Idempotent (destroyRevealMaps
// is safe to call twice) — called on every non-reveal phase and every teardown
// path. Resets the per-round build latch so the next reveal rebuilds fresh.
function hideMaps() {
  destroyRevealMaps();
  mapsRound = null;
  const el = $("tvMaps");
  if (el) el.classList.add("hidden");
}

// Hide the hint immediately (leaving roundActive, following a room, or a reset).
function hideWrongHint() {
  if (wrongHintTimer) {
    clearTimeout(wrongHintTimer);
    wrongHintTimer = null;
  }
  const el = $("tvWrongHint");
  if (el) el.classList.add("hidden");
}

// Diff this snapshot against the last one and sound whatever changed. The whole
// decision is the pure soundDecisions(); this is the memory + the per-step tick
// dedupe + the (best-effort) playback. Never throws into the render path.
function soundFor(room, steps) {
  const next = soundState(room, steps);
  const decisions = soundDecisions(lastSoundState, next);
  lastSoundState = next;
  // A new round resets the tick dedupe (step numbers restart at 1).
  if (lastTickRound !== next.roundNumber) {
    lastTickRound = next.roundNumber;
    lastTickStep = null;
  }
  const play = [];
  for (const d of decisions) {
    // Belt and braces over the pure diff: a snapshot echo that somehow re-offers
    // a step already ticked this round is dropped here too.
    if (d.kind === "tick") {
      if (lastTickStep != null && d.step <= lastTickStep) continue;
      lastTickStep = d.step;
    }
    play.push(d);
  }
  playSounds(play);
}

// Standings, reconciled row-by-row (Change 2) rather than rebuilt: one `<li>`
// per team slot, so totals count up and rank swaps FLIP instead of teleporting.
// `#tvBoard` carries data-ph-mask, so the team name inside `.team-name` stays
// masked for session replay exactly as before. The crown gets its own element so
// it can take the one-shot bounce at game-over (CSS `.crown`).
function renderBoard(ul, teams, winner) {
  const rows = Object.keys(teams)
    .map((tN) => ({ key: tN, name: teams[tN].name, total: teams[tN].total || 0 }))
    .sort((a, b) => b.total - a.total);
  reconcileBoard(ul, rows, (li, row) => {
    li.querySelector(".team-label").textContent = row.name == null ? row.key : row.name;
    // The crown element is created ONCE (when the winner appears) and left in
    // place: render() re-runs on every heartbeat, and re-inserting the node
    // would restart its one-shot bounce every few seconds.
    const nameWrap = li.querySelector(".team-name");
    const crowned = winner === row.key;
    let crown = nameWrap.querySelector(".crown");
    if (crowned && !crown) {
      crown = document.createElement("span");
      crown.className = "crown";
      crown.textContent = "👑";
      nameWrap.appendChild(crown);
    } else if (!crowned && crown) {
      crown.remove();
    }
  });
}

function renderBeats(box, results, teams, steps, lockOut) {
  box.innerHTML = "";
  // Mode-aware suffix: a wrong ring locks a team out only in "First correct wins"
  // (lockOut). In "Multiple guesses" the team keeps playing, so never say "out".
  const suffix = lockOut ? "out this round." : "still in the round.";
  for (const tN of Object.keys(results)) {
    const res = results[tN];
    if (res && res.rangOut && res.wrongIso) {
      const t = teams[tN];
      const wrong = byIso2(res.wrongIso);
      const div = document.createElement("div");
      div.className = "beat";
      // The wrong country's vendored flag SVG next to the comedy line. Decorative
      // (aria-hidden) — the guess is named in the text; no personal data on it.
      div.innerHTML = `<img class="beat-flag" src="${escapeHtml(
        flagAssetPath(res.wrongIso)
      )}" alt="" aria-hidden="true" /><span class="beat-text">😅 <span data-ph-mask>${escapeHtml(
        t ? t.name : tN
      )}</span> guessed ${escapeHtml(
        wrong ? wrong.name : res.wrongIso.toUpperCase()
      )} at step ${res.wrongStep} of ${steps} — ${suffix}</span>`;
      box.appendChild(div);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function wire() {
  // Unlock WebAudio inside the first real gesture (autoplay policy) so the room
  // sound layer can actually sound — every trigger fires in the snapshot-echo
  // render path, never in a gesture, and a context created outside one stays
  // "suspended" forever. Same pattern as the phone and the Daily.
  //
  // HONEST CAVEAT: a TV is often never touched — a `?room=CODE` boot from a
  // scanned QR or a shared link reaches the display screen with no gesture at
  // all. Then the context stays suspended and every sound is a silent no-op
  // (tv-sound.js bails rather than scheduling into it). That is the accepted
  // degradation: the sound layer is decorative, the text is the source of truth.
  // Typing the code on the TV (the common setup) is a keydown, so that path
  // unlocks.
  const prime = () => primeAudio();
  window.addEventListener("pointerdown", prime, { once: true });
  window.addEventListener("keydown", prime, { once: true });

  // The reconnecting pill: registered ONCE at boot (F5), not per connect() —
  // registering it on every follow/reconnect stacked a fresh listener each time.
  onConnectionChange((up) => $("connPill").classList.toggle("hidden", up));

  // Server-time correction for the reveal countdown / stall cue — a live
  // subscription (§1.4), never a one-shot read, so a drifting TV clock stays
  // anchored on the server's. Registered once at boot; display-only.
  subscribeServerTimeOffset((off) => {
    serverTimeOffset = off || 0;
  });

  // The reenter-code escape hatch (Item 2): visible on lobby + gameOver (CSS),
  // it leaves the room back to the join screen so a new code can be typed.
  const btnNew = $("btnTvNewEntry");
  if (btnNew) btnNew.addEventListener("click", leaveToJoin);

  $("sCode").addEventListener("input", (e) => {
    // Strip to the code alphabet as we go (GeoParty parity), then auto-connect
    // the moment a full valid code is present — no Connect press needed. A full
    // pasted code auto-joins the same way (the Connect button was removed).
    const c = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, "");
    e.target.value = c;
    if (isValidRoomCode(c)) {
      $("sErr").textContent = "";
      followedCodes = new Set(); // manual entry starts a fresh follow chain (F3)
      connect(c, "typed");
    }
  });

  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get("room") || "").toUpperCase();
  // A QR-scanned arrival carries ?via=qr; a hand-shared link is "link".
  const urlVia = params.get("via") === "qr" ? "qr" : "link";
  if (isValidRoomCode(urlRoom)) {
    followedCodes = new Set(); // URL boot starts a fresh follow chain (F3)
    connect(urlRoom, urlVia);
  } else {
    // Item C — a TV booting to the join screen (no valid ?room=) starts with the
    // code input focused so the operator can type immediately. HONEST LIMIT:
    // browsers that gate the on-screen keyboard behind a user gesture (mobile
    // Safari, some TV browsers) show the caret but won't pop the keyboard until
    // one tap — a browser policy the page can't override. Not focused when the
    // URL boots straight into a room (the display screen is up, not the input).
    const input = $("sCode");
    if (input) input.focus();
  }
}

window.addEventListener("beforeunload", () => {
  stopHeartbeat();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire, { once: true });
} else {
  wire();
}
