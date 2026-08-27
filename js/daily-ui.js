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
import { FLAGS, byIso2 } from "./flags-data.js";
import { track } from "./consent.js";
import { toast, suggestFor, pop, primeAudio, vibrate } from "./ui-common.js";

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
// toast + the WebAudio pop (the Daily's 520→880 Hz variant) are shared in
// ui-common.js; the pop() call site passes the Daily frequencies.

// ---------------------------------------------------------------------------
// Typeahead (over the full dataset). suggestFor + NAME_INDEX are shared in
// ui-common.js; renderSuggest / hideSuggest stay here (the `answered` guard and
// the commitGuess callback are Daily-specific).
// ---------------------------------------------------------------------------
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
    pop(520, 880);
    vibrate([10, 40, 20]);
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
  track("daily_round", {
    dayNumber: dayNum,
    roundNumber: roundIdx + 1,
    correct: entry.correct,
    atStep: entry.atStep,
    points: entry.points,
    tier: (byIso2(answerIso()) || {}).tier,
  });
  const ans = byIso2(answerIso());
  $("dRevealHead").textContent = `Flag ${roundIdx + 1} / ${DAILY_ROUNDS}`;
  paintReveal($("dRevealFlag"), true);
  $("dRevealAnswer").textContent = ans ? ans.name : String(answerIso()).toUpperCase();
  const resultEl = $("dRevealResult");
  if (entry.correct) {
    resultEl.textContent = `🎉 Named it at step ${entry.atStep} of ${DAILY_STEPS} — +${entry.points}!`;
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
  $("dDoneTitle").textContent = locked
    ? "You've played today's Daily ✓"
    : `Daily #${dayNum} — you did it! 🎉`;
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
  // Unlock WebAudio inside the first real gesture (iOS Safari autoplay policy) so
  // the correct-answer pop can actually sound — pop() fires in a render path, not
  // a gesture, where a never-resumed context stays silent.
  const prime = () => primeAudio();
  window.addEventListener("pointerdown", prime, { once: true });
  window.addEventListener("touchstart", prime, { once: true });
  $("btnDailyStart").addEventListener("click", startDaily);
  $("btnDNext").addEventListener("click", nextRound);
  $("btnDShare").addEventListener("click", doShare);

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
