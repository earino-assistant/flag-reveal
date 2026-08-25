// ui-common.js — the small set of DOM helpers that were byte-identical across
// the phone (flag-ui.js), the TV (screen-flag.js) and the Daily (daily-ui.js).
// Only the truly-shared, non-diverging copies live here; anything that has drifted
// (renderBoard/renderBeats, renderSuggest/hideSuggest) is deliberately left in
// place. This module is browser-side glue (it touches the DOM and WebAudio) but
// owns no game logic.

import { FLAGS } from "./flags-data.js";
import { normalizeName } from "./flag.js";

// Escape the four HTML-significant characters. Identical copies were in
// flag-ui.js and screen-flag.js.
export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

// The transient bottom toast (#toast on player.html and daily.html). Fades in/
// out via the `.show` class (CSS opacity transition) rather than a hard display
// toggle, so it eases instead of popping; same 2.6s dismiss, one shared timer.
let toastTimer = null;
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------------------
// Typeahead ranking — the identical NAME_INDEX + suggestFor pair. renderSuggest
// / hideSuggest are NOT here: they diverge (different element ids and commit
// callbacks between the phone and the Daily), so each file keeps its own.
// ---------------------------------------------------------------------------
export const NAME_INDEX = FLAGS.map((f) => ({
  iso2: f.iso2,
  name: f.name,
  keys: [f.name, ...(f.aliases || [])].map(normalizeName),
}));

// Rank the dataset for a query: prefix matches first, then substring matches,
// capped at 6. Pure over NAME_INDEX.
export function suggestFor(query) {
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

// ---------------------------------------------------------------------------
// The WebAudio "pop" on a correct answer. The phone (540→900 Hz) and the Daily
// (520→880 Hz) differed ONLY in the two frequencies, so they parametrize. Silent
// for prefers-reduced-motion users; fully best-effort (audio may be blocked).
// ---------------------------------------------------------------------------
const reduceMotion =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
let audioCtx = null;

// Get (creating once) the shared AudioContext, or null if WebAudio is absent.
function getCtx() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

// Prime/resume the AudioContext from INSIDE a real user gesture. iOS Safari's
// autoplay policy leaves any context created outside a gesture "suspended"
// forever — and pop() fires in the snapshot-echo render path (not a gesture), so
// without this the signature win sound never sounds on iPhones. Each app wires
// this to the first pointerdown/touch at boot (once is enough). Idempotent and a
// no-op under reduced motion (pop is silent there anyway).
export function primeAudio() {
  if (reduceMotion) return;
  const ctx = getCtx();
  if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
    ctx.resume().catch(() => {});
  }
}

export function pop(fromHz = 540, toHz = 900) {
  if (reduceMotion) return;
  try {
    const ctx = getCtx();
    if (!ctx) return;
    // A context never unlocked inside a gesture (autoplay-locked iOS) stays
    // suspended: don't sound into it — nudge a resume for next time and bail,
    // rather than scheduling a note that never plays.
    if (ctx.state === "suspended") {
      if (typeof ctx.resume === "function") ctx.resume().catch(() => {});
      return;
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(fromHz, now);
    osc.frequency.exponentialRampToValueAtTime(toHz, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
    /* audio blocked — no-op */
  }
}

// Best-effort haptic tap (Android; iOS Safari ignores navigator.vibrate). Guarded
// for existence and silenced under reduced motion, matching pop()'s discipline.
// `pattern` is a Vibration API duration or on/off array (e.g. [15], [10,40,20]).
export function vibrate(pattern) {
  if (reduceMotion) return;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    /* vibrate blocked — no-op */
  }
}
