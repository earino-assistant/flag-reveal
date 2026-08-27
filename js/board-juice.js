// board-juice.js — the shared scoreboard animation layer for the phone
// (js/flag-ui.js) and the TV (js/screen-flag.js).
//
// Both boards used to nuke `innerHTML` on every snapshot, so a score snapped
// from 40 to 100 and a rank swap teleported. This module keeps ONE `<li>` per
// team (keyed by slot id `tN`), updates it in place, counts the number up, and
// FLIPs the rows that changed rank.
//
// Presentation only: no game logic, no Firebase, no write, no analytics. The
// decisions worth testing are pure and live at the top (rankChanges, the easing
// + progress math, countUpValue — see tests/board-juice.test.js); the DOM below
// is thin glue. Reduced motion collapses every animation to its end state.

import { prefersReducedMotion } from "./ui-common.js";

// ---------------------------------------------------------------------------
// Pure core — no DOM.
// ---------------------------------------------------------------------------

// Which teams changed rank between two orderings? Drives the FLIP: only rows
// whose INDEX moved need animating. Teams that appeared (a lobby join) or
// disappeared are not "moved" — they have no before/after pair. Returned in
// `afterOrder` order so callers animate top-down.
export function rankChanges(beforeOrder, afterOrder) {
  const before = new Map();
  (beforeOrder || []).forEach((key, i) => before.set(key, i));
  const moved = [];
  (afterOrder || []).forEach((key, i) => {
    const was = before.get(key);
    if (was != null && was !== i) moved.push(key);
  });
  return moved;
}

// Ease-out cubic: fast off the mark, settling into the final number. `t` is
// clamped, so a caller that overshoots the duration still lands exactly on 1.
export function easeOutCubic(t) {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

// Clamped linear progress through the animation. A zero/negative/absent duration
// means "already done" (1), which is what the reduced-motion path wants.
export function countUpProgress(elapsedMs, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.max(0, Math.min(1, elapsedMs / durationMs));
}

// The displayed integer at a given progress. Exact at both ends (progress 1
// lands on `to`, never on a rounding neighbour), so the board always settles on
// the true total.
export function countUpValue(from, to, progress) {
  const p = Math.max(0, Math.min(1, progress));
  if (p >= 1) return to;
  return Math.round(from + (to - from) * easeOutCubic(p));
}

// ---------------------------------------------------------------------------
// DOM glue.
// ---------------------------------------------------------------------------

export const COUNT_UP_MS = 400;
export const FLIP_MS = 320;
const FLIP_EASE = "cubic-bezier(0.2, 0.7, 0.3, 1)";

const raf =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
const cancelRaf =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : () => {};

// Count `el`'s number up (or down) to `to` over ~400ms.
//
// `el._countValue` is the number currently ON SCREEN — not the target — so a
// newer snapshot mid-animation resumes from where the eye is, rather than
// snapping back to the old start. In-flight frames are cancelled first, and an
// unchanged value never restarts the animation (the brief's two hard rules).
export function animateCount(el, to, opts = {}) {
  if (!el) return;
  const durationMs = opts.durationMs != null ? opts.durationMs : COUNT_UP_MS;
  const reduced = opts.reduced != null ? opts.reduced : prefersReducedMotion();
  const target = Number.isFinite(to) ? to : 0;

  if (el._countRaf) {
    cancelRaf(el._countRaf);
    el._countRaf = null;
  }
  const from = Number.isFinite(el._countValue) ? el._countValue : target;

  const settle = () => {
    el._countValue = target;
    el.textContent = String(target);
  };
  // Unchanged, motion-averse, or no rAF (a non-browser host): land instantly.
  if (from === target || reduced || !raf) {
    settle();
    return;
  }

  let t0 = null;
  const step = (now) => {
    if (t0 == null) t0 = now;
    const p = countUpProgress(now - t0, durationMs);
    const v = countUpValue(from, target, p);
    el._countValue = v;
    el.textContent = String(v);
    if (p >= 1) {
      el._countRaf = null;
      settle();
      return;
    }
    el._countRaf = raf(step);
  };
  el._countRaf = raf(step);
}

// Reconcile a `<ul>` of team rows against `rows` (already in display order),
// keeping one `<li>` per `row.key` so rows can animate instead of teleporting.
//
//   rows     — [{ key: "t1", total: 42, ...anything the caller needs }]
//   fillRow  — (li, row) => void. Owns everything EXCEPT the score number: the
//              name span, the crown, the delta chip. Called for new and reused
//              rows alike.
//
// Each row's skeleton is
//   <span class="team-name"><span class="team-label"></span></span>
//   <span class="score"><span class="score-num"></span></span>
// Callers write the name into `.team-label` and hang their own extras off
// `.team-name` (the TV's crown) or `.score` (the phone's `+N` delta) — the
// wrapper spans exist precisely so a caller's extra child is never clobbered by
// a `textContent` write, which would re-insert it and restart its animation on
// every snapshot echo. Only `.score-num` is owned here.
//
// Masking is unchanged: every board `<ul>` (#tvBoard, #revealBoard, #goBoard)
// already carries `data-ph-mask`, and the team name still renders inside it.
export function reconcileBoard(ul, rows, fillRow) {
  if (!ul) return;
  const reduced = prefersReducedMotion();

  // FLIP "first": the order and vertical position BEFORE this snapshot lands.
  const existing = new Map();
  const beforeOrder = [];
  const beforeTop = new Map();
  for (const li of Array.from(ul.children)) {
    const key = li.dataset && li.dataset.team;
    if (!key) {
      // Anything that is not a keyed team row was written by someone else (the
      // phone's solo "Total so far" block reuses #revealBoard) — this list is
      // ours now, so clear it, exactly as the old innerHTML rebuild did.
      li.remove();
      continue;
    }
    existing.set(key, li);
    beforeOrder.push(key);
    beforeTop.set(key, li.offsetTop);
  }

  const nodes = new Map();
  const afterOrder = [];
  for (const row of rows || []) {
    let li = existing.get(row.key);
    const fresh = !li;
    if (fresh) {
      li = document.createElement("li");
      li.dataset.team = row.key;
      const name = document.createElement("span");
      name.className = "team-name";
      const label = document.createElement("span");
      label.className = "team-label";
      name.appendChild(label);
      const score = document.createElement("span");
      score.className = "score";
      const num = document.createElement("span");
      num.className = "score-num";
      score.appendChild(num);
      li.append(name, score);
    }
    li.className = "team-row team-" + String(row.key).slice(1);
    if (typeof fillRow === "function") fillRow(li, row);
    const num = li.querySelector(".score-num");
    const total = Number.isFinite(row.total) ? row.total : 0;
    if (fresh) {
      // A team's FIRST appearance has no "before" number to count up from.
      num._countValue = total;
      num.textContent = String(total);
    } else {
      animateCount(num, total, { reduced });
    }
    // appendChild MOVES an existing node — this both inserts new rows and
    // reorders reused ones into the new ranking.
    ul.appendChild(li);
    nodes.set(row.key, li);
    afterOrder.push(row.key);
  }

  // Teams that vanished (a room change / fresh game) leave with their row.
  for (const [key, li] of existing) {
    if (!nodes.has(key)) li.remove();
  }

  if (reduced || !raf) return;

  // FLIP "last / invert / play": the rows are already in their final DOM order,
  // so measure, offset each mover back to where it was, and release next frame.
  for (const key of rankChanges(beforeOrder, afterOrder)) {
    const li = nodes.get(key);
    const was = beforeTop.get(key);
    if (!li || was == null) continue;
    const dy = was - li.offsetTop;
    if (!dy) continue;
    li.style.transition = "none";
    li.style.transform = `translateY(${dy}px)`;
    raf(() => {
      li.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
      li.style.transform = "";
      li.addEventListener(
        "transitionend",
        () => {
          li.style.transition = "";
        },
        { once: true }
      );
    });
  }
}
