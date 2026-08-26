// config.js — public client credentials. Never put secret/server keys here.
// Flag Reveal has its OWN Firebase project (projectId `flagreveal`) — fully
// isolated from GeoParty's `geoparty-9ffe7`. All room data lives under
// `rooms/{CODE}` in this project's RTDB.
//
// NOTE: the `apiKey` below is a PUBLIC client key by design (it ships in the
// browser). It is the real value from the owner-provided firebaseConfig
// (GitHub issue #1 comment, 2026-08-24).
export const firebaseConfig = {
  apiKey: "AIzaSyBHHT1VOIn-ugdUXoNnul5ZfO2nD1rKF3U",
  authDomain: "flagreveal.firebaseapp.com",
  databaseURL: "https://flagreveal-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "flagreveal",
  storageBucket: "flagreveal.firebasestorage.app",
  messagingSenderId: "407784534208",
  appId: "1:407784534208:web:93d45ff96914989cf3bd25"
};

// Scoring defaults (spec §1.7).
export const GAME_DEFAULTS = {
  STEPS: 8,
  BASE: 1000,
  MIN: 100,
  graceMs: 3000,
  stepMs: 1500,
  roundCount: 10,
  target: 0,
  gridN: 4,
  revealAspect: "3:2",
  difficulty: "world",
  inputMode: "typeahead",
  choiceUnlockStep: 5,
  autoAdvanceMs: 15000,
  multiGuess: false
};

// Dataset/rules versions LOCKED into every room at creation (spec §8.1). A phone
// whose bundled versions differ from the room's refuses to derive the flag
// sequence (versionCompatible, flag.js) rather than split the room. Bump these
// whenever data/flags.json or the derivation algorithm changes in a way that
// would change any derived sequence.
export const DATASET_VERSION = "flags-1";
export const RULES_VERSION = "v3.2";
export const BUNDLED_VERSIONS = Object.freeze({
  datasetVersion: DATASET_VERSION,
  rulesVersion: RULES_VERSION
});
