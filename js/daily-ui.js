// daily-ui.js — the Flag Reveal Daily Challenge page (daily.html). A solo,
// single-device run of five flags, the same for everyone on a given local day.
// Logic-light glue: the flag sequence, per-flag reveal seed, scoring, streak and
// replay-lock all come from the pure, tested modules (daily.js / flag.js), and
// the share card from share.js. This file only paints them and runs the reveal
// clock. No Firebase, no room, no transactions — nothing here touches the
// concurrency core.

import {
  dailyKey,
  dailyNumber,
  dailyFlags,
  dailyFlagSeed,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  correctRounds,
  nextStreak,
  loadDailyResult,
  loadLastResult,
  saveDailyResult,
  DAILY_ROUNDS,
  DAILY_STEPS,
} from "./daily.js";
import { dailyShareText, emojiRow, withUtm } from "./share.js";
import { shareText } from "./share-ui.js";
import { renderReveal } from "./reveal-render.js";
import { normalizeName } from "./flag.js";
import { FLAGS, byIso2 } from "./flags-data.js";
import { track, openBanner } from "./consent.js";

// Reveal cadence (Classic pace). A flag opens over ~8 steps, then a short grace
// window in which a late answer still counts before the round times out.
const STEP_MS = 1400;
const GRACE_MS = 2600;
const GRID_N = 4;
const ASPECT = "3:2";

const $ = (id) => document.getElementById(id);
const SCREENS = ["d-intro", "d-round", "d-reveal", "d-done"];
function show(id) {
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

const reduceMotion =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// A subtle "pop" on a correct name — WebAudio, tiny, and only when motion/FX is
// welcome (reduced-motion users get none). Fully best-effort.
let audioCtx = null;
function pop() {
  if (reduceMotion) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
    /* audio blocked — no-op */
  }
}

// ---------------------------------------------------------------------------
// Typeahead (a compact clone of the party phone's, over the full dataset)
// ---------------------------------------------------------------------------
const NAME_INDEX = FLAGS.map((f) => ({
  iso2: f.iso2,
  name: f.name,
  keys: [f.name, ...(f.aliases || [])].map(normalizeName),
}));
function suggestFor(query) {
  const q = normalizeName(query);
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const e of NAME_INDEX) {
    let rank = 2;
    for (const k of e.keys) {
      if (k.startsWith(q)) {
        rank = 0;
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
  const list = suggestFor(query);
  const ul = $("dSuggest");
  ul.innerHTML = "";
  if (!list.length || answered) {
    hideSuggest();
    return;
  }
  for (const e of list) {
    const li = document.createElement("li");
    li.textContent = e.name;
    li.dataset.iso = e.iso2;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      commitGuess(e.iso2);
    });
    ul.appendChild(li);
  }
  ul.classList.remove("hidden");
}
function hideSuggest() {
  $("dSuggest").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Daily state
// ---------------------------------------------------------------------------
const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
let key = null;
let dayNum = 0;
let flags = []; // iso2[] for the day
let run = null;
let roundIdx = 0; // 0-based
let currentStep = 1;
let answered = false; // this round settled (named or timed out)
let revealTimer = null;
let missTimer = null;

function clearTimers() {
  clearTimeout(revealTimer);
  clearTimeout(missTimer);
  revealTimer = null;
  missTimer = null;
}

function answerIso() {
  return flags[roundIdx];
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  const today = new Date();
  key = dailyKey(today);
  dayNum = dailyNumber(key);
  flags = dailyFlags(key, FLAGS);

  $("dNum").textContent = `#${dayNum}`;
  $("dDate").textContent = today.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Streak preview on the intro (from the last stored board, if consecutive).
  const last = loadLastResult(store());
  const preview = nextStreak(last, key);
  if (last && preview >= 2 && last.key !== key) {
    // Only a live streak that today would EXTEND is worth teasing.
    $("dStreak").textContent = `🔥 ${last.streak || 1}-day streak on the line`;
    $("dStreak").classList.remove("hidden");
  }

  // Replay lock: already played today → straight to the done/locked screen.
  const done = loadDailyResult(store(), key);
  if (done) {
    run = done;
    showDone(done, { locked: true });
  } else {
    show("d-intro");
  }

  wire();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
function startDaily() {
  if (loadDailyResult(store(), key)) return; // guard: already played
  run = newDailyRun(key);
  roundIdx = 0;
  track("daily_started", { dayNumber: dayNum });
  startRound();
}

function startRound() {
  answered = false;
  currentStep = 1;
  clearTimers();
  const inp = $("dInput");
  inp.value = "";
  inp.disabled = false;
  hideSuggest();
  $("dStatus").textContent = "";
  $("dRoundHead").textContent = `Flag ${roundIdx + 1} / ${DAILY_ROUNDS}`;
  $("dScoreHead").textContent = `${run.score.toLocaleString()} pts`;
  paintReveal($("dReveal"), false);
  show("d-round");
  inp.focus();
  scheduleStep();
}

function scheduleStep() {
  revealTimer = setTimeout(() => {
    revealTimer = null;
    if (answered) return;
    if (currentStep < DAILY_STEPS) {
      currentStep++;
      paintReveal($("dReveal"), false);
      scheduleStep();
    } else {
      // Fully revealed: a short grace to still name it, then time out.
      missTimer = setTimeout(missOut, GRACE_MS);
    }
  }, STEP_MS);
}

function paintReveal(el, full) {
  renderReveal(el, {
    flagSeed: dailyFlagSeed(key, roundIdx + 1) >>> 0,
    currentStep,
    gridN: GRID_N,
    steps: DAILY_STEPS,
    iso2: answerIso(),
    revealAspect: ASPECT,
    full: !!full,
  });
}

function commitGuess(iso2) {
  if (answered || !iso2) return;
  if (iso2 === answerIso()) {
    answered = true;
    clearTimers();
    hideSuggest();
    pop();
    run = recordDailyRound(run, { correct: true, atStep: currentStep });
    showReveal();
  } else {
    // Forgiving: a wrong pick doesn't end the round — but the flag keeps
    // sharpening, so it still costs points (and eventually times out).
    $("dInput").value = "";
    hideSuggest();
    const wrong = byIso2(iso2);
    $("dStatus").textContent = wrong ? `Not ${wrong.name} — keep looking 👀` : "Not it — keep looking 👀";
  }
}

function missOut() {
  if (answered) return;
  answered = true;
  clearTimers();
  run = recordDailyRound(run, { correct: false });
  showReveal();
}

function showReveal() {
  const entry = run.rounds[roundIdx];
  const ans = byIso2(answerIso());
  $("dRevealHead").textContent = `Flag ${roundIdx + 1} / ${DAILY_ROUNDS}`;
  paintReveal($("dRevealFlag"), true);
  $("dRevealAnswer").textContent = ans ? ans.name : String(answerIso()).toUpperCase();
  const resultEl = $("dRevealResult");
  if (entry.correct) {
    resultEl.textContent = `🎉 Named it at step ${entry.atStep} — +${entry.points}!`;
    resultEl.className = "reveal-result good";
  } else {
    resultEl.textContent = "Missed this one. 🙈";
    resultEl.className = "reveal-result bad";
  }
  $("dRevealTotal").textContent = run.score.toLocaleString();
  $("btnDNext").textContent = roundIdx + 1 >= DAILY_ROUNDS ? "See your result" : "Next flag";
  show("d-reveal");
}

function nextRound() {
  roundIdx++;
  if (dailyRunComplete(run)) {
    finish();
  } else {
    startRound();
  }
}

function finish() {
  const streak = nextStreak(loadLastResult(store()), key);
  run = { ...run, streak, dayNumber: dayNum };
  saveDailyResult(store(), run);
  track("daily_completed", {
    dayNumber: dayNum,
    score: run.score,
    correct: correctRounds(run),
    streak,
  });
  showDone(run, { locked: false });
}

function showDone(result, { locked }) {
  $("dDoneTitle").textContent = locked ? "You've done today's ✓" : "Daily done!";
  $("dDoneScore").textContent = (result.score || 0).toLocaleString();
  $("dDoneEmoji").textContent = emojiRow(result.rounds, DAILY_STEPS);
  const streak = result.streak || 0;
  if (streak >= 2) {
    $("dDoneStreak").textContent = `🔥 ${streak}-day streak`;
    $("dDoneStreak").classList.remove("hidden");
  } else {
    $("dDoneStreak").classList.add("hidden");
  }
  show("d-done");
}

async function doShare() {
  const base = new URL("daily.html", location.href).href;
  const url = withUtm(base, "daily");
  const text = dailyShareText({
    dayNumber: run.dayNumber || dayNum,
    score: run.score,
    rounds: run.rounds,
    url,
    streak: run.streak || 0,
    steps: DAILY_STEPS,
  });
  await shareText(text, {
    event: "share_daily",
    props: {
      dayNumber: run.dayNumber || dayNum,
      score: run.score,
      rounds: correctRounds(run),
      streak: run.streak || 0,
    },
    toast,
  });
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  $("btnDailyStart").addEventListener("click", startDaily);
  $("btnDNext").addEventListener("click", nextRound);
  $("btnDShare").addEventListener("click", doShare);
  const priv = $("btnPrivacy");
  if (priv) priv.addEventListener("click", openBanner);

  const inp = $("dInput");
  inp.addEventListener("input", () => renderSuggest(inp.value));
  inp.addEventListener("focus", () => renderSuggest(inp.value));
  inp.addEventListener("blur", () => setTimeout(hideSuggest, 120));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const list = suggestFor(inp.value);
      if (list.length) commitGuess(list[0].iso2);
    } else if (e.key === "Escape") {
      hideSuggest();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
