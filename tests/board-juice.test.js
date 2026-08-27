// tests/board-juice.test.js — the pure core of the scoreboard animation layer
// (js/board-juice.js): which rows changed rank (drives the FLIP) and the
// count-up easing / progress math. The DOM side (reconcileBoard, animateCount)
// is thin glue and is not exercised here — there is no browser in `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankChanges,
  easeOutCubic,
  countUpProgress,
  countUpValue,
  COUNT_UP_MS,
} from "../js/board-juice.js";

// ---------------------------------------------------------------------------
// rankChanges
// ---------------------------------------------------------------------------

test("no reorder means nothing moved", () => {
  assert.deepEqual(rankChanges(["t1", "t2", "t3"], ["t1", "t2", "t3"]), []);
});

test("a two-row swap reports both rows, in the new display order", () => {
  assert.deepEqual(rankChanges(["t1", "t2"], ["t2", "t1"]), ["t2", "t1"]);
});

test("a row overtaking from last to first moves everyone it passed", () => {
  assert.deepEqual(rankChanges(["t1", "t2", "t3"], ["t3", "t1", "t2"]), [
    "t3",
    "t1",
    "t2",
  ]);
});

test("rows that did not change index are not reported", () => {
  // t1 stays on top; only t2 and t3 trade places below it.
  assert.deepEqual(rankChanges(["t1", "t2", "t3"], ["t1", "t3", "t2"]), ["t3", "t2"]);
});

test("a newly joined team is not a 'move' — it has no before position", () => {
  assert.deepEqual(rankChanges(["t1"], ["t1", "t2"]), []);
  // ...but a joiner that lands ABOVE an existing row does move that row.
  assert.deepEqual(rankChanges(["t1"], ["t2", "t1"]), ["t1"]);
});

test("a departed team drops out without being reported", () => {
  assert.deepEqual(rankChanges(["t1", "t2", "t3"], ["t1", "t3"]), ["t3"]);
  assert.deepEqual(rankChanges(["t1", "t2"], []), []);
});

test("rankChanges tolerates empty / missing orderings", () => {
  assert.deepEqual(rankChanges([], []), []);
  assert.deepEqual(rankChanges(undefined, undefined), []);
  assert.deepEqual(rankChanges(null, ["t1"]), []);
  assert.deepEqual(rankChanges(["t1"], null), []);
});

test("rankChanges mutates neither ordering", () => {
  const before = ["t1", "t2", "t3"];
  const after = ["t3", "t2", "t1"];
  rankChanges(before, after);
  assert.deepEqual(before, ["t1", "t2", "t3"]);
  assert.deepEqual(after, ["t3", "t2", "t1"]);
});

// ---------------------------------------------------------------------------
// easeOutCubic
// ---------------------------------------------------------------------------

test("easeOutCubic runs 0 → 1 and is clamped at both ends", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-3), 0);
  assert.equal(easeOutCubic(4.2), 1);
});

test("easeOutCubic is monotonic and front-loaded (it eases OUT)", () => {
  let last = -1;
  for (let i = 0; i <= 20; i++) {
    const v = easeOutCubic(i / 20);
    assert.ok(v >= last, `not monotonic at ${i / 20}`);
    last = v;
  }
  // Half the time is well over half the distance — the number sprints, then
  // settles, which is what makes a count-up feel like a count-up.
  assert.ok(easeOutCubic(0.5) > 0.8);
});

// ---------------------------------------------------------------------------
// countUpProgress
// ---------------------------------------------------------------------------

test("countUpProgress is elapsed/duration, clamped to 0..1", () => {
  assert.equal(countUpProgress(0, 400), 0);
  assert.equal(countUpProgress(100, 400), 0.25);
  assert.equal(countUpProgress(400, 400), 1);
  // A dropped frame that overshoots the duration still lands exactly on 1.
  assert.equal(countUpProgress(9000, 400), 1);
  // A negative delta (a clock oddity between rAF timestamps) reads as "not
  // started", never as a negative progress.
  assert.equal(countUpProgress(-50, 400), 0);
});

test("a zero or absent duration is immediately complete", () => {
  // This is the reduced-motion / instant path: no frames, straight to the end.
  assert.equal(countUpProgress(0, 0), 1);
  assert.equal(countUpProgress(10, -1), 1);
  assert.equal(countUpProgress(10, undefined), 1);
  assert.equal(countUpProgress(10, NaN), 1);
});

// ---------------------------------------------------------------------------
// countUpValue
// ---------------------------------------------------------------------------

test("countUpValue is exact at both ends", () => {
  assert.equal(countUpValue(40, 100, 0), 40);
  assert.equal(countUpValue(40, 100, 1), 100);
  // Clamped: an overshoot never renders past the true total.
  assert.equal(countUpValue(40, 100, 3), 100);
  assert.equal(countUpValue(40, 100, -1), 40);
});

test("countUpValue returns whole points and never overshoots the target", () => {
  for (let i = 0; i <= 20; i++) {
    const v = countUpValue(40, 100, i / 20);
    assert.ok(Number.isInteger(v), `non-integer score ${v}`);
    assert.ok(v >= 40 && v <= 100, `out of range ${v}`);
  }
});

test("countUpValue is monotonic on the way up", () => {
  let last = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const v = countUpValue(0, 250, i / 40);
    assert.ok(v >= last, `not monotonic at ${i / 40}`);
    last = v;
  }
});

test("countUpValue counts DOWN too (a score correction / fresh game)", () => {
  assert.equal(countUpValue(100, 40, 0), 100);
  assert.equal(countUpValue(100, 40, 1), 40);
  assert.ok(countUpValue(100, 40, 0.5) < 100);
  assert.ok(countUpValue(100, 40, 0.5) > 40);
});

test("an unchanged total is a no-op at every progress", () => {
  for (const p of [0, 0.3, 0.99, 1]) assert.equal(countUpValue(60, 60, p), 60);
});

test("the count-up duration matches the brief's ~400ms", () => {
  assert.equal(COUNT_UP_MS, 400);
});
