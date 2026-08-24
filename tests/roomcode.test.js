// tests/roomcode.test.js — unit tests for the pure helpers in js/roomcode.js.
// (makeRoomCode/deviceId use Math.random/localStorage and aren't pure; the pure
// surface tested here is isValidRoomCode and screenQuery.)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isValidRoomCode,
  makeRoomCode,
  isRoomStale,
  ROOM_TTL_MS,
  screenQuery,
  TV_VIAS,
  emitsScreenJoined,
} from "../js/roomcode.js";

test("isValidRoomCode: six letters, no I/O, case-insensitive", () => {
  assert.equal(isValidRoomCode("ABCDEF"), true);
  assert.equal(isValidRoomCode("abcdef"), true);
  assert.equal(isValidRoomCode("ABCDEI"), false); // I banned
  assert.equal(isValidRoomCode("ABCDEO"), false); // O banned
  assert.equal(isValidRoomCode("ABCDE"), false); // too short
  assert.equal(isValidRoomCode(null), false);
});

// makeRoomCode — every minted code must pass isValidRoomCode. Guards against an
// alphabet regression that re-adds I/O or digits (P2). 5000 samples makes a
// single bad character in a 24-letter alphabet a near-certain catch.
test("makeRoomCode: always mints a valid code (no I/O/digit regression)", () => {
  for (let i = 0; i < 5000; i++) {
    const code = makeRoomCode();
    assert.equal(code.length, 6);
    assert.ok(
      isValidRoomCode(code),
      `makeRoomCode produced an invalid code: ${code}`
    );
  }
});

// isRoomStale — the pure collision decision behind firebase.js `claimRoomCode`
// (P1.3). A live (<24h) room is never stale, so creation never clobbers it; an
// absent / malformed / >24h room is reclaimable.
test("isRoomStale: absent room is claimable (stale)", () => {
  assert.equal(isRoomStale(null, 1_000_000_000_000), true);
  assert.equal(isRoomStale(undefined, 1_000_000_000_000), true);
});

test("isRoomStale: a live room (<24h) is NEVER stale", () => {
  const now = 1_000_000_000_000;
  assert.equal(isRoomStale({ createdAt: now }, now), false);
  assert.equal(isRoomStale({ createdAt: now - 1 }, now), false);
  assert.equal(isRoomStale({ createdAt: now - (ROOM_TTL_MS - 1) }, now), false);
});

test("isRoomStale: a room at/over the 24h TTL is stale", () => {
  const now = 1_000_000_000_000;
  assert.equal(isRoomStale({ createdAt: now - ROOM_TTL_MS }, now), true);
  assert.equal(isRoomStale({ createdAt: now - ROOM_TTL_MS - 1 }, now), true);
});

test("isRoomStale: missing/non-numeric createdAt reads as stale", () => {
  const now = 1_000_000_000_000;
  assert.equal(isRoomStale({}, now), true);
  assert.equal(isRoomStale({ createdAt: "nope" }, now), true);
  assert.equal(isRoomStale({ createdAt: null }, now), true);
});

// screenQuery — the screen-URL query string a refreshed TV rejoins with (F1).
test("screenQuery: code only when no via", () => {
  assert.equal(screenQuery("BCDFGH"), "?room=BCDFGH");
  assert.equal(screenQuery("BCDFGH", null), "?room=BCDFGH");
});

test("screenQuery: propagates qr and link via tags", () => {
  assert.equal(screenQuery("BCDFGH", "qr"), "?room=BCDFGH&via=qr");
  assert.equal(screenQuery("BCDFGH", "link"), "?room=BCDFGH&via=link");
});

test("screenQuery: does NOT propagate typed/follow/garbage via", () => {
  // A refreshed follow re-attributes as a link-style rejoin (mirrors GeoParty).
  assert.equal(screenQuery("BCDFGH", "typed"), "?room=BCDFGH");
  assert.equal(screenQuery("BCDFGH", "follow"), "?room=BCDFGH");
  assert.equal(screenQuery("BCDFGH", "javascript:alert(1)"), "?room=BCDFGH");
});

test("screenQuery: output always begins ?room=", () => {
  for (const via of [undefined, "qr", "link", "typed", "x"]) {
    assert.ok(screenQuery("BCDFGH", via).startsWith("?room="));
  }
});

test("TV_VIAS: exactly the propagatable tags", () => {
  assert.deepEqual([...TV_VIAS].sort(), ["link", "qr"]);
});

// emitsScreenJoined — the follow-exclusion rule for the screen_joined attach
// event (P0.1). A `follow` re-connect is the same TV session carrying into the
// next game, not a new attach, so it must NOT be instrumented; every initial
// join path (typed | link | qr) must.
test("emitsScreenJoined: follow is NOT a new attach", () => {
  assert.equal(emitsScreenJoined("follow"), false);
});

test("emitsScreenJoined: typed/link/qr are real attaches", () => {
  assert.equal(emitsScreenJoined("typed"), true);
  assert.equal(emitsScreenJoined("link"), true);
  assert.equal(emitsScreenJoined("qr"), true);
});
