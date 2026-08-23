// config.js — public client credentials. Never put secret/server keys here.
// Flag Reveal reuses the GeoParty Firebase project (geoparty-9ffe7) — the same
// RTDB project that hosts the reference implementation. All room data lives
// under `rooms/{CODE}`, a sibling namespace to GeoParty's rooms, so the two
// games share one database but never collide on room codes' data.
//
// NOTE: the `apiKey` below is a PUBLIC client key by design (it ships in the
// browser; GeoParty's CLAUDE.md calls this out). It is filled from the live
// GeoParty config at `/opt/data/geoparty/config.js` — the single source of
// truth for the shared project credentials. If this file shows a placeholder,
// the builder must copy the real value from that file.
export const firebaseConfig = {
  apiKey: "AIzaSyANUJd0cu8J3JnNgrpPcR5Z0txoI1u_r4I",
  authDomain: "geoparty-9ffe7.firebaseapp.com",
  databaseURL: "https://geoparty-9ffe7-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "geoparty-9ffe7",
  storageBucket: "geoparty-9ffe7.firebasestorage.app",
  messagingSenderId: "645603439629",
  appId: "1:645603439629:web:ab332148756bc8b848d144"
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
  autoAdvanceMs: 15000
};

// Dataset/rules versions LOCKED into every room at creation (spec §8.1). A phone
// whose bundled versions differ from the room's refuses to derive the flag
// sequence (versionCompatible, flag.js) rather than split the room. Bump these
// whenever data/flags.json or the derivation algorithm changes in a way that
// would change any derived sequence.
export const DATASET_VERSION = "flags-1";
export const RULES_VERSION = "v3.1";
export const BUNDLED_VERSIONS = Object.freeze({
  datasetVersion: DATASET_VERSION,
  rulesVersion: RULES_VERSION
});
