# Flag Reveal — project rules for agents

Static, no-build Jackbox-style flag-guessing party game (GitHub Pages). Plain
ES modules, no framework, no bundler, no runtime dependencies. Pure logic lives
in `js/flag.js` (no DOM, no network — the unit-tested layer); DOM/Firebase glue
lives in `js/flag-ui.js`, `js/screen-flag.js`, and `js/consent.js`. This is a
reference implementation of the GeoParty sync kernel; the concurrency rules in
`docs/architecture.md` and `SPEC-v3.1.md` are normative.

The authoritative design is `/opt/data/flag-reveal/SPEC-v3.1.md` — read it
before implementing. The reference architecture (GeoParty, the game this one
reuses as a kernel) is `/opt/data/geoparty/docs/architecture.md`.

## The arbitration primitive (do not regress)

The whole point of this game is a first-class contended-write primitive that
GeoParty lacks. It is **epoch-guarded terminal-state arbitration over a small
authoritative subtree** (`gameState`). Rules:

- **Every phase-changing write is an `epoch-guarded transaction`** over
  `rooms/{CODE}/gameState`. There are exactly three transactional writes:
  `claimTeamSlot`, `resolveRound` (roundActive → reveal; win OR bust), and
  `advanceRound` (lobby/reveal → roundActive/gameOver). No phase-changing write
  is a bare `update()`.
- `resolveRound` commits `{kind:"win", team, atStep}` or `{kind:"bust"}`
  **only when** `phase === "roundActive"`, `round.number === myRound`, and
  `outcome == null` (absent key). Whichever terminal outcome serializes first
  wins; stale/duplicate ops abort.
- **`applyLocally: false` is mandatory** on `resolveRound` and `advanceRound`
  (prevents the mid-round `private/*` disclosure leak and false-win flash).
- `atStep` is read from the **server transaction snapshot's `currentStep`**,
  never a client-supplied stale value.
- Clocks: use `.info/serverTimeOffset` (subscribe, don't read once); timestamps
  written inside transactions are writer offset-estimates, not true server
  stamps.
- Guards test `outcome == null` (RTDB stores no nulls; unresolved is an absent
  key), never `=== null`.
- The TV never runs a transaction, never flips a phase, never advances — it
  writes only `screenHeartbeat`.

## MANDATORY: every feature ships with tests AND instrumentation

Same contract as GeoParty. Decision logic goes in `js/flag.js` (pure, tested);
DOM/Firebase glue stays thin. Every feature adds `tests/*.test.js` (Node's
built-in runner, `npm test`) and the whole repo must pass `npm run check`
(every JS file `node --check`).

## MANDATORY: the analytics schema

- `EVENT_SCHEMA` lives in `js/analytics.js` and is a hard allowlist; an
  uninstrumented `track()` is silently dropped.
- Aggregates only: `atStep`, `correct`, `points`, `contested`, `outcome`,
  `winningStep`, `ringCount`, `mode`, `roundNumber`, `roundKey`, `team` (slot
  id `tN`). NEVER country names, ISO codes as free strings, team names, or
  anything identifying.
- `flag_ring` (one per ring): `{team, roundKey, mode, atStep, correct, points,
  contested}`. Dedup on `(roundKey, team, correct)`. `flag_round` (one per
  round, single named emitter — at-most-once emission, NOT exactly-once):
  `{mode, outcome, winningStep, ringCount, roundNumber, difficulty, inputMode,
  roundKey}`.
- Sanitizer tests in `tests/analytics.test.js`; document events in
  `docs/analytics.md`.
- Consent gating is inviolable: all capture through `track()`/`trackError()` in
  `js/consent.js`; never reference PostHog directly; never capture pre-opt-in.

## MANDATORY: session-replay masking

Any screen rendering a team name or room code needs `data-ph-mask`. Update
`docs/replay-mask-checklist.md` in the same change.

## Other constraints

- No build step, no npm dependencies, no server-side code. Everything must work
  served as static files (and degrade gracefully **offline once served/
  cached**).
- Flags are **vendored** into `assets/flags/*.svg` (never hot-linked from a
  CDN). Dataset in `data/flags.json`; licensing in `data/ATTRIBUTION.md`.
- The Firebase project is shared with GeoParty (`geoparty-9ffe7`). Public
  client keys live in `config.js` by design; never add secret/server keys.
