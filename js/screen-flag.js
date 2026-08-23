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
import { gameWinner } from "./flag.js";
import { FLAGS, byIso2 } from "./flags-data.js";
import { isValidRoomCode } from "./roomcode.js";
import { GAME_DEFAULTS } from "../config.js";
import { track } from "./consent.js";
import { drawQr } from "./qr.js";

const $ = (id) => document.getElementById(id);
let code = null;
let heartbeatTimer = null;

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

function connect(c, via) {
  code = c;
  $("tvCode").textContent = code;
  $("s-join").classList.add("hidden");
  $("s-display").classList.remove("hidden");
  // The couch-join QR: a phone scanning it lands on player.html?room=CODE.
  const qc = $("tvJoinQrCanvas");
  if (qc) drawQr(qc, new URL("player.html?room=" + code, location.href).href);
  track("screen_joined", { mode: "tv", via: via || "typed" });

  // The ONLY thing the TV ever writes: its heartbeat (§6). Every 4s.
  const beat = () => writeScreenHeartbeat(code);
  beat();
  heartbeatTimer = setInterval(beat, 4000);

  onConnectionChange((up) => $("connPill").classList.toggle("hidden", up));
  subscribeRoom(code, render);
}

function render(room) {
  if (!room) {
    $("tvHeader").textContent = "Waiting for the room…";
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
    $("tvHeader").textContent = "Lobby — join on your phone";
    $("tvAnswer").classList.add("hidden");
    $("tvResult").textContent = "";
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
      )}</strong> rang it at step ${oc.atStep} — +${pts}!`;
    } else {
      $("tvResult").textContent = `Nobody got it! 🙈`;
    }
    renderBeats($("tvBeats"), r.results || {}, teams);
    $("tvNote").textContent = "Next round coming up…";
  } else {
    $("tvAnswer").classList.add("hidden");
    $("tvResult").textContent = "";
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
      div.innerHTML = `😅 <span data-ph-mask>${escapeHtml(t ? t.name : tN)}</span> rang ${escapeHtml(
        wrong ? wrong.name : res.wrongIso.toUpperCase()
      )} at step ${res.wrongStep}`;
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
  $("btnSConnect").addEventListener("click", () => {
    const c = ($("sCode").value || "").trim().toUpperCase();
    if (!isValidRoomCode(c)) {
      $("sErr").textContent = "Enter a 6-letter room code.";
      return;
    }
    connect(c, "typed");
  });
  $("sCode").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get("room") || "").toUpperCase();
  // A QR-scanned arrival carries ?via=qr; a hand-shared link is "link".
  const via = params.get("via") === "qr" ? "qr" : "link";
  if (isValidRoomCode(urlRoom)) connect(urlRoom, via);
}

window.addEventListener("beforeunload", () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire, { once: true });
} else {
  wire();
}
