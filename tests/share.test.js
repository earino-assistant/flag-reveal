// tests/share.test.js — the pure share-artifact logic (js/share.js). The party
// brag, the Wordle-style daily grid, the felt-quality buckets, and UTM tagging.
// Privacy: the grid must encode only a bucket per round — never an ISO or a
// country name.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withUtm,
  UTM_SOURCE,
  partyShareText,
  dailyShareText,
  roundEmoji,
  emojiRow,
  shareToastText,
  EMOJI_FAST,
  EMOJI_SLOW,
  EMOJI_MISS,
} from "../js/share.js";

test("withUtm tags source=share and the given campaign", () => {
  const out = withUtm("https://flag.example/player.html", "daily");
  const u = new URL(out);
  assert.equal(u.searchParams.get("utm_source"), UTM_SOURCE);
  assert.equal(u.searchParams.get("utm_campaign"), "daily");
});

test("withUtm preserves an existing query (e.g. ?room=CODE)", () => {
  const out = withUtm("https://flag.example/player.html?room=ABCDEF", "party");
  const u = new URL(out);
  assert.equal(u.searchParams.get("room"), "ABCDEF");
  assert.equal(u.searchParams.get("utm_campaign"), "party");
});

test("partyShareText brags the points and links back", () => {
  const t = partyShareText({ winner: "The Cartographers", points: 4200, url: "URL" });
  assert.match(t, /Flag Reveal/);
  assert.match(t, /The Cartographers hit 4,200 pts/);
  assert.match(t, /beat us: URL/);
});

test("partyShareText without a winner falls back to 'we hit', 0 pts is fine", () => {
  const t = partyShareText({ points: 0, url: "U" });
  assert.match(t, /we hit 0 pts/);
});

test("roundEmoji: fast → green, slow → yellow, missed → red", () => {
  assert.equal(roundEmoji({ correct: true, atStep: 2 }, 8), EMOJI_FAST); // ≤3
  assert.equal(roundEmoji({ correct: true, atStep: 3 }, 8), EMOJI_FAST);
  assert.equal(roundEmoji({ correct: true, atStep: 4 }, 8), EMOJI_SLOW);
  assert.equal(roundEmoji({ correct: true, atStep: 8 }, 8), EMOJI_SLOW);
  assert.equal(roundEmoji({ correct: false }, 8), EMOJI_MISS);
  assert.equal(roundEmoji(null, 8), EMOJI_MISS);
});

test("emojiRow renders one square per round, in order", () => {
  const rounds = [
    { correct: true, atStep: 1 },
    { correct: true, atStep: 6 },
    { correct: false },
    { correct: true, atStep: 2 },
    { correct: false },
  ];
  const row = emojiRow(rounds, 8);
  assert.equal([...row].length, 5);
  assert.equal(row, `${EMOJI_FAST}${EMOJI_SLOW}${EMOJI_MISS}${EMOJI_FAST}${EMOJI_MISS}`);
});

test("dailyShareText: header, grid, link — three lines", () => {
  const t = dailyShareText({
    dayNumber: 12,
    score: 3125,
    rounds: [{ correct: true, atStep: 1 }, { correct: false }],
    url: "URL",
    streak: 4,
  });
  const lines = t.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Flag Reveal Daily #12/);
  assert.match(lines[0], /🔥4/);
  assert.match(lines[0], /3,125 pts/);
  assert.equal(lines[1], `${EMOJI_FAST}${EMOJI_MISS}`);
  assert.equal(lines[2], "Beat me: URL");
});

test("dailyShareText: a 🔥1 is noise → the plain flag flair instead", () => {
  const t = dailyShareText({ dayNumber: 1, score: 0, rounds: [], url: "U", streak: 1 });
  assert.doesNotMatch(t.split("\n")[0], /🔥/);
  assert.match(t.split("\n")[0], /🚩/);
});

test("the daily grid never leaks an ISO or country name", () => {
  const t = dailyShareText({
    dayNumber: 3,
    score: 500,
    rounds: [{ correct: true, atStep: 1, iso2: "fr" }],
    url: "U",
    streak: 0,
  });
  assert.doesNotMatch(t, /\bfr\b|france/i);
});

test("shareToastText is a short copied-confirmation", () => {
  assert.match(shareToastText(), /copied/i);
});
