// tests/qr.test.js — the embedded QR encoder (js/qr.js, copied verbatim from
// GeoParty's kernel). We test only the pure qrEncode; drawQr needs a canvas.
// A join URL (player.html?room=CODE / screen.html?room=CODE&via=qr) must fit
// inside the supported versions (1–5, EC level L, ~106 bytes).

import { test } from "node:test";
import assert from "node:assert/strict";

import { qrEncode } from "../js/qr.js";

test("encodes a player join URL to a square 0/1 matrix", () => {
  const m = qrEncode("https://earino-assistant.github.io/flag-reveal/player.html?room=ABCDEF");
  assert.ok(Array.isArray(m), "a fitting URL must encode");
  const n = m.length;
  assert.ok(n >= 21 && n <= 37, `size ${n} must be a v1–v5 module count`);
  for (const row of m) {
    assert.equal(row.length, n, "matrix must be square");
    for (const v of row) assert.ok(v === 0 || v === 1, "cells are 0/1");
  }
});

test("encodes the TV join URL with a via=qr tag", () => {
  const m = qrEncode("https://earino-assistant.github.io/flag-reveal/screen.html?room=ABCDEF&via=qr");
  assert.ok(Array.isArray(m));
});

test("the finder patterns are stamped in all three corners", () => {
  const m = qrEncode("player.html?room=ABCDEF");
  const n = m.length;
  // A finder's outer ring is dark; its (0,0), top-right, bottom-left corners.
  assert.equal(m[0][0], 1);
  assert.equal(m[0][n - 1], 1);
  assert.equal(m[n - 1][0], 1);
});

test("a too-long string returns null (over the v5 data budget)", () => {
  assert.equal(qrEncode("x".repeat(200)), null);
});

test("encoding is deterministic (same text → identical matrix)", () => {
  const a = qrEncode("player.html?room=WXYZ12");
  const b = qrEncode("player.html?room=WXYZ12");
  assert.deepEqual(a, b);
});
