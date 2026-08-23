# FLAG REVEAL — implementation-ready spec (v2)

*Architect/designer deliverable, 2026-08-23. Design-only: no GeoParty repo
changes. Register follows `geoparty/docs/architecture.md` — plain and direct.
This is v2: a revision of `SPEC.md` (v1) incorporating the Fable design review
(APPROVE WITH CHANGES). See "v2 changes" below.*

A flag-guessing party game for a family/group around a TV, each with a phone.
Static no-build GitHub Pages + Firebase RTDB, no server code — the same
constraints, the same pure/glue discipline, and (almost) the same sync kernel as
GeoParty. This document is written so an engineer can implement from it alone,
and it calls out where the first-pass design brief
(`docs/flag-unveil-opus-design.md`) is wrong, blurry, or incomplete.

The headline: Flag Reveal deliberately breaks **two** GeoParty invariants at once
— *zero hidden information* and *writers never contend on the same path* — which
is the whole point of building it. §9 maps exactly where the extraction
hypothesis holds and where it breaks.

---

## v2 changes (what changed from v1, and why)

1. **Epoch-guarded `claimBuzz` updater (correctness bug fix).** A stale claim
   from round N could occupy round N+1's fresh path forever, bricking the round's
   win path. The updater now treats a stale claim as vacant (claim-if-vacant-or-
   stale). Fixes §3 code, §4.5 guard text, §9.2 extraction finding. (Review §1.)
2. **`results/tN` ownership fixed (§2).** `results/*` is entirely flip-writer-
   owned; v1's "written only by team tN's phone" note contradicted §4.3. (Review
   §5.1.)
3. **`rangOut` disclosure ambiguity resolved (§4.3/§1.5/§5.3/§10).** v1 for
   **discloses at reveal**: `settleFlip` reads `private/*` and stamps the wrong-
   ring disclosure. One branch, one signature, one test set. (Review §2/§4.)
4. **`rangOut` identical-bytes divergence acknowledged (§4.3).** `private/*`
   writes can race the flip, so racing flip writers may emit different `rangOut`/
   `wrongIso`/`wrongStep` bytes. Stated as an explicit exception (cosmetic, last-
   write-wins, totals unaffected), not a hard identical-bytes invariant. (Review §1.)
5. **Owner bust anchored to step completion (§1.4/§1.5/§4.4).** The owner busts on
   `currentStep === STEPS` + grace since the final `stepStartedAt`; the wall-clock
   formula is the fallback dead-man deadline for other phones. Stalled-but-alive
   owner behavior stated. (Review §1.)
6. **Game-level flag seed/cursor added (§2/§8).** A room-level `gameSeed` written
   at creation; round k's flag derived deterministically from it, so an owner
   refresh mid-game resumes without resampling and repeats are prevented. Mirrors
   GeoParty's `poolCursor`. (Review §5.2.)
7. **Easy-mode choice options specified (§1.3/§8).** The 4 options are derived
   deterministically from `flagSeed`, identical across every phone for fairness.
   (Review §5.3.)
8. **Store `wrongIso` privately; disclose wrong rings fully at reveal (§2/§4.3/
   §5/§10).** `private/tN` now stores `wrongIso`; `settleFlip` surfaces
   `{rangOut, wrongIso, wrongStep}` into `results/tN` at the flip so the reveal
   plays the full comedy beat with zero strategic leak. Resolves the §10 "identity
   + guess + lockout" vs schema inconsistency. Counter stays OFF for v1. (Review §4.)
9. **Small clarifications.** TV does NOT run `roundConduct` fallbacks (§4.4/§6); a
   dead reveal owner at `phase: reveal` stalls the game — accepted GeoParty h2h
   parity corner (§4.4). (Review §1/§5.5.)

---

## 0. The one clarification the first-pass got blurry — topology vs. mode

The brief talks about "couch mode" and "everyone-plays mode" as if they were two
game topologies. They are not. **Flag Reveal has one topology and two display
modes.**

- **Topology (always):** N players, one per phone. Each player owns a team slot
  `teams/tN` with a `deviceId`, claimed via `claimTeamSlot` — this is GeoParty's
  **h2h topology verbatim**. There is no "single operator phone that passes
  around" (that is GeoParty *couch*, and it does not apply here: a buzzer game
  needs every player holding their own ring-in button). One slot is the
  `hostTeam` — the **reveal owner** — and it rotates to the previous game's
  winner, exactly as h2h `hostTeam` rotates today.

- **Mode = is a TV present?** This is purely a *rendering* question, decided by
  `screenHeartbeat` liveness, and it changes **no authority and no writer**:
  - **Couch-with-TV (PRIMARY).** A TV subscribes to the room and renders the big
    progressive reveal. Phones become lean buzzers (they still *can* render a
    minimal reveal, but eyes are on the TV).
  - **Everyone-plays (FALLBACK, no TV).** Each phone renders its own reveal from
    the identical `currentStep` feed. Same logic, minus the shared screen. Copy
    adapts on `screenHeartbeat` presence — exactly the pattern h2h phones use
    today.

This satisfies owner constraint #1 (TV always connectable, in both modes) *for
free*: the TV connects by subscribing to the room and rendering `currentStep`.
It satisfies #2 (TV is a passive renderer, writes only `screenHeartbeat`)
because the reveal cadence is owned by the `hostTeam` phone, never the TV. It
satisfies #3 (winner-becomes-host) because the reveal owner *is* the `hostTeam`,
which rotates to the winner. The three owner constraints collapse into "reuse
h2h's `hostTeam` model and treat the TV as one more subscriber."

> **Correction to the brief:** §1.12 of the brief frames couch as "host phone is
> the buzz-in surface" and everyone-plays as "each phone renders its own reveal."
> That conflates *who buzzes* (always: everyone, on their own phone) with *who
> renders the reveal* (TV if present, else each phone). Buzzing is always
> per-phone. The only thing the TV's presence changes is the reveal renderer.

---

## 1. Game rules (complete)

### 1.1 Setup and lobby

- A player creates a room (6-letter code, no I/O — reuse GeoParty's generator and
  `isValidRoomCode`). `mode: "flag"`. At creation the creator also writes a
  room-level `gameSeed` (§8) — the deterministic source of the whole game's flag
  sequence.
- Each additional player joins by code and claims a slot via
  `claimTeamSlot(code, tN, {name, deviceId, total:0})`. Up to 4 slots (`t1..t4`,
  matching GeoParty's cap; more is a settings knob but 4 keeps the TV render
  cheap and the transaction contention meaningful).
- Optionally a TV joins by code and just subscribes; it writes only
  `screenHeartbeat`.
- The room creator is the initial `hostTeam` (reveal owner). Thereafter it
  rotates to the previous game's winner (§7).

### 1.2 Round loop (one flag)

1. **Round start.** The reveal owner writes the `round` object atomically:
   `{number, flagSeed, answerIso, startedAt, currentStep: 1, stepStartedAt}`,
   and sets `phase: roundActive`. `answerIso` is embedded at round start so every
   phone self-scores its own guess (same accepted posture as GeoParty's embedded
   `truth`: devtools-peeking is not a threat we carry). `flagSeed` for round k is
   derived deterministically from the room-level `gameSeed` (§8), so an owner
   refresh mid-game re-derives the identical flag rather than resampling.
2. **Progressive reveal.** The flag is revealed across **`STEPS = 8`** steps: a
   tile grid de-occludes *and* a parallel blur→sharp track sharpens. The reveal
   owner advances the step every `stepMs` (default 1500 ms) by writing
   `{currentStep, stepStartedAt}` — one small write per 1.5 s, far under the 4/s
   throttle. **The step number is the clock** (see §1.4).
3. **Ring in.** At any time a player commits a guess (a country) on their phone.
   That commit *is* the ring. Correctness is evaluated locally against the
   embedded `answerIso` (§1.6):
   - **Correct →** attempt the `claimBuzz` transaction (§4). If it commits, this
     player wins the round; the reveal stops and the room flips to `reveal`. If
     it aborts (someone correct already claimed), show "too late — someone rang
     first."
   - **Wrong →** the phone locks *itself* out for the round and writes its
     private lockout (§5). No other phone or the TV learns of it during the round.
     The reveal continues.
4. **Bust.** If the reveal completes (`currentStep === STEPS`) plus a grace window
   (`graceMs = 3000`) elapses with no correct ring, the round **busts**: zero
   points to everyone, flip to `reveal` showing the full flag and the answer
   (§1.5).
5. **Reveal + advance.** `phase: reveal` shows the full flag, the answer, who won
   (or "nobody"), the points awarded, updated standings, and the wrong-ring
   comedy beat (§5.3). Soft auto-advance (S6 machine, reused verbatim) counts down
   to the next round; the reveal owner may hold it (`autoAdvanceAt: null`).

### 1.3 Ring-in mechanics (concrete)

The default commit surface is a **country typeahead/autocomplete that resolves to
a canonical ISO code**, not raw free text and not 1-of-4 multiple choice.

- **Why typeahead-to-ISO, not free text:** correctness becomes an exact ISO
  compare (`committedIso === answerIso`), so no fuzzy string matching sits on the
  win path; aliases/spellings/diacritics are absorbed by the autocomplete index
  (built from `normalizeAnswer`, §1.6), not by a runtime guess-matcher.
- **Why not multiple choice by default:** a 4-option pick makes the round a
  coin-flippy trivia guess and collapses the skill of *recognizing a
  half-revealed flag*. Multiple choice is offered only as an **easy-mode**
  difficulty setting (`inputMode:"choice"`, §8) for young kids.
- **Easy-mode `inputMode:"choice"` — 4 options, identical across phones.** When
  `inputMode === "choice"`, every phone renders the **same 4 options** so no
  player gets an easier set. The options are derived **deterministically from
  `flagSeed`** (never sampled locally): option set =
  `chooseOptions(flagSeed, answerIso, pool) → [iso, iso, iso, iso]` — the correct
  ISO plus 3 distractors drawn from the same difficulty tier by a `flagSeed`-
  seeded shuffle, then the 4 are order-shuffled by `flagSeed` too. Because it is a
  pure function of `flagSeed` (embedded in `round`), every phone and the TV
  compute an identical option list and identical order, and an owner refresh
  reproduces it exactly. Committing an option resolves to its ISO and takes the
  same win/lose path as typeahead (§4.2).
- **Collisions are the point.** Tune `stepMs`/scoring so *correct* rings
  routinely land in the same 1–2 steps (brief §7 sharpening). Typeahead keeps
  commits fast enough that two players who both recognize the flag commit within
  the same step — producing the contested `claimBuzz` the experiment exists to
  test.

The ring is committed the instant the player confirms a selection. The step
recorded (`atStep`) is the `currentStep` value the phone last read from RTDB (see
§1.4 for why that, and not a local timer, is authoritative).

### 1.4 The clock is the step number, authored once

GeoParty's discipline is "all countdowns render from `endsAt − Date.now()` on the
local clock; time is never ticked through Firebase." Flag Reveal keeps the spirit
but sharpens it for scoring:

- **Scoring authority = `currentStep` in RTDB, written by exactly one writer**
  (the reveal owner). Every phone reads the *same* `currentStep` value from the
  feed, so `stepAtRing` is identical across devices regardless of clock skew.
  This is *stronger* than skew-tolerant: the score input is a single-writer
  integer, not a per-device clock reading.
- **Visual interpolation = local clock, cosmetic only.** Between step writes, a
  phone/TV may animate the blur track smoothly using
  `Date.now() − stepStartedAt` for a fluid feel. This never feeds scoring.
- **Owner bust trigger = step completion, not wall-clock.** The reveal owner is
  *also* the cadence writer, and mobile browsers throttle background-tab timers
  aggressively. So the owner must **not** bust on a wall-clock formula (a briefly
  backgrounded owner would stall `currentStep` at, say, 3 and then bust a round
  that was never fully revealed while players could still ring at high-value
  steps). Instead, the owner busts on **step completion**: `currentStep === STEPS`
  *and* `now ≥ stepStartedAt + graceMs` (grace measured from the *final* step's
  `stepStartedAt`). The step integer, not the wall clock, gates the owner's bust.
- **Fallback bust deadline = local clock from the authored `startedAt`.** Every
  *non-owner* phone (the dead-man fallback) computes
  `bustAt = round.startedAt + STEPS·stepMs + 3·graceMs` on its own clock and busts
  only if the owner never did. Skew shifts *when* a fallback bust fires by the
  skew amount, never the outcome (identical-shape flip, §4). The `×3 graceMs` here
  is the same forfeit-sweep-style offset (§4.4) that keeps the owner winning the
  race in the common case.
- **Accepted behavior of a stalled-but-alive owner:** if the owner's tab is
  throttled but its connection is live, steps freeze at a cheap step, rings at
  that step score high (players are not penalized), and — because the owner is
  alive and never reaches `currentStep === STEPS` — the round ends only when a
  correct ring flips it, or when a non-owner's fallback deadline
  (`startedAt + STEPS·stepMs + 3·graceMs`) arrives. This is fine — state it, don't
  defend against it.

> **Residual, accepted:** a ring committed in the sub-`stepMs` window right after
> the owner advanced a step but before this phone received the write scores at
> the *older* (lower) step — up to one step in the ringer's favor. Bounded to ±1
> step of propagation delay, symmetric across players, and far smaller than the
> product's grain. This is the flag-game analog of GeoParty's "skew shifts *when*
> you auto-submit." Documented, not defended against.

### 1.5 Bust

- Trigger (owner): `phase === roundActive`, `round/buzz` is null,
  `currentStep === STEPS`, and `now ≥ stepStartedAt + graceMs` (§1.4).
- Trigger (fallback, any non-owner phone): `phase === roundActive`,
  `round/buzz` is null, and `now ≥ round.startedAt + STEPS·stepMs + 3·graceMs`
  (dead-man deadline; identical-shape flip, §4).
- **The TV never triggers a bust** (it runs no `roundConduct`, §4.4/§6).
- Effect: `phase: reveal`, `round/buzz` stays null, every `results/tN` is
  `{correct:false, points:0, rangOut:<from private?>, wrongIso, wrongStep}`
  (§4.3/§5.3), no team total changes.
- The reveal shows the full flag and the answer so the busted round still *pays
  off as a reveal* (party value: "ohh, it was Chad!"), plus any wrong-ring comedy
  beats disclosed from `private/*` at the flip (§5.3).

### 1.6 Answer normalization

Pure `normalizeAnswer(guess, answerIso, aliases) → bool`, and the same
normalization builds the autocomplete index:

- Fold case, trim, collapse internal whitespace, strip diacritics
  (`"Côte d'Ivoire"` → `"cote divoire"`), drop a leading `"the "`.
- Match against the country's English name **and** its alias list (`"USA"`,
  `"United States"`, `"America"`, `"UK"`, `"Britain"`, `"Burma"`↔`"Myanmar"`,
  `"Holland"`↔`"Netherlands"`, etc.).
- Because the commit surface resolves to an ISO before ringing, the *win-path*
  check is `committedIso === answerIso`. `normalizeAnswer` earns its place (a)
  building the index and (b) supporting an optional typed free-text mode.

### 1.7 Scoring

```
scoreRing(stepAtRing, steps, base, min) =
    max(min, round(base × (steps − stepAtRing + 1) / steps))
```

Defaults: `BASE = 1000`, `MIN = 100`, `STEPS = 8`.

| stepAtRing | points |
|---|---|
| 1 | 1000 |
| 2 | 875 |
| 3 | 750 |
| 4 | 625 |
| 5 | 500 |
| 6 | 375 |
| 7 | 250 |
| 8 | 125 |

Earlier = more; the reveal step *is* the clock, so there is **no
speed-within-step bonus** (that is what keeps scoring clock-skew-immune). `MIN`
is a floor that only binds under non-default configs (e.g. more steps); it exists
so a late-but-correct ring is never worth zero (zero is reserved for busts and
wrong rings).

Wrong ring: **zero, and locked out for the round** — the cost is opportunity, not
a negative score. (See §10 for the private-vs-public decision on wrong rings.)

### 1.8 Win condition

Dual, driven by settings:

- `target > 0`: **first team to reach `target` total** ends the game
  immediately at the reveal that crosses it.
- else (`target === 0`, the default): **highest total after `roundCount` flags**.

`gameWinner(teams, {target, roundNumber, roundCount})` is a **pure, deterministic
fold computed locally on every device** (no write, exactly like h2h `gameWinner`
/ Crown Night). Tie-break, in order: highest total → fewest rounds taken to reach
that total (tracked as `reachedTotalAt`, a per-team round index settled with each
win) → lowest slot id `tN`. Deterministic on identical data → the game-over crown
needs no write.

Defaults: `roundCount = 10`, `target = 0` (highest-after-10). A "race to 5000"
party variant is just `target = 5000, roundCount` high.

### 1.9 Modes (rendering only — restating for completeness)

Both modes run the identical writer set. The reveal owner writes cadence; the TV,
if present, renders it; if absent, each phone renders it. The mode is detected
per device from `screenHeartbeat` liveness (stamped on the *receiver's* own clock
at receipt, ancient-beat-ignored — GeoParty's skew-proof S7 rule, reused
verbatim). See §6.

---

## 2. RTDB data model

Everything lives under `rooms/{CODE}`, composed once by `roomRef()` — unchanged,
still the single choke point for every read/write/subscribe/transaction.

```
rooms/{CODE}
  createdAt          ms epoch (existing rule: ≤ server now + 5 min skew)
  mode               "flag"
  phase              lobby | roundActive | reveal | gameOver
  gameSeed           deterministic game-level seed (whole flag sequence; §8)
  settings           { roundCount, stepMs, gridN, base, min, target,
                       difficulty ("easy"|"world"|"expert"),
                       inputMode ("typeahead"|"choice") }
  hostTeam           tN — reveal owner; rotates to the winner (§7)
  teams/t1..t4       { name, total, deviceId, reachedTotalAt }
  round
    number           1-based
    flagSeed         per-round reveal/option seed, derived from gameSeed+number (§8)
    answerIso        ISO-3166-1 alpha-2, embedded at round start (self-scoring)
    startedAt        ms epoch — authored by the reveal owner (bust-clock anchor)
    currentStep      1..STEPS — SINGLE-WRITER cadence integer (the clock)
    stepStartedAt    ms epoch of the current step (interpolation + owner bust gate)
    buzz             TRANSACTION path — first-CORRECT claim (§4). Absent = unclaimed.
                     { team, atStep, roundNumber, atMs }   atMs = cosmetic only
    results/tN       { correct, stepAtRing, points, rangOut, wrongIso, wrongStep }
                     settled at flip by the FLIP WRITER (§4.3) — never own-phone
    private/tN       { lockedRound, wrongStep, wrongIso }  PRIVATE — never rendered (§5)
    revealAt         countdown target, stamped at the reveal flip (S6, reused)
    autoAdvanceAt    revealAt + 15s; null = the reveal owner held it (S6, reused)
  screenHeartbeat    ms epoch — the ONLY thing the TV writes (unchanged)
  nextRoom           pointer into a FINISHED room → subscribers follow (unchanged)
```

Notes:

- `gameSeed` is written **once at room creation** and never mutated during the
  game. It is the whole game's flag source; round k's `answerIso` and `flagSeed`
  are pure functions of `(gameSeed, number)` (§8), so nothing needs a mutable
  cursor and an owner refresh mid-game re-derives the identical round.
- `round/buzz` sits **inside** `round`, so a round advance (which overwrites
  `round`) resets it to absent by construction. A prior-round claim in flight is
  guarded by an **epoch check inside the `claimBuzz` updater** (`buzz.roundNumber`)
  *and* at settle time (§4/§4.5).
- **Ownership (corrected in v2):** `results/*` is **entirely flip-writer-owned** —
  the flip writer settles *every* team's `results/tN` row from one snapshot
  (§4.3); non-winners never write their own results row. The only **own-phone**
  writes are `private/tN` (on a wrong ring) and `teams/tN` (at claim time, via
  `claimTeamSlot`). `currentStep`/`stepStartedAt` cadence is single-writer (the
  reveal owner). This replaces v1's incorrect "`results/tN` written only by team
  tN's phone" note, which contradicted §4.3.
- Old/other clients ignore unknown paths (additive-path convention, unchanged).

---

## 3. Module seams (pure/glue split preserved)

Mirrors GeoParty's layout: decision logic in a new **pure, tested** module; DOM +
Firebase glue in thin `*-ui.js` files; the transaction helper beside
`claimTeamSlot` in `firebase.js`.

### New pure module — `js/flag.js` (tested, no DOM, no network)

- `gameFlags(gameSeed, roundCount, difficulty, pool) → [iso, …]` and
  `flagForRound(gameSeed, number, …) → { answerIso, flagSeed }`
  Deterministic derivation of the whole game's flag sequence from `gameSeed`
  (repeat-free within a game, easy-first-round guard), so a refresh resumes free.
- `revealPlan(flagSeed, steps, gridN) → { tileOrder:[…], blur:[…] }`
  Deterministic, seeded like `pool.js`: a seeded shuffle of `gridN²` tile indices
  partitioned into `steps` groups, plus a monotonic-decreasing blur schedule
  (default `20px → 0` across `steps`). Pure data; the UI paints pixels.
- `exposedAt(plan, step) → { tiles:number[], blurPx:number }`
  Which tiles are de-occluded and the blur at step `k`. Pure.
- `chooseOptions(flagSeed, answerIso, pool) → [iso, iso, iso, iso]` — easy-mode
  option set (§1.3): correct ISO + 3 same-tier distractors, order-shuffled, all
  by a `flagSeed`-seeded shuffle → identical on every device. Pure.
- `scoreRing(stepAtRing, steps, base, min) → points` (§1.7).
- `normalizeAnswer(guess, answerIso, aliases) → bool` (§1.6); also exposes
  `buildAnswerIndex(dataset) → Map<normalizedName, iso>` for the autocomplete.
- `adjudicateBuzz(currentBuzz, claim) → "won" | "lost"` — pure fold over the
  transaction snapshot (mirrors the `claimBuzz` updater's *epoch-guarded* decision
  so it is unit-testable without Firebase).
- `roundConduct(phase, buzz, round, now, isOwner, cfg) → "continue" | "flip" |
  "bust"` — the reveal owner's and the fallback's decision function (§4.4). Pure;
  `isOwner` selects the step-completion bust (owner) vs. the dead-man deadline
  (fallback).
- `settleFlip(round, teams, buzz, cfg) → { results, totals, hostTeam }` — computes
  the reveal-flip patch from a snapshot (the identical-shape guarantee for totals
  lives here; racing writers call the same pure fn on the same snapshot → same
  totals bytes; the `rangOut`/`wrongIso`/`wrongStep` fields may diverge, §4.3).
- `gameWinner(teams, cfg) → tN | null` and `carryStandings(teams, winnerTeam) →
  {teams, hostTeam}` for game-over → next room (§7).

### New glue

- `js/flag-ui.js` — the player phone: lobby/slot claim, buzzer surface, reveal
  render (used when no TV), reveal-owner cadence loop when this phone *is*
  `hostTeam`, all writes. Logic-light; every rule calls into `flag.js`.
- `js/screen-flag.js` — the TV renderer: subscribes, renders `currentStep` via
  `exposedAt`, standings, winner, crown. Writes only `screenHeartbeat`. **Runs no
  `roundConduct` fallbacks** (owner constraint #2). No authority.

### `js/firebase.js` addition — the arbitration primitive

```js
// First-CORRECT ring wins. The server serializes concurrent transactions, so
// ordering is authoritative and clock-skew-immune. Only a phone that has already
// evaluated its own guess as CORRECT calls this — a wrong ring never touches
// this path (it stays private, §5). Beside claimTeamSlot: the SECOND, and now
// first-class, transactional write.
//
// EPOCH-GUARDED (v2): a stale claim from a prior round (roundNumber mismatch) is
// treated as VACANT and overwritten — otherwise a dying phone's round-N claim
// could occupy round N+1's fresh path forever and brick the win path.
export async function claimBuzz(code, claim) {
  const res = await runTransaction(roomRef(code, "round/buzz"), (cur) => {
    if (cur !== null && cur.roundNumber === claim.roundNumber) return undefined; // live claim exists — abort
    return claim; // vacant OR stale (wrong epoch) → claim it. { team, atStep, roundNumber, atMs }
  });
  return res.committed;
}
```

`roomRef` stays the only path composer; transactions stay the *only* non-`update`
writes. This is `claimTeamSlot` generalized **plus an epoch guard** — same shape,
same `committed` contract, but with a validity predicate inside the updater
(claim-if-vacant-*or*-stale). See §9.2 for why this sharpens the extraction
finding.

### Dataset — new repo only

`data/flags.json` in the **Flag Reveal repo** (never touch GeoParty's `data/`):
`{ iso2, name, aliases:[…], tier:"easy"|"world"|"expert" }[]`. See §8 for source
and the vendored-SVG decision.

---

## 4. Concurrency: the buzzer, the flip, and the fallbacks

This is the new part. §9 is the honest extraction map; this section is the
mechanism.

### 4.1 First-CORRECT-wins, not first-to-act — the key sharpening

The brief (§2) says the transaction claims "first". Sharpen it: **only a correct
ring ever attempts the transaction.** Correctness is evaluated *locally, before*
the claim, against the embedded `answerIso`. Consequences:

- A wrong ring **never contends** on `round/buzz`. It writes only the phone's own
  private lockout (§5). So the single contended path is only ever raced by
  *correct* rings — the arbitration is genuinely "first correct," and the
  contention class is as small and as pure as possible.
- The transaction winner is, by construction, both first *and* correct. No
  server-side correctness check is needed (there is no server) — the same
  self-scoring trust posture as GeoParty's embedded truth.

### 4.2 The claim

1. Player commits ISO `X` at `currentStep = k` (via typeahead, or via a `flagSeed`-
   derived choice option, §1.3).
2. Phone computes `X === answerIso`.
   - **false →** write `round/private/tN = {lockedRound: round.number, wrongStep:
     k, wrongIso: X}`; disable the local buzzer for the round; return. (Round
     continues.)
   - **true →** `claimBuzz(code, {team: tN, atStep: k, roundNumber: round.number,
     atMs: Date.now()})`.
     - `committed === true` → I won. Push the reveal flip (§4.3).
     - `committed === false` → a *live* correct claim already exists; show "too
       late," disable buzzer. (A stale-epoch claim would have been overwritten, so
       this abort means a genuine same-round winner, §3.)

### 4.3 The reveal flip + settlement (identical-shape totals race — reused invariant)

When `round/buzz` becomes non-null with a **matching `roundNumber`** (a correct
claim landed), the room flips to `reveal` and settles scores. This *is* GeoParty's
reveal-flip settlement race, inherited verbatim for the **totals**:

- **Writer:** the reveal owner reacts to the buzz and writes the flip. **Fallback:
  any phone** (not the TV, §6) that observes `round/buzz != null && phase ===
  roundActive && buzz.roundNumber === round.number` pushes the same flip (deadlock
  guard analog, §4.4).
- **Identical shape (totals):** every candidate writer computes the patch from the
  *same* atomic snapshot via `settleFlip(round, teams, buzz, cfg)`:
  ```
  phase: "reveal"
  round/results/{winner}: { correct:true, stepAtRing: buzz.atStep,
                            points: scoreRing(buzz.atStep, …), rangOut:false }
  round/results/{other}:  { correct:false, points:0,
                            rangOut:   <from private/{other}?>,
                            wrongIso:  <from private/{other}?>,
                            wrongStep: <from private/{other}?> }
  teams/{winner}/total:   <prior total + points>   (ABSOLUTE, like SUPER SURE)
  teams/{winner}/reachedTotalAt: round.number       (for tie-break)
  round/revealAt, round/autoAdvanceAt               (S6, reused)
  ```
  Because `settleFlip` is a pure fn of the snapshot, racing writers emit identical
  **totals** → the double-count collision is harmless, exactly as the SUPER SURE
  settlement extended the reveal-flip exception. `total` is **absolute**
  (recomputed from the snapshot's prior total), never a relative increment, so a
  double-applied flip cannot double-count.

> **Divergence exception, stated plainly (v2):** the `rangOut`/`wrongIso`/
> `wrongStep` fields are read from `round/private/*`, and `private/tN` writes can
> **race the flip** (T3 rings wrong in the same instant T1's claim commits). The
> winner's flip snapshot may predate `private/t3`; a fallback writer's snapshot
> may include it. So two racing flip writers may emit **different** wrong-ring
> disclosure bytes for `other` rows. This is **not** covered by the identical-
> shape invariant — and that's fine: the divergence is **cosmetic** (a post-round
> comedy label), resolves **last-write-wins**, and **never affects totals,
> standings, the winner, or the phase transition** (those are all computed from
> `round`/`teams`/`buzz`, never from `private/*`). The v1 spec's blanket "racing
> writers emit identical bytes" claim is therefore scoped in v2: **identical for
> the settlement (totals + winner + phase); best-effort last-write-wins for the
> wrong-ring disclosure.**

### 4.4 The fallbacks (deadlock + bust) — `roundConduct`

The reveal owner is the sole cadence writer, so if its phone dies mid-round the
round would hang. Same failure mode GeoParty's lock-in deadlock had; same style
of guard. **Every phone** (never the TV, §6) runs `roundConduct` on each state
change:

- `phase === roundActive` and `round/buzz != null` with `buzz.roundNumber ===
  round.number` → `"flip"` (someone rang; push §4.3 if not already flipped). Once
  per round, duplicates harmless. (A stale-epoch `buzz` is ignored here and was
  already overwritten by the next live claim, §3/§4.5.)
- `phase === roundActive` and `buzz` null → `"bust"` when the writer's bust
  condition holds (§1.4/§1.5):
  - **owner:** `currentStep === STEPS` and `now ≥ stepStartedAt + graceMs`
    (step-completion gate — immune to the owner's own cadence drift).
  - **non-owner fallback:** `now ≥ startedAt + STEPS·stepMs + 3·graceMs` (dead-man
    deadline, local clock). The `×3 graceMs` offset (mirrors the forfeit-sweep's
    `×3`) means the owner almost always wins the race; the flip is identical-shape
    (totals) regardless.
- else → `"continue"`.

The bust flip is also identical-shape for totals (`settleFlip` with `buzz === null`
→ all zeros), so the owner-vs-fallback race is harmless; the wrong-ring disclosure
divergence exception (§4.3) applies to bust flips too.

> **Accepted GeoParty-parity corner:** a **dead reveal owner at `phase: reveal`**
> stalls the game — nobody writes the next round and S6 auto-advance is still
> owner-executed. This is the identical exposure GeoParty h2h accepts with a dead
> `hostTeam` at reveal; we accept it here too rather than adding a reveal-phase
> fallback writer. (During `roundActive` the dead-man bust fallback still fires, so
> only the reveal→next-round handoff is exposed.)

### 4.5 Stale-claim guard (two layers)

A `claimBuzz` from a just-ended prior round could in principle target the fresh
`round/buzz`. Two layers now handle it:

1. **Inside the updater (primary, v2 fix):** the epoch-guarded `claimBuzz` (§3)
   treats a `cur` whose `roundNumber !== claim.roundNumber` as **vacant** and
   overwrites it. So a stale claim can never *occupy* the fresh path and lock out
   live correct ringers. This fixes the v1 deadlock where the old
   `if (cur !== null) return undefined` updater let a stale claim brick the round
   into a guaranteed bust (correct ringers all abort with "too late," yet nobody
   flips on the stale claim → forced bust despite live winners).
2. **At settle time (defense in depth):** `settleFlip`/`roundConduct` still ignore
   a `buzz` whose `roundNumber !== round.number` (treat as absent → continue/bust),
   in case a stale claim is observed in the instant before the next live claim
   overwrites it.

With both layers, a stale claim is transient and harmless — the same accepted
">6 s dying-phone" corner *class*, but now genuinely bounded to at most one mis-
observed transition rather than a bricked round.

---

## 5. Private per-phone state (the second novel concept)

GeoParty has *zero* hidden information. Flag Reveal needs the wrong-ring lockout
to be private *during the round* — no other phone or the TV may learn, while play
is live, that or what a phone rang wrong. This forces a "private subtree" concept
the kernel does not have. §9 is honest about how far it actually goes.

### 5.1 The path and who reads it

- `round/private/tN = { lockedRound, wrongStep, wrongIso }`, written **only** by
  team tN's own phone, on a wrong ring. (`wrongIso` added in v2 so the reveal can
  disclose *what* was guessed, §5.3.)
- Read back **only** by the owning phone on resume (to restore its own lockout
  across a refresh — so a wrong-then-refresh phone stays locked out; local-only
  memory would lose this).
- Read by the flip writer **once, at settlement**, solely to stamp
  `results/tN.{rangOut, wrongIso, wrongStep}` (a *post-round* disclosure, §5.3).

### 5.2 The contract — and its honest boundary

**Contract:** *no renderer and no live-play decision reads `round/private/*`.* The
scene builders in `screen-flag.js` and the live buzzer UI in `flag-ui.js` are
never handed `round/private` as input. The **only** reader outside the owning
phone is `settleFlip` at the flip, and its output is disclosed only in `phase:
reveal`. Enforced by a test analogous to GeoParty's Decoy "hidden-in-play" test:
assert the render/scene functions and `roundConduct` ignore `round/private`.

**Boundary (state this plainly):** RTDB is world-readable within `rooms/` by
design, and every subscriber pulls the whole room via `subscribeRoom`'s `onValue`.
So "private" is a **render-discipline contract, not a transport guarantee.** A
determined devtools peeker on a rival phone *can* read `round/private/*`. This is
consistent with — and no weaker than — GeoParty's already-accepted posture that
the embedded `truth`/`answerIso` is peekable ("devtools-peeking is not a threat we
carry"). The suspense survives because casual party players do not open devtools;
a game whose *integrity* depended on secrecy could not be built on this stack
without server-side rules or auth (see §9.3).

> **Correction to the brief:** §3/§5 of the brief calls this a "private subtree,
> never on the live feed" contract as if it were a transport property. It is not,
> under a flat world-readable DB. It is a render-and-decision-boundary contract.
> That distinction is the sharpest finding of the whole experiment (§9.3) and must
> not be papered over.

### 5.3 Why the flip writer may read it — and full disclosure at reveal (v2)

`private/*` is disclosed **only at reveal**, after the round is decided, and in v2
it is disclosed **fully**, not just as a boolean:

- **During the round**, knowing a rival rang wrong lets you free-ride the
  remaining steps (the flag is guessable-but-hard) — so it stays private. That is
  the suspense the render-discipline contract protects.
- **At the flip**, that strategic value expires. So `settleFlip` reads
  `round/private/*` once and surfaces `{rangOut, wrongIso, wrongStep}` into each
  non-winner's `results/tN`. The reveal then plays the **full comedy beat** —
  *"OHHH, Dave rang Belgium at step 2!"* — with **zero strategic leak**, exactly
  like §1.5's "ohh, it was Chad!" payoff. This dominates both v1's boolean-only
  disclosure and public-with-penalty: all the suspense of private, nearly all the
  table energy of public.
- This resolves the v1 §10 headline inconsistency ("PRIVATE (identity + guess +
  lockout)") against a schema that stored **no guess**: `private/tN` now stores
  `wrongIso`.

**v1 decision, made explicit (resolving the v1 ambiguity):** for v1, `settleFlip`
**does** read `private/*` and **does** disclose `{rangOut, wrongIso, wrongStep}`
at the flip. There is exactly one `settleFlip` signature and one test set. (The
divergence exception of §4.3 applies to these disclosed fields.) The "fully
private, disclose nothing" branch is *not* v1 — it is documented only as a config
posture a future variant could take by having `settleFlip` stamp `rangOut:false`/
omit `wrongIso` and skip the `private/*` read.

---

## 6. The TV — passive in both modes

Unchanged from GeoParty's model; restated because it is an owner constraint.

- The TV **subscribes** to the room and **renders** `currentStep` via
  `exposedAt(revealPlan(flagSeed, …), currentStep)`, plus standings/winner/crown
  and, at reveal, the wrong-ring comedy beats from `results/*` (§5.3).
- The TV **writes only `screenHeartbeat`** (via `writeScreenHeartbeat`). It holds
  **no authority**, owns no timer, never advances a step, never flips a phase, and
  **never runs `roundConduct`** — a TV pushing a flip or a bust would violate
  owner constraint #2. The fallback flip/bust writers are phones only (§4.4).
- Liveness is stamped on each *receiver's own clock* at heartbeat receipt, with
  writer-clock-ancient beats ignored — GeoParty's S7 skew-proof rule, reused. A
  phone shows "on the TV" copy when a live heartbeat is present and "on your
  phone" copy when not; the reveal owner never waits for a heartbeat to start or
  advance a round (so a TV-less table plays with zero degradation).
- Multiple TVs are harmless (all passive subscribers). `nextRoom` +
  `followedCodes` cycle-break carry over verbatim for game-to-game handoff.

Because the reveal owner writes `currentStep` regardless of whether a TV is
present, "TV present" and "no TV" run the **same writes** — the TV is a
first-class, always-available *renderer*, exactly as constraint #1 demands, with
no special TV logic (constraint #2).

---

## 7. Host rotation

Follows the h2h `hostTeam` model exactly (owner constraint #3):

- The reveal owner is `hostTeam`. It owns the cadence timer and starts each round.
- At game over, `gameWinner` (pure, deterministic, computed on every device —
  no write) names the winner. The winner's phone creates the **next room**
  (game-to-game is a new room, as in h2h), writes `carryStandings(teams,
  winnerTeam)` — which zeroes totals for a fresh game (or carries them for a
  "season," a settings knob) and sets `hostTeam = winnerTeam` — and writes a fresh
  `gameSeed` for the new game (§8), all **before** the `nextRoom` pointer, on the
  same connection (the ordering guarantee the pointer already relies on).
  Subscribers (and any TV) follow the pointer.
- Within a single game (multiple rounds/flags), `hostTeam` does **not** move
  between rounds — the brief's phrase "becomes host for the next *round*" should
  read "for the next *game*." Rotating the reveal owner mid-game would add a
  handoff race for no product reason. **This is a correction:** rotation is
  per-game (matching h2h), not per-round.

---

## 8. Dataset & flag sequencing

**Recommendation: bundle `mledoze/countries` (ODbL) names/aliases as a static
`data/flags.json` in the Flag Reveal repo, and VENDOR the flag SVGs into the repo
(from `lipis/flag-icons`, MIT, or the public-domain flagcdn set).**

- **Names/aliases:** `mledoze/countries` is the richest public option (English +
  common alternate spellings + translations), which feeds both `normalizeAnswer`
  and the autocomplete index. Reduce it at author time to
  `{ iso2, name, aliases[], tier }`.
- **Flag images — vendor, do not hot-link.** The brief left this ambivalent
  ("flagcdn … or vendor"). Decide: **vendor.** CLAUDE.md requires "degrade
  gracefully offline / `file://`." A CDN hot-link breaks offline and `file://`
  parity and adds a third-party runtime dependency the no-deps rule frowns on.
  Vendored SVGs (a few hundred KB total, one per country) ship in the repo, load
  from a relative path, and work offline. If SRI-style integrity matters, the
  SVGs are static assets served from our own Pages origin — no CDN tampering
  surface at all.
- **Difficulty tiers** (`settings.difficulty`) select the flag pool by
  recognizability: `easy` (well-known flags, optionally `inputMode:"choice"` for
  kids), `world` (the default mixed pool), `expert` (obscure and
  visually-similar flags — Chad/Romania, Indonesia/Monaco, Mali/Guinea — where
  the progressive reveal genuinely matters).

### 8.1 The game-level seed & cursor (v2 — was missing)

v1's schema seeded the *reveal plan* per round (`flagSeed`) but never said **where
the game's flag sequence comes from**, how repeats within a game are prevented, or
how an owner refresh mid-game resumes without resampling a fresh flag. GeoParty
solves the equivalent with `poolCursor`; Flag Reveal mirrors that intent with a
**derive-don't-store** design:

- **`gameSeed`** is written **once at room creation** (and re-minted for each new
  game at host rotation, §7).
- The game's flag list is a **pure, deterministic function of `gameSeed`**:
  `gameFlags(gameSeed, roundCount, difficulty, pool)` = a `pool.js`-style seeded
  shuffle of the difficulty tier's ISO codes (with an **easy-first-round guard**),
  truncated to the number of rounds the game can run. Repeat-free within a game by
  construction (it is a shuffle without replacement).
- Round k's flag is `flagForRound(gameSeed, number)` = `gameFlags(...)[number-1]`,
  and its per-round `flagSeed` (reveal plan + choice options) is derived as
  `hash(gameSeed, number)`. Both are embedded into `round` at round start for
  self-scoring, but because they are *derivable*, the **owner can refresh mid-game
  and re-author the identical round** — no resample, no divergence, no stored
  cursor to advance. (`round.number` alone is the cursor; it already advances with
  the phase machine.)
- Easy-mode `chooseOptions(flagSeed, answerIso, pool)` (§1.3) is likewise a pure
  fn of the round's `flagSeed`, so every phone/TV shows the identical 4 options in
  the identical order, and a refresh reproduces them.

- **Do not touch** GeoParty's `data/location_pool.json` or its pool-integrity
  suite. Flag Reveal ships its own `data/flags.json` with its own integrity test
  (shape, unique ISO codes, every entry has ≥1 vendored SVG).

---

## 9. Extraction map — what the kernel abstracts, what it can't

This is the experiment's payload: which GeoParty sync mechanisms are reusable
kernel, which must be rewritten, and — honestly — where the extraction hypothesis
holds and where it breaks.

### 9.1 REUSES cleanly (the kernel holds)

| Kernel piece | How Flag Reveal reuses it |
|---|---|
| `roomRef()` single choke point | Unchanged; every read/write/subscribe/transaction routes through it. |
| Phase machine + `canTransition` | New 4-state machine (§11), same enforcement shape. |
| Disjoint-path last-write-wins | `teams/tN`, `private/tN`, and single-writer `currentStep` cadence are disjoint by owner; `results/*` is single-flip-writer-owned (§2). |
| Reveal-flip identical-shape settlement race | Inherited *verbatim* for the **totals + winner + phase** of both the buzz-win flip and the bust flip (`settleFlip` is the pure fn; racing writers agree on totals). SUPER SURE's absolute-total argument carries over. (The wrong-ring disclosure fields are a scoped exception, §4.3.) |
| Deadlock / fallback-flip guard | `roundConduct` any-phone (never TV) fallback for buzz-flip and bust, with the `×3 grace` fallback offset from the forfeit sweep. |
| ≤4 writes/s throttle | Cadence is 1 write / `stepMs` (≈0.67/s) — trivially under budget; live-mirror throttle pattern available if any live surface is added. |
| Clock discipline | Sharpened: the *step integer* (single-writer) is the score clock **and** the owner's bust gate; local clocks drive only cosmetic interpolation and the non-owner dead-man bust. |
| Pool seed / cursor | `gameSeed` + derive-don't-store round derivation mirrors `poolCursor` intent (§8.1); refresh-resume is free. |
| `screenHeartbeat` passive-TV + S7 liveness | Verbatim; the TV is one more subscriber, both modes, and runs no fallbacks. |
| `nextRoom` + `followedCodes` chain | Verbatim for game-to-game handoff. |
| `hostTeam` rotation | Verbatim (winner becomes reveal owner next game). |
| `claimTeamSlot` transaction | Verbatim for slot claiming. |
| "Local until commit" pattern (SUPER SURE arming) | Reused conceptually: correctness is decided *locally* and only *committed* via the transaction; wrong rings never leave the phone except as private state. |
| Consent/analytics seam | Extend `EVENT_SCHEMA`; aggregates only (§12). |

### 9.2 BREAKS — must rewrite: buzzer arbitration (contention class)

- **What breaks:** the write-ownership table's headline rule — *"writers never
  contend on the same path"* — is now **false**. N phones race the single
  `round/buzz` path with **first-wins** semantics.
- **Where the hypothesis HOLDS:** the *mechanism* already exists. An RTDB
  transaction (`claimBuzz`) is `claimTeamSlot` with a different path; the server
  serializes it; the loser aborts client-side. Nothing new had to be invented at
  the Firebase layer.
- **Where the hypothesis BREAKS:** the *conceptual model* was incomplete. The
  kernel described concurrency as a single idea ("disjoint-path last-write-wins +
  one settlement race") with the transaction as a one-off footnote
  (`claimTeamSlot`). A buzzer proves the kernel needs a **named, first-class
  peer concept**: a **contended claim path** — *one path, many writers, first
  commit wins, transaction-arbitrated, losers abort* — standing beside the
  disjoint-path/last-write-wins rule.
- **Sharpening (v2): the primitive needs an epoch guard.** `claimTeamSlot` gets
  away with a bare null-check-only updater because slots have no epochs. A buzzer
  path *does* have an epoch (the round), and a stale claim from a prior round must
  not be able to occupy the fresh path — otherwise it bricks the round's win path
  (the correctness bug the v1 updater created, §4.5). So the extracted primitive
  is **not** bare compare-and-set-if-null; it is a **contended claim with an epoch
  guard** — *claim-if-vacant-**or**-stale*, the validity predicate living **inside
  the transaction updater**. The extraction deliverable is therefore "**promote
  transactions from an exception to a first-class arbitration primitive — an
  epoch-guarded contended claim — and rename the model to two peers: disjoint
  last-write-wins, and contended first-write-wins.**" That is the finding, and it
  is strictly better (more correct, more general) than v1's bare-CAS statement.

### 9.3 BREAKS — must rewrite: private state (and it only half-works)

- **What breaks:** GeoParty has zero hidden information; there is no "private
  subtree" concept anywhere in the kernel.
- **Where the hypothesis HOLDS:** at the **render/decision boundary.** A clean,
  testable contract — "no renderer or live-play decision reads `round/private/*`"
  — is expressible and enforceable exactly like the Decoy hidden-in-play test.
  For the actual product (casual party play), this fully delivers the suspense.
- **Where the hypothesis BREAKS:** at the **transport boundary.** RTDB is
  world-readable within `rooms/` and every subscriber pulls the whole room, so
  "private" cannot be a transport or cryptographic guarantee — a devtools peeker
  reads it. The kernel *cannot* offer a true "never on the live feed" secrecy
  primitive without leaving its own posture (server-side per-path read rules +
  auth, or client-side crypto — both violate the no-server/no-auth/no-deps
  constraints). **So the honest extracted contract is narrower than the brief
  implied:** the kernel can offer *"private-by-render-discipline"* (good enough
  for hidden information whose value is social, not adversarial), but **not**
  *"private-by-transport."* Any future game whose correctness depends on secrecy
  (sealed bids that must resist a determined peer, hidden roles) is **not
  expressible** on this kernel. That boundary — discovered by trying to build the
  simplest possible hidden state — is the second, and subtler, extraction result.

### 9.4 Net

The extraction hypothesis **holds for every synchronization mechanism** (phase
machine, write ownership for disjoint paths, throttle, clock discipline, deadlock
guard, seed/cursor, heartbeat/next-room chain) and **holds for the buzzer's
mechanism** — but it forces the *model* to grow a second concurrency concept
(contended first-write-wins, epoch-guarded) and reveals a *hard ceiling* on the
privacy concept (render-deep only). Two invariants broken, one cleanly
generalizable, one only partially — which is exactly the maximal-signal-per-build
outcome the experiment wanted (brief §7).

---

## 10. Wrong ring — private during the round, disclosed at reveal (v2 decision)

**Decision: PRIVATE during the round, FULL disclosure at the reveal** — surface
`{rangOut, wrongIso, wrongStep}` per non-winner at the flip (§5.3). The optional
non-identifying "rings so far: N" tension counter stays **OFF for v1** and is
noted as undesigned.

### Reasoning

- **Product / suspense:** the entire hook is a *progressive* reveal. If a phone
  can see *during the round* that rivals rang and missed, it learns the flag is
  guessable-but-hard and can free-ride the remaining steps — the reveal's tension
  deflates. Private-during-play keeps every player's information to *their own
  eyes and the flag*. And private lockout makes a wrong ring **cheap enough to
  risk** — the shy or younger player who dares an early ring is not broadcast a
  live failure and stops ringing; a buzzer game where people fear to buzz is dead.
  This is what produces the early-step contested claims the experiment wants.
- **But keep the party payoff.** "OHHH, Dave rang Belgium at step 2!" is only a
  live-play leak *during* the round; at the reveal it is pure payoff, exactly like
  §1.5's "ohh, it was Chad!". §5.3's own logic — the private information's
  strategic value expires at the flip — licenses disclosing *everything* at
  reveal. So v2 stores `wrongIso` privately and discloses the full beat at the
  flip: all the suspense of private, nearly all the table energy of public.
- **Experiment value:** private is what *forces the second novel kernel concept
  to exist* (§9.3). Public-with-penalty needs no private subtree at all — a wrong
  ring would just write a public `results/tN` badge everyone renders during play —
  so it tests only the arbitration break and throws away half the experiment's
  signal (echoing brief §7's "hit both breaks" logic). Building the game to learn
  the most means keeping the private-during-play mechanic.

### The optional counter — OFF for v1, and undesigned

A live non-identifying "a ring just happened / rings so far: N" pulse is **not
free**, and v1 does not design it. It is either (a) a *third* contended
transaction (an increment path — fine, but that is new mechanism to specify and
test), or (b) derived by renderers **counting `private/*` entries** — which
directly **violates the render-discipline contract** the whole experiment exists
to test. Neither is specified here. There is also a residual leak: since a
*correct* ring immediately flips to `reveal`, any pulse that does not resolve to a
reveal is implicitly a wrong ring, so the counter leaks "the flag has been
under-guessed" (low-grade, non-actionable, but real). Therefore: **ship v1 with
the counter OFF**, giving the cleanest test of the hidden-subtree contract. If it
ever ships, it needs its **own design paragraph** (which transaction path, or how
it stays off `private/*`) — it is not a free toggle.

---

## 11. Phase machine

Head-to-head-shaped (no global "guessing" phase — buzzing happens *within*
`roundActive`):

```
lobby → roundActive → reveal → (roundActive | gameOver)
gameOver  terminal (next game = new room via nextRoom)
```

`canTransition(from, to)` allowlist (enforced by the reveal owner; fallbacks only
ever push a *legal* transition; the TV never proposes a transition):

| from | to | who / when |
|---|---|---|
| lobby | roundActive | reveal owner starts round 1 |
| roundActive | reveal | reveal owner on buzz-claim or bust; **fallback:** any phone, never the TV (identical-shape totals flip, §4.3/§4.4) |
| reveal | roundActive | reveal owner (or S6 auto-advance) when more rounds remain and no `target` reached |
| reveal | gameOver | reveal owner (or S6 auto-advance) when `gameWinner` is decided (`target` reached or `roundCount` done) |
| gameOver | — | terminal; winner's phone writes the next room + `gameSeed` + `nextRoom` |

Illegal transitions (e.g. `roundActive → gameOver` directly, or `reveal →
reveal`) are rejected by `canTransition`. The fallback flip writers compute their
target with the same `roundConduct`/`settleFlip` fns, so they never propose an
illegal or divergent transition. A dead owner at `phase: reveal` simply stalls
(no legal fallback writer for `reveal → roundActive`), an accepted GeoParty-parity
corner (§4.4).

---

## 12. Instrumentation (mandatory — CLAUDE.md)

Extend `EVENT_SCHEMA` (the hard allowlist); aggregates only, never answer text,
guesses, ISO codes as free strings, team names, or anything identifying. Two new
events:

- `flag_ring` — one per ring. Props: `mode` (`tv`|`phone`), `atStep` (int),
  `correct` (bool), `points` (int, 0 for wrong), `contested` (bool — did a
  `claimBuzz` abort, i.e. did a correct ring collide). **Feeds the headline KPI:**
  are correct rings actually colliding (the experiment's success condition,
  brief §7)?
- `flag_round` — one per round at reveal. Props: `mode`, `outcome`
  (`won`|`busted`), `winningStep` (int|null), `ringCount` (int, total rings
  including wrong), `roundNumber`. Feeds reveal-difficulty tuning (which step do
  rounds resolve at; bust rate by difficulty tier).

Note: `wrongIso` is disclosed *in the room UI* at reveal (party value, §5.3) but
is **never** emitted to analytics — no ISO codes as free strings, per the schema
allowlist. Add sanitizer tests in the new repo's `tests/analytics.test.js`
(assert no coordinate-shaped, ISO-shaped, or free-text keys survive), document
both events and their KPIs in the repo's `docs/analytics.md`. If an event is
judged to add no signal, say so explicitly in the change summary rather than
skipping silently.

---

## 13. What must NOT change

- **Consent gating is inviolable.** All capture through `track()`/`trackError()`
  from `consent.js`; never reference PostHog directly; never capture pre-opt-in;
  never weaken banner/revoke. Aggregates only (§12). `POSTHOG_INIT_OPTIONS` stays
  mutable.
- **`roomRef()` stays the sole room path choke point.** Every read/write/
  subscribe/transaction routes through it.
- **Transactions stay the ONLY non-`update()` writes.** Now there are two
  (`claimTeamSlot`, `claimBuzz`); both are the promoted arbitration primitive, and
  `claimBuzz` carries the epoch guard (§3).
- **Throttle ≤4 writes/s per writer.** Cadence and any live mirror obey the
  dirty-flag + 250 ms pattern, canceled on phase change.
- **Clocks never ticked through Firebase.** Score clock = the single-writer
  `currentStep` integer; the owner's bust gate is step completion; local clocks
  are cosmetic + non-owner dead-man deadline only (§1.4).
- **Reveal-flip identical-shape race invariant (scoped).** Both the buzz-win flip
  and the bust flip compute totals/winner/phase from an atomic snapshot via
  `settleFlip`; absolute totals, never increments (§4.3). The wrong-ring
  disclosure fields are the one explicitly-scoped exception (cosmetic, last-write-
  wins, §4.3).
- **Pure/glue split.** Decision logic in `flag.js` (tested); `flag-ui.js` /
  `screen-flag.js` stay thin. Every feature ships tests + instrumentation.
- **Passive TV.** The TV writes only `screenHeartbeat`; it never gains authority,
  a timer, or a `roundConduct` fallback (owner constraint #2, §6).
- **`hostTeam`-rotation, `nextRoom`+`followedCodes`, S7 skew-proof liveness, S6
  auto-advance** all reused verbatim.
- **Session-replay masking** for any new screen rendering a team name or room
  code (`data-ph-mask`); update the replay-mask checklist in the same change.
- **No build, no deps, no server; degrade offline/`file://`** — hence vendored
  flag SVGs (§8), not a CDN hot-link, and the derive-don't-store game seed so a
  refresh resumes offline without a server round-trip (§8.1).
- **Do not touch GeoParty's `data/`, `tools/`, or its pool suite.** Flag Reveal
  is its own repo with its own `data/flags.json` and its own integrity test.

---

## 14. Corrections to the first-pass brief (summary)

1. **Topology vs. mode (§0).** The brief frames couch and everyone-plays as two
   topologies; they are one h2h-shaped topology with two *render* modes. Buzzing
   is always per-phone; only the reveal renderer changes with TV presence.
2. **First-correct, not first-to-act (§4.1).** The transaction must be attempted
   *only by a correct ring*; wrong rings never contend on `round/buzz`. The brief
   implied the transaction claims "first" without separating correct from wrong —
   which would let a wrong ringer block the path.
3. **Private is render-deep, not transport-deep (§5.2, §9.3).** The brief calls
   the private subtree a "never on the live feed" contract as if it were a
   transport property. Under a flat world-readable RTDB it is a render/decision
   discipline only. This is the subtler half of the extraction result and must be
   stated, not glossed.
4. **Rotation is per-game, not per-round (§7).** "Winner becomes host for the
   next *round*" should read "next *game*"; mid-game reveal-owner rotation adds a
   needless handoff race.
5. **Clock sharpening (§1.4).** The score clock is the *single-writer step
   integer*, not any device clock — stronger than "skew-tolerant." The owner's
   bust is gated on step completion (not a wall-clock formula it can itself
   throttle out of); local clocks drive only cosmetic interpolation and the
   non-owner dead-man deadline.
6. **Vendor the flag SVGs (§8).** The brief left CDN-vs-vendor open; the
   offline/`file://` rule decides it: vendor.
7. **The extraction framing (§9).** The brief says the kernel "needs a
   claim/arbitration primitive." Sharpen: the *mechanism* already exists
   (transactions); what the experiment forces is (a) *promoting* it to a named
   first-class peer of the disjoint-path rule — an **epoch-guarded** contended
   claim, not a bare CAS — and (b) discovering a *hard ceiling* on privacy
   (render-deep only). Two distinct findings, one of them a boundary/negative
   result.
