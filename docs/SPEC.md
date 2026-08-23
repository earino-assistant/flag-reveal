# FLAG REVEAL — implementation-ready spec

*Architect/designer deliverable, 2026-08-23. Design-only: no GeoParty repo
changes. Register follows `geoparty/docs/architecture.md` — plain and direct.*

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
  `isValidRoomCode`). `mode: "flag"`.
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
   `truth`: devtools-peeking is not a threat we carry).
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
     private lockout (§5). No other phone or the TV learns of it. The reveal
     continues.
4. **Bust.** If all 8 steps plus a grace window (`graceMs = 3000`) elapse with no
   correct ring, the round **busts**: zero points to everyone, flip to `reveal`
   showing the full flag and the answer (§1.5).
5. **Reveal + advance.** `phase: reveal` shows the full flag, the answer, who won
   (or "nobody"), the points awarded, and updated standings. Soft auto-advance
   (S6 machine, reused verbatim) counts down to the next round; the reveal owner
   may hold it (`autoAdvanceAt: null`).

### 1.3 Ring-in mechanics (concrete)

The commit surface is a **country typeahead/autocomplete that resolves to a
canonical ISO code**, not raw free text and not 1-of-4 multiple choice.

- **Why typeahead-to-ISO, not free text:** correctness becomes an exact ISO
  compare (`committedIso === answerIso`), so no fuzzy string matching sits on the
  win path; aliases/spellings/diacritics are absorbed by the autocomplete index
  (built from `normalizeAnswer`, §1.6), not by a runtime guess-matcher.
- **Why not multiple choice by default:** a 4-option pick makes the round a
  coin-flippy trivia guess and collapses the skill of *recognizing a
  half-revealed flag*. Multiple choice is offered only as an **easy-mode**
  difficulty setting (§8) for young kids.
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
- **Bust deadline = local clock from the authored `startedAt`.** Any phone
  computes `bustAt = round.startedAt + STEPS·stepMs + graceMs` on its own clock.
  Skew shifts *when* a fallback bust fires by the skew amount, never the outcome
  (identical-shape flip, §4).

> **Residual, accepted:** a ring committed in the sub-`stepMs` window right after
> the owner advanced a step but before this phone received the write scores at
> the *older* (lower) step — up to one step in the ringer's favor. Bounded to ±1
> step of propagation delay, symmetric across players, and far smaller than the
> product's grain. This is the flag-game analog of GeoParty's "skew shifts *when*
> you auto-submit." Documented, not defended against.

### 1.5 Bust

- Trigger: `phase === roundActive` and `now ≥ bustAt` and `round/buzz` is null.
- Writer: reveal owner; **fallback: any phone** (identical-shape flip, §4).
- Effect: `phase: reveal`, `round/buzz` stays null, every `results/tN` is
  `{correct:false, points:0, rangOut:true|false}`, no team total changes.
- The reveal shows the full flag and the answer so the busted round still *pays
  off as a reveal* (party value: "ohh, it was Chad!").

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
  settings           { roundCount, stepMs, gridN, base, min, target,
                       difficulty ("easy"|"world"|"expert"),
                       inputMode ("typeahead"|"choice") }
  hostTeam           tN — reveal owner; rotates to the winner (§7)
  teams/t1..t4       { name, total, deviceId, reachedTotalAt }
  round
    number           1-based
    flagSeed         deterministic reveal-plan seed (like pool.js seeds)
    answerIso        ISO-3166-1 alpha-2, embedded at round start (self-scoring)
    startedAt        ms epoch — authored by the reveal owner (bust-clock anchor)
    currentStep      1..STEPS — SINGLE-WRITER cadence integer (the clock)
    stepStartedAt    ms epoch of the current step (cosmetic interpolation only)
    buzz             TRANSACTION path — first-CORRECT claim (§4). Absent = unclaimed.
                     { team, atStep, roundNumber, atMs }   atMs = cosmetic only
    results/tN       { correct, stepAtRing, points, rangOut }   settled at flip
    private/tN       { lockedRound, wrongStep }   PRIVATE — never rendered (§5)
    revealAt         countdown target, stamped at the reveal flip (S6, reused)
    autoAdvanceAt    revealAt + 15s; null = the reveal owner held it (S6, reused)
  screenHeartbeat    ms epoch — the ONLY thing the TV writes (unchanged)
  nextRoom           pointer into a FINISHED room → subscribers follow (unchanged)
```

Notes:

- `round/buzz` sits **inside** `round`, so a round advance (which overwrites
  `round`) resets it to absent by construction. A prior-round claim in flight is
  guarded by `buzz.roundNumber` at settle time (§4) — the same ">6 s dying-phone"
  class of accepted corner GeoParty already lives with.
- `results/tN` and `private/tN` are each written **only by team tN's phone**
  (disjoint own-subtree), except the winner's `results` + `total` which are
  settled by the flip writer in the identical-shape race (§4) so racing writers
  agree.
- Old/other clients ignore unknown paths (additive-path convention, unchanged).

---

## 3. Module seams (pure/glue split preserved)

Mirrors GeoParty's layout: decision logic in a new **pure, tested** module; DOM +
Firebase glue in thin `*-ui.js` files; the transaction helper beside
`claimTeamSlot` in `firebase.js`.

### New pure module — `js/flag.js` (tested, no DOM, no network)

- `revealPlan(seed, steps, gridN) → { tileOrder:[…], blur:[…] }`
  Deterministic, seeded like `pool.js`: a seeded shuffle of `gridN²` tile indices
  partitioned into `steps` groups, plus a monotonic-decreasing blur schedule
  (default `20px → 0` across `steps`). Pure data; the UI paints pixels.
- `exposedAt(plan, step) → { tiles:number[], blurPx:number }`
  Which tiles are de-occluded and the blur at step `k`. Pure.
- `scoreRing(stepAtRing, steps, base, min) → points` (§1.7).
- `normalizeAnswer(guess, answerIso, aliases) → bool` (§1.6); also exposes
  `buildAnswerIndex(dataset) → Map<normalizedName, iso>` for the autocomplete.
- `adjudicateBuzz(currentBuzz, claim) → "won" | "lost"` — pure fold over the
  transaction snapshot (mirrors the `claimBuzz` updater's decision so it is
  unit-testable without Firebase).
- `roundConduct(phase, buzz, round, now, cfg) → "continue" | "flip" | "bust"` —
  the reveal owner's and the fallback's decision function (§4.4). Pure.
- `settleFlip(round, teams, buzz, cfg) → { results, totals, hostTeam }` — computes
  the atomic reveal-flip patch from a snapshot (the identical-shape guarantee
  lives here; racing writers call the same pure fn on the same snapshot → same
  bytes).
- `gameWinner(teams, cfg) → tN | null` and `carryStandings(teams, winnerTeam) →
  {teams, hostTeam}` for game-over → next room (§7).

### New glue

- `js/flag-ui.js` — the player phone: lobby/slot claim, buzzer surface, reveal
  render (used when no TV), reveal-owner cadence loop when this phone *is*
  `hostTeam`, all writes. Logic-light; every rule calls into `flag.js`.
- `js/screen-flag.js` — the TV renderer: subscribes, renders `currentStep` via
  `exposedAt`, standings, winner, crown. Writes only `screenHeartbeat`. No
  authority.

### `js/firebase.js` addition — the arbitration primitive

```js
// First-CORRECT ring wins. The server serializes concurrent transactions, so
// ordering is authoritative and clock-skew-immune. Only a phone that has already
// evaluated its own guess as CORRECT calls this — a wrong ring never touches
// this path (it stays private, §5). Beside claimTeamSlot: the SECOND, and now
// first-class, transactional write.
export async function claimBuzz(code, claim) {
  const res = await runTransaction(roomRef(code, "round/buzz"), (cur) => {
    if (cur !== null) return undefined; // already claimed — abort
    return claim;                       // { team, atStep, roundNumber, atMs }
  });
  return res.committed;
}
```

`roomRef` stays the only path composer; transactions stay the *only* non-`update`
writes. This is `claimTeamSlot` generalized — same shape, same `committed`
contract.

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

1. Player commits ISO `X` at `currentStep = k`.
2. Phone computes `X === answerIso`.
   - **false →** write `round/private/tN = {lockedRound: round.number, wrongStep:
     k}`; disable the local buzzer for the round; return. (Round continues.)
   - **true →** `claimBuzz(code, {team: tN, atStep: k, roundNumber: round.number,
     atMs: Date.now()})`.
     - `committed === true` → I won. Push the reveal flip (§4.3).
     - `committed === false` → someone correct rang first; show "too late,"
       disable buzzer.

### 4.3 The reveal flip + settlement (identical-shape race — reused invariant)

When `round/buzz` becomes non-null (a correct claim landed), the room flips to
`reveal` and settles scores. This *is* GeoParty's reveal-flip settlement race,
inherited verbatim:

- **Writer:** the reveal owner reacts to the buzz and writes the flip. **Fallback:
  any phone** that observes `round/buzz != null && phase === roundActive &&
  buzz.roundNumber === round.number` pushes the same flip (deadlock guard analog,
  §4.4).
- **Identical shape:** every candidate writer computes the patch from the *same*
  atomic snapshot via `settleFlip(round, teams, buzz, cfg)`:
  ```
  phase: "reveal"
  round/results/{winner}: { correct:true, stepAtRing: buzz.atStep,
                            points: scoreRing(buzz.atStep, …), rangOut:false }
  round/results/{other}:  { correct:false, points:0, rangOut: <from private?> }
  teams/{winner}/total:   <prior total + points>   (ABSOLUTE, like SUPER SURE)
  teams/{winner}/reachedTotalAt: round.number       (for tie-break)
  round/revealAt, round/autoAdvanceAt               (S6, reused)
  ```
  Because `settleFlip` is a pure fn of the snapshot, racing writers emit identical
  bytes → the collision is harmless, exactly as the SUPER SURE settlement
  extended the reveal-flip exception. `total` is **absolute** (recomputed from the
  snapshot's prior total), never a relative increment, so a double-applied flip
  cannot double-count.

> Note: `results/{other}.rangOut` is settled from the flip writer's snapshot of
> `round/private/*`. This is the one place a shared writer *reads* the private
> subtree — see §5.3 for why that is acceptable and how the render-discipline
> contract still holds (the settled `rangOut` boolean is a *post-round*
> disclosure, revealed only at reveal, never during live play).

### 4.4 The fallbacks (deadlock + bust) — `roundConduct`

The reveal owner is the sole cadence writer, so if its phone dies mid-round the
round would hang. Same failure mode GeoParty's lock-in deadlock had; same style
of guard. Every phone runs `roundConduct` on each state change:

- `phase === roundActive` and `round/buzz != null` (valid `roundNumber`) →
  `"flip"` (someone rang; push §4.3 if not already flipped). Once per round,
  duplicates harmless.
- `phase === roundActive` and `buzz` null and `now ≥ bustAt` (local clock from
  `startedAt`) → `"bust"` → push the bust flip (§1.5). To avoid a thundering herd,
  the reveal owner acts at `bustAt`; other phones use a `×3 graceMs` fallback
  offset (mirrors the forfeit-sweep's `×3` fallback), so the owner almost always
  wins the race and the flip is identical-shape regardless.
- else → `"continue"`.

The bust flip is also identical-shape (`settleFlip` with `buzz === null` → all
zeros), so the owner-vs-fallback race is harmless.

### 4.5 Stale-claim guard

A `claimBuzz` from a just-ended prior round could in principle land on the fresh
`round/buzz` (null after advance). Guard: `settleFlip` ignores a `buzz` whose
`roundNumber !== round.number` (treats it as absent → continue/bust). This is the
same accepted ">6 s dying-phone" corner class; not defended beyond the round-number
check.

---

## 5. Private per-phone state (the second novel concept)

GeoParty has *zero* hidden information. Flag Reveal needs the wrong-ring lockout
to be private — no other phone or the TV may learn, *during the round*, that or
what a phone rang wrong. This forces a "private subtree" concept the kernel does
not have. §9 is honest about how far it actually goes.

### 5.1 The path and who reads it

- `round/private/tN = { lockedRound, wrongStep }`, written **only** by team tN's
  own phone, on a wrong ring.
- Read back **only** by the owning phone on resume (to restore its own lockout
  across a refresh — so a wrong-then-refresh phone stays locked out; local-only
  memory would lose this).
- Read by the flip writer **once, at settlement**, solely to stamp
  `results/tN.rangOut` (a *post-round* disclosure, §5.3).

### 5.2 The contract — and its honest boundary

**Contract:** *no renderer and no live-play decision reads `round/private/*`.* The
scene builders in `screen-flag.js` and the live buzzer UI in `flag-ui.js` are
never handed `round/private` as input. Enforced by a test analogous to GeoParty's
Decoy "hidden-in-play" test: assert the render/scene functions ignore
`round/private`.

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

### 5.3 Why the flip writer may read it

`rangOut` is disclosed **only at reveal**, after the round is decided. Revealing
at the payoff "who rang and missed" is a *feature* (party value), not a live-play
leak — the suspense the private contract protects is *during* the reveal, when
knowing a rival is locked out would let you free-ride the remaining steps. Once
the round is over that value is spent, so post-round disclosure is fine. If even
post-round disclosure is unwanted (§10 keeps it fully private), the flip writer
simply sets `rangOut:false` for everyone and never reads `private/*`; the contract
tightens to "no one but the owner ever reads it."

---

## 6. The TV — passive in both modes

Unchanged from GeoParty's model; restated because it is an owner constraint.

- The TV **subscribes** to the room and **renders** `currentStep` via
  `exposedAt(revealPlan(flagSeed, …), currentStep)`, plus standings/winner/crown.
- The TV **writes only `screenHeartbeat`** (via `writeScreenHeartbeat`). It holds
  **no authority**, owns no timer, never advances a step, never flips a phase.
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
  "season," a settings knob) and sets `hostTeam = winnerTeam` — **before** the
  `nextRoom` pointer, on the same connection (the ordering guarantee the pointer
  already relies on). Subscribers (and any TV) follow the pointer.
- Within a single game (multiple rounds/flags), `hostTeam` does **not** move
  between rounds — the brief's phrase "becomes host for the next *round*" should
  read "for the next *game*." Rotating the reveal owner mid-game would add a
  handoff race for no product reason. **This is a correction:** rotation is
  per-game (matching h2h), not per-round.

---

## 8. Dataset

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
  the progressive reveal genuinely matters). Selection uses `pool.js`-style
  seeded shuffle with an easy-first-round guard, keyed by `flagSeed`.
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
| Disjoint-path last-write-wins | `teams/tN`, `results/tN`, `private/tN`, and single-writer `currentStep` cadence are all disjoint by owner. |
| Reveal-flip identical-shape settlement race | Inherited *verbatim* for both the buzz-win flip and the bust flip (`settleFlip` is the pure fn; racing writers agree). SUPER SURE's absolute-total argument carries over. |
| Deadlock / fallback-flip guard | `roundConduct` any-phone fallback for buzz-flip and bust, with the `×3 grace` fallback offset from the forfeit sweep. |
| ≤4 writes/s throttle | Cadence is 1 write / `stepMs` (≈0.67/s) — trivially under budget; live-mirror throttle pattern available if any live surface is added. |
| Clock discipline | Sharpened: the *step integer* (single-writer) is the score clock; local clocks drive only cosmetic interpolation and the bust deadline. |
| `screenHeartbeat` passive-TV + S7 liveness | Verbatim; the TV is one more subscriber, both modes. |
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
  disjoint-path/last-write-wins rule. The extraction deliverable is therefore not
  "add a new mechanism" but "**promote transactions from an exception to a
  first-class arbitration primitive and rename the model to two peers: disjoint
  last-write-wins, and contended first-write-wins.**" That is the finding.

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
guard, heartbeat/next-room chain) and **holds for the buzzer's mechanism** — but
it forces the *model* to grow a second concurrency concept (contended
first-write-wins) and reveals a *hard ceiling* on the privacy concept
(render-deep only). Two invariants broken, one cleanly generalizable, one only
partially — which is exactly the maximal-signal-per-build outcome the experiment
wanted (brief §7).

---

## 10. Open decision: wrong ring — private or public?

**Recommendation: PRIVATE (identity + guess + lockout), with an optional
non-identifying "rings so far: N" tension counter, and default it OFF for v1.**

### Reasoning

- **Product / suspense:** the entire hook is a *progressive* reveal. If a phone
  can see that rivals rang and missed, it learns the flag is guessable-but-hard
  and can free-ride the remaining steps — the reveal's tension deflates. Private
  keeps every player's information to *their own eyes and the flag*.
- **Experiment value:** private is what *forces the second novel kernel concept
  to exist* (§9.3). Public-with-penalty needs no private subtree at all — a wrong
  ring would just write a public `results/tN` badge everyone renders — so it
  tests only the arbitration break and throws away half the experiment's signal
  (echoing brief §7's "hit both breaks" logic). Building the game to learn the
  most means keeping the private mechanic.

### The trade-off, honestly

- **Cost of private:** a wrong buzz is *silent* — you lose the loud
  table-laughter party moment ("OHHH, Dave rang Belgium at step 2!"). And the
  privacy is only render-deep (§9.3), so the mechanic's *product* strength rests
  on players not peeking.
- **Cost of public-with-penalty:** louder and simpler (no private path, no
  render-discipline test, arbitration is the only new thing), but it leaks
  difficulty info, weakens the very privacy signal the experiment is trying to
  produce, and makes the "hidden information" extraction result unavailable.

### The synthesis (recommended default path)

Keep **content private** (who rang, what they guessed, that they are locked out),
but optionally surface a **non-identifying aggregate pulse** — an anonymous "a
ring just happened / rings so far: N" flash on the TV and phones — to recover most
of the party energy without disclosing identity or correctness. Residual leak,
stated plainly: since a *correct* ring immediately flips to `reveal`, any pulse
that does *not* resolve to a reveal is implicitly a wrong ring, so the counter
leaks "the flag has been under-guessed" (not by whom, not what). That is a
low-grade, non-actionable leak (you cannot free-ride on "someone somewhere
missed"). Ship v1 **fully private, counter OFF** to give the cleanest possible
test of the hidden-subtree contract; expose the counter as a settings toggle for
groups that want more theater. Either way the extraction result (§9.3) is
recorded.

---

## 11. Phase machine

Head-to-head-shaped (no global "guessing" phase — buzzing happens *within*
`roundActive`):

```
lobby → roundActive → reveal → (roundActive | gameOver)
gameOver  terminal (next game = new room via nextRoom)
```

`canTransition(from, to)` allowlist (enforced by the reveal owner; fallbacks only
ever push a *legal* transition):

| from | to | who / when |
|---|---|---|
| lobby | roundActive | reveal owner starts round 1 |
| roundActive | reveal | reveal owner on buzz-claim or bust; **fallback:** any phone (identical-shape flip, §4.3/§4.4) |
| reveal | roundActive | reveal owner (or S6 auto-advance) when more rounds remain and no `target` reached |
| reveal | gameOver | reveal owner (or S6 auto-advance) when `gameWinner` is decided (`target` reached or `roundCount` done) |
| gameOver | — | terminal; winner's phone writes the next room + `nextRoom` |

Illegal transitions (e.g. `roundActive → gameOver` directly, or `reveal →
reveal`) are rejected by `canTransition`. The fallback flip writers compute their
target with the same `roundConduct`/`settleFlip` fns, so they never propose an
illegal or divergent transition.

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

Add sanitizer tests in the new repo's `tests/analytics.test.js` (assert no
coordinate-shaped or free-text keys survive), document both events and their KPIs
in the repo's `docs/analytics.md`. If an event is judged to add no signal, say so
explicitly in the change summary rather than skipping silently.

---

## 13. What must NOT change

- **Consent gating is inviolable.** All capture through `track()`/`trackError()`
  from `consent.js`; never reference PostHog directly; never capture pre-opt-in;
  never weaken banner/revoke. Aggregates only (§12). `POSTHOG_INIT_OPTIONS` stays
  mutable.
- **`roomRef()` stays the sole room path choke point.** Every read/write/
  subscribe/transaction routes through it.
- **Transactions stay the ONLY non-`update()` writes.** Now there are two
  (`claimTeamSlot`, `claimBuzz`); both are the promoted arbitration primitive.
- **Throttle ≤4 writes/s per writer.** Cadence and any live mirror obey the
  dirty-flag + 250 ms pattern, canceled on phase change.
- **Clocks never ticked through Firebase.** Score clock = the single-writer
  `currentStep` integer; local clocks are cosmetic + bust-deadline only (§1.4).
- **Reveal-flip identical-shape race invariant.** Both the buzz-win flip and the
  bust flip compute from an atomic snapshot via `settleFlip`; absolute totals,
  never increments (§4.3).
- **Pure/glue split.** Decision logic in `flag.js` (tested); `flag-ui.js` /
  `screen-flag.js` stay thin. Every feature ships tests + instrumentation.
- **Passive TV.** The TV writes only `screenHeartbeat`; it never gains authority
  or a timer (owner constraint #2).
- **`hostTeam`-rotation, `nextRoom`+`followedCodes`, S7 skew-proof liveness, S6
  auto-advance** all reused verbatim.
- **Session-replay masking** for any new screen rendering a team name or room
  code (`data-ph-mask`); update the replay-mask checklist in the same change.
- **No build, no deps, no server; degrade offline/`file://`** — hence vendored
  flag SVGs (§8), not a CDN hot-link.
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
   integer*, not any device clock — stronger than "skew-tolerant." Local clocks
   are cosmetic + bust-deadline only.
6. **Vendor the flag SVGs (§8).** The brief left CDN-vs-vendor open; the
   offline/`file://` rule decides it: vendor.
7. **The extraction framing (§9).** The brief says the kernel "needs a
   claim/arbitration primitive." Sharpen: the *mechanism* already exists
   (transactions); what the experiment forces is (a) *promoting* it to a named
   first-class peer of the disjoint-path rule, and (b) discovering a *hard
   ceiling* on privacy (render-deep only). Two distinct findings, one of them a
   boundary/negative result.
```
