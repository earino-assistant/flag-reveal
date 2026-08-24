// screen-flag.js — the Flag Reveal TV renderer. A pure-ish subscriber: it
// renders `currentStep` via the progressive reveal, standings, the winner and
// the crown, and — at reveal — the wrong-ring comedy beats from results/*.
//
// PASSIVE-TV CONTRACT (SPEC §6, §13 — do not regress):
//   - The TV writes ONLY `screenHeartbeat`.
//   - It runs NO roundConduct, NO resolveRound/advanceRound transaction, NO
//     cadence. It owns no timer that changes game state and holds no authority.
//   - It never reads round/private/* (privacy render-discipline, §5.2) — it
//     reads only public round fields and results/* (post-round disclosure).

import {
  subscribeRoom,
  writeScreenHeartbeat,
  onConnectionChange,
} from "./firebase.js";
import { renderReveal } from "./reveal-render.js";
import { gameWinner, shouldFollowRoom } from "./flag.js";
import { FLAGS, byIso2 } from "./flags-data.js";
import { isValidRoomCode, screenQuery } from "./roomcode.js";
import { GAME_DEFAULTS } from "../config.js";
import { track } from "./consent.js";
import { drawQr } from "./qr.js";

const $ = (id) => document.getElementById(id);
let code = null;
let via = "typed";
let heartbeatTimer = null;
let unsubRoom = null;
// Rooms joined since the last manual entry — breaks nextRoom pointer cycles
// (A → B → A would otherwise re-subscribe forever). SPEC-v3.1 §1530 mandates
// this "verbatim" from the GeoParty kernel. Reset on manual entry and URL boot.
let followedCodes = new Set();

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
// a phantom `rooms/{WRONGCODE}/screenHeartbeat` node in the shared DB. Every 4s
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

  code = c;
  via = joinVia || "typed";
  followedCodes.add(code);
  $("tvCode").textContent = code;
  $("sErr").textContent = "";
  $("s-join").classList.add("hidden");
  $("s-display").classList.remove("hidden");
  // The couch-join QR: a phone scanning it lands on player.html?room=CODE.
  const qc = $("tvJoinQrCanvas");
  if (qc) drawQr(qc, new URL("player.html?room=" + code, location.href).href);
  track("screen_joined", { mode: "tv", via });

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
  $("tvReveal").innerHTML = "";
  $("tvResult").textContent = "";
  $("tvComingUp").textContent = "";
  $("tvNote").textContent = "";
  $("tvAnswer").classList.add("hidden");
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

  renderBoard($("tvBoard"), teams, phase === "gameOver" ? gameWinner(teams, cfg) : null);
  // The join QR belongs to the lobby only — hidden the moment play starts.
  const qrWrap = $("tvJoinQr");
  if (qrWrap) qrWrap.classList.toggle("hidden", phase !== "lobby");

  if (phase === "lobby") {
    // Echo the room code into the big QR caption so it's legible across the
    // room (the top-left .tv-room label is too small at 10 feet). Masked for
    // session replay.
    $("tvJoinCode").textContent = code;
    $("tvHeader").textContent = "Lobby — join on your phone";
    $("tvAnswer").classList.add("hidden");
    $("tvResult").textContent = "";
    $("tvComingUp").textContent = "";
    $("tvBeats").innerHTML = "";
    $("tvReveal").innerHTML = "";
    const n = Object.keys(teams).length;
    $("tvNote").textContent = n
      ? `${n} player${n === 1 ? "" : "s"} in.`
      : "Enter the room code on your phone to join.";
    return;
  }

  if (phase === "gameOver") {
    const winner = gameWinner(teams, cfg);
    const wt = teams[winner];
    $("tvHeader").textContent = "Game over";
    $("tvReveal").innerHTML = "";
    $("tvAnswer").classList.add("hidden");
    $("tvResult").innerHTML = wt
      ? `👑 <strong data-ph-mask>${escapeHtml(wt.name)}</strong> wins — ${wt.total || 0} pts!`
      : "Game over";
    $("tvComingUp").textContent = "";
    $("tvBeats").innerHTML = "";
    $("tvNote").textContent = "Start a new game on the host's phone.";
    return;
  }

  if (!r) return;
  const effRounds = Math.min(cfg.roundCount, poolSize(cfg.difficulty));
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
    const oc = r.outcome || {};
    const answer = byIso2(r.answerIso);
    $("tvAnswer").textContent = answer ? answer.name : r.answerIso.toUpperCase();
    $("tvAnswer").classList.remove("hidden");
    if (oc.kind === "win") {
      const wt = teams[oc.team];
      const pts = (r.results && r.results[oc.team] && r.results[oc.team].points) || 0;
      $("tvResult").innerHTML = `<strong data-ph-mask>${escapeHtml(
        wt ? wt.name : oc.team
      )}</strong> got it at step ${oc.atStep} — +${pts}!`;
    } else {
      $("tvResult").textContent = `Nobody got it! 🙈`;
    }
    renderBeats($("tvBeats"), r.results || {}, teams);
    // Coming-up line rides in the main column under the result, where all eyes
    // are; tvNote is reserved for lobby/idle states.
    $("tvComingUp").textContent = "Next round coming up…";
    $("tvNote").textContent = "";
  } else {
    $("tvAnswer").classList.add("hidden");
    $("tvResult").textContent = "";
    $("tvComingUp").textContent = "";
    $("tvBeats").innerHTML = "";
    $("tvNote").textContent = "Ring in on your phone!";
  }
}

function renderBoard(ul, teams, winner) {
  ul.innerHTML = "";
  const rows = Object.keys(teams)
    .map((tN) => ({ tN, ...teams[tN] }))
    .sort((a, b) => (b.total || 0) - (a.total || 0));
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "team-row team-" + row.tN.slice(1);
    const crown = winner === row.tN ? " 👑" : "";
    li.innerHTML = `<span>${escapeHtml(row.name)}${crown}</span><span class="score">${
      row.total || 0
    }</span>`;
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
      div.innerHTML = `😅 <span data-ph-mask>${escapeHtml(t ? t.name : tN)}</span> guessed ${escapeHtml(
        wrong ? wrong.name : res.wrongIso.toUpperCase()
      )} at step ${res.wrongStep} — out this round.`;
      box.appendChild(div);
    }
  }
}

function poolSize(difficulty) {
  return FLAGS.filter(
    (f) => f.eligible !== false && (difficulty === "world" || f.tier === difficulty)
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
// Boot
// ---------------------------------------------------------------------------
function wire() {
  // The reconnecting pill: registered ONCE at boot (F5), not per connect() —
  // registering it on every follow/reconnect stacked a fresh listener each time.
  onConnectionChange((up) => $("connPill").classList.toggle("hidden", up));

  $("btnSConnect").addEventListener("click", () => {
    const c = ($("sCode").value || "").trim().toUpperCase();
    if (!isValidRoomCode(c)) {
      $("sErr").textContent = "Enter a 6-letter room code.";
      return;
    }
    followedCodes = new Set(); // manual entry starts a fresh follow chain (F3)
    connect(c, "typed");
  });
  $("sCode").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get("room") || "").toUpperCase();
  // A QR-scanned arrival carries ?via=qr; a hand-shared link is "link".
  const urlVia = params.get("via") === "qr" ? "qr" : "link";
  if (isValidRoomCode(urlRoom)) {
    followedCodes = new Set(); // URL boot starts a fresh follow chain (F3)
    connect(urlRoom, urlVia);
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
