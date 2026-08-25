// tests/analytics.test.js — the sanitizer + consent gate for Flag Reveal
// analytics. SPEC §12/§13, CLAUDE.md: aggregates only; never country names, ISO
// codes as free strings, team names, room codes, or free-text guesses. Slot ids
// (tN) ARE permitted. Consent gating is inviolable — nothing captures, and
// PostHog is never loaded, before an explicit accept.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_SCHEMA,
  sanitizeProps,
  sanitizeEvent,
  scrubUrl,
  sanitizeBeforeSend,
  createAnalytics,
  getConsent,
  setConsent,
  CONSENT_ACCEPTED,
  CONSENT_DECLINED,
  POSTHOG_PROJECT_KEY,
  POSTHOG_INIT_OPTIONS,
} from "../js/analytics.js";

// The shared GeoParty project key — Flag Reveal must NOT send analytics here.
const GEOPARTY_PROJECT_KEY = "phc_Au8ogwiWbfcWqhbP6iE8ayyT5JSQtambPHFSffykdvkE";

// A localStorage-shaped stub.
function fakeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("PostHog points at Flag Reveal's own project, not shared GeoParty", () => {
  assert.equal(
    POSTHOG_PROJECT_KEY,
    "phc_tjYdfjtT6Ve8ywyLe8jrJBpzzxsyCTit6p3KXspbqvEG",
    "must be the Flag Reveal project key"
  );
  assert.notEqual(
    POSTHOG_PROJECT_KEY,
    GEOPARTY_PROJECT_KEY,
    "must not revert to the shared GeoParty project key"
  );
  assert.equal(
    POSTHOG_INIT_OPTIONS.api_host,
    "https://eu.i.posthog.com",
    "must stay on the EU instance"
  );
});

// ---------------------------------------------------------------------------
// URL privacy backstop (scrubUrl / sanitizeBeforeSend / URL_PROPS). These are
// the last line of defense against a route-identifying URL riding on a captured
// event — room codes/day numbers/ids in the path or query must never leave the
// device. before_send wires sanitizeBeforeSend into every outgoing event.
// ---------------------------------------------------------------------------

test("scrubUrl: drops the query string and the fragment", () => {
  assert.equal(
    scrubUrl("https://x.github.io/flag-reveal/player.html?room=ABCDEF"),
    "https://x.github.io/flag-reveal/player.html"
  );
  assert.equal(
    scrubUrl("https://x.github.io/daily.html#day=42"),
    "https://x.github.io/daily.html"
  );
  assert.equal(
    scrubUrl("https://x.github.io/p.html?room=ABCDEF#qr"),
    "https://x.github.io/p.html"
  );
});

test("scrubUrl: collapses long digit runs (ids) in the surviving path", () => {
  assert.equal(
    scrubUrl("https://x.github.io/game/1998273/reveal"),
    "https://x.github.io/game/…/reveal"
  );
  // Runs of <4 digits are left alone (not id-shaped).
  assert.equal(scrubUrl("https://x.github.io/r3/step"), "https://x.github.io/r3/step");
});

test("scrubUrl: passes non-strings straight through", () => {
  assert.equal(scrubUrl(undefined), undefined);
  assert.equal(scrubUrl(null), null);
  assert.equal(scrubUrl(42), 42);
});

test("sanitizeBeforeSend: scrubs every URL-shaped property", () => {
  const event = {
    event: "$pageview",
    properties: {
      $current_url: "https://x.github.io/player.html?room=ABCDEF",
      $pathname: "/game/1998273",
      $referrer: "https://x.github.io/index.html#day=42",
      $initial_current_url: "https://x.github.io/p.html?room=ZZZZZZ",
      $session_entry_url: "https://x.github.io/daily.html?d=5",
      mode: "phone", // a non-URL prop is untouched
    },
  };
  const out = sanitizeBeforeSend(event);
  assert.equal(out.properties.$current_url, "https://x.github.io/player.html");
  assert.equal(out.properties.$pathname, "/game/…");
  assert.equal(out.properties.$referrer, "https://x.github.io/index.html");
  assert.equal(out.properties.$initial_current_url, "https://x.github.io/p.html");
  assert.equal(out.properties.$session_entry_url, "https://x.github.io/daily.html");
  assert.equal(out.properties.mode, "phone");
});

test("sanitizeBeforeSend: never returns null and tolerates a propertiless event", () => {
  // Dropping is the schema's job (sanitizeEvent), never before_send's — a null
  // here would silently drop EVERY event.
  const bare = { event: "$pageview" };
  assert.equal(sanitizeBeforeSend(bare), bare);
  assert.equal(sanitizeBeforeSend(null), null);
});

test("sanitizeBeforeSend: leaves a non-string URL prop untouched", () => {
  const event = { event: "x", properties: { $current_url: 12345 } };
  const out = sanitizeBeforeSend(event);
  assert.equal(out.properties.$current_url, 12345);
});

test("POSTHOG_INIT_OPTIONS wires sanitizeBeforeSend as before_send", () => {
  assert.equal(POSTHOG_INIT_OPTIONS.before_send, sanitizeBeforeSend);
});

test("the two flag events exist with the expected shape", () => {
  assert.ok(EVENT_SCHEMA.flag_ring, "flag_ring must be in the schema");
  assert.ok(EVENT_SCHEMA.flag_round, "flag_round must be in the schema");
  // team is a slot id (the v3.1 dedup key must distinguish players).
  assert.equal(EVENT_SCHEMA.flag_ring.team, "string");
  assert.equal(EVENT_SCHEMA.flag_ring.roundKey, "string");
  assert.equal(EVENT_SCHEMA.flag_ring.contested, "bool");
  assert.equal(EVENT_SCHEMA.flag_round.outcome, "string");
  // guessMode rides both events (First correct wins vs Multiple guesses).
  assert.equal(EVENT_SCHEMA.flag_ring.guessMode, "string");
  assert.equal(EVENT_SCHEMA.flag_round.guessMode, "string");
});

test("guessMode survives the sanitizer as a plain allowlisted dimension", () => {
  const ring = sanitizeProps(EVENT_SCHEMA.flag_ring, {
    mode: "phone",
    team: "t1",
    atStep: 2,
    correct: false,
    points: 0,
    contested: false,
    difficulty: "world",
    inputMode: "choice",
    guessMode: "multi",
    roundKey: "1998273",
  });
  assert.equal(ring.guessMode, "multi");
  const round = sanitizeProps(EVENT_SCHEMA.flag_round, {
    mode: "phone",
    outcome: "won",
    winningStep: 2,
    ringCount: 1,
    difficulty: "world",
    inputMode: "choice",
    guessMode: "single",
    roundNumber: 4,
    roundKey: "1998273",
  });
  assert.equal(round.guessMode, "single");
});

test("flag_ring keeps a bare tN slot id in team, not a team name", () => {
  const clean = sanitizeProps(EVENT_SCHEMA.flag_ring, {
    mode: "phone",
    team: "t2",
    atStep: 3,
    correct: true,
    points: 750,
    contested: false,
    difficulty: "world",
    inputMode: "typeahead",
    roundKey: "1998273",
  });
  assert.equal(clean.team, "t2");
  assert.equal(clean.atStep, 3);
  assert.equal(clean.correct, true);
  assert.equal(clean.points, 750);
});

test("an unknown event is dropped (null)", () => {
  assert.equal(sanitizeEvent("totally_made_up", { x: 1 }), null);
});

test("the new v0.2 events exist (daily + share)", () => {
  for (const e of ["daily_started", "daily_completed", "share_daily", "share_party"]) {
    assert.ok(EVENT_SCHEMA[e], `${e} must be in the schema`);
  }
  assert.equal(EVENT_SCHEMA.share_daily.dayNumber, "int");
  assert.equal(EVENT_SCHEMA.share_party.points, "int");
});

test("share_daily keeps aggregates, never the emoji grid / a country name", () => {
  const clean = sanitizeProps(EVENT_SCHEMA.share_daily, {
    dayNumber: 12,
    score: 3125,
    rounds: 4,
    streak: 3,
    method: "copy",
    // hostile extras a careless caller might pass:
    grid: "🟩🟨🟥",
    countryName: "France",
    answerIso: "fr",
  });
  assert.deepEqual(clean, {
    dayNumber: 12,
    score: 3125,
    rounds: 4,
    streak: 3,
    method: "copy",
  });
  assert.ok(!("grid" in clean) && !("countryName" in clean) && !("answerIso" in clean));
});

test("share_party carries only mode/points/method", () => {
  const clean = sanitizeProps(EVENT_SCHEMA.share_party, {
    mode: "phone",
    points: 4200,
    method: "share",
    winner: "The Cartographers",
  });
  assert.deepEqual(clean, { mode: "phone", points: 4200, method: "share" });
});

test("game_over exists and keeps only aggregates, no identifiers", () => {
  assert.ok(EVENT_SCHEMA.game_over, "game_over must be in the schema");
  assert.equal(EVENT_SCHEMA.game_over.roundsPlayed, "int");
  assert.equal(EVENT_SCHEMA.game_over.teamCount, "int");
  const clean = sanitizeProps(EVENT_SCHEMA.game_over, {
    mode: "phone",
    roundsPlayed: 8,
    teamCount: 3,
    difficulty: "expert",
    inputMode: "choice",
    // hostile extras a careless caller might pass:
    winnerName: "The Cartographers",
    roomCode: "ABCDEF",
    answerIso: "fr",
  });
  assert.deepEqual(clean, {
    mode: "phone",
    roundsPlayed: 8,
    teamCount: 3,
    difficulty: "expert",
    inputMode: "choice",
  });
  assert.ok(!("winnerName" in clean) && !("roomCode" in clean) && !("answerIso" in clean));
});

test("screen_joined accepts via=qr", () => {
  const clean = sanitizeProps(EVENT_SCHEMA.screen_joined, { mode: "tv", via: "qr" });
  assert.equal(clean.via, "qr");
});

test("no coordinate / ISO / country / name / room / guess / answer keys survive", () => {
  // Even if a caller stuffs a payload with forbidden keys, only allowlisted
  // aggregate properties survive. We add the forbidden keys to a schema-shaped
  // object so the test proves the BANNED_KEY_RE sweep, not just allowlisting.
  const hostileSchema = {
    ...EVENT_SCHEMA.flag_ring,
    lat: "float1",
    lng: "float1",
    coord: "string",
    countryName: "string",
    teamName: "string",
    roomCode: "string",
    iso2: "string",
    answerIso: "string",
    theGuess: "string",
    deviceId: "string",
  };
  const clean = sanitizeProps(hostileSchema, {
    team: "t1",
    atStep: 5,
    correct: false,
    points: 0,
    contested: false,
    mode: "tv",
    difficulty: "expert",
    inputMode: "choice",
    roundKey: "42",
    lat: 51.5,
    lng: -0.12,
    coord: "51.5,-0.12",
    countryName: "France",
    teamName: "The Winners",
    roomCode: "ABCDEF",
    iso2: "fr",
    answerIso: "fr",
    theGuess: "brazil",
    deviceId: "d-123",
  });
  for (const banned of [
    "lat",
    "lng",
    "coord",
    "countryName",
    "teamName",
    "roomCode",
    "iso2",
    "answerIso",
    "theGuess",
    "deviceId",
  ]) {
    assert.ok(!(banned in clean), `banned key "${banned}" must not survive`);
  }
  // ...while the legitimate aggregates do.
  assert.equal(clean.team, "t1");
  assert.equal(clean.roundKey, "42");
});

test("winningStep:null (a bust) is dropped, not coerced", () => {
  const clean = sanitizeProps(EVENT_SCHEMA.flag_round, {
    mode: "phone",
    outcome: "busted",
    winningStep: null,
    ringCount: 2,
    difficulty: "world",
    inputMode: "typeahead",
    roundNumber: 4,
    roundKey: "99",
  });
  assert.ok(!("winningStep" in clean), "null winningStep must be dropped");
  assert.equal(clean.outcome, "busted");
  assert.equal(clean.ringCount, 2);
});

test("types: strings >40 chars drop; bools are strict; ints round", () => {
  const clean = sanitizeProps(
    { s: "string", b: "bool", n: "int", f: "float1" },
    { s: "x".repeat(41), b: "true", n: 3.7, f: 2.345 }
  );
  assert.ok(!("s" in clean), "over-long string dropped");
  assert.ok(!("b" in clean), "non-boolean not coerced");
  assert.equal(clean.n, 4);
  assert.equal(clean.f, 2.3);
});

test("consent round-trips and rejects garbage", () => {
  const s = fakeStorage();
  assert.equal(getConsent(s), null);
  setConsent(s, CONSENT_ACCEPTED);
  assert.equal(getConsent(s), CONSENT_ACCEPTED);
  const tampered = fakeStorage({ flagreveal_analytics_consent: "maybe" });
  assert.equal(getConsent(tampered), null);
});

test("no capture, and PostHog is never loaded, before an explicit accept", async () => {
  let loads = 0;
  const analytics = createAnalytics({
    storage: fakeStorage(),
    loadPosthog: async () => {
      loads++;
      return { capture() {} };
    },
  });
  assert.equal(analytics.track("flag_ring", { team: "t1" }), false);
  // Give any (erroneous) async load a chance to run.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads, 0, "loadPosthog must not run before consent");
});

test("after accept, events load PostHog and capture through the gate", async () => {
  const captured = [];
  const posthog = {
    capture: (e, p) => captured.push([e, p]),
    opt_in_capturing() {},
    opt_out_capturing() {},
  };
  const analytics = createAnalytics({
    storage: fakeStorage(),
    loadPosthog: async () => posthog,
  });
  await analytics.accept(); // records consent_given
  const ok = analytics.track("flag_round", {
    mode: "phone",
    outcome: "won",
    winningStep: 3,
    ringCount: 1,
    difficulty: "world",
    inputMode: "typeahead",
    roundNumber: 1,
    roundKey: "7",
  });
  assert.equal(ok, true);
  const names = captured.map((c) => c[0]);
  assert.ok(names.includes("consent_given"));
  assert.ok(names.includes("flag_round"));
  const round = captured.find((c) => c[0] === "flag_round")[1];
  assert.equal(round.outcome, "won");
  assert.equal(round.winningStep, 3);
});

test("a declined session never captures", async () => {
  let loads = 0;
  const analytics = createAnalytics({
    storage: fakeStorage({ flagreveal_analytics_consent: CONSENT_DECLINED }),
    loadPosthog: async () => {
      loads++;
      return { capture() {} };
    },
  });
  assert.equal(analytics.track("flag_ring", { team: "t1" }), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads, 0);
});
