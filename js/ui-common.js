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
export function pop(fromHz = 540, toHz = 900) {
  if (reduceMotion) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(fromHz, now);
    osc.frequency.exponentialRampToValueAtTime(toHz, now + 0.09);
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
