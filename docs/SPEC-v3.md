# FLAG REVEAL — implementation-ready spec (v3)

*Architect/designer deliverable, 2026-08-23. Design-only: no GeoParty repo
changes. Register follows `geoparty/docs/architecture.md` — plain and direct.
This is v3: a revision of `SPEC-v2.md` incorporating the external
engineering-manager review of v2 (APPROVE WITH CHANGES: product design 8.5/10,
architectural clarity 8/10, distributed correctness 5/10, implementation
readiness 6/10). See "v3 changes" below. The EM found three
distributed-systems correctness blockers in v2's critical path and recommended
a redesign; v3 adopts that redesign wholesale rather than patching the old
design three times.*

A flag-guessing party game for a family/group around a TV, each with a phone.
Static no-build GitHub Pages + Firebase RTDB, no server code — the same
constraints, the same pure/glue discipline, and (almost) the same sync kernel as
GeoParty. This document is written so an engineer can implement from it alone.

The headline is unchanged: Flag Reveal deliberately breaks **two** GeoParty
invariants at once — *zero hidden information* and *writers never contend on the
same path* — which is the whole point of building it. What v3 changes is *how*
the contention is arbitrated: v2 transactionally claimed a buzzer and then
non-transactionally resolved the round, which the EM showed is not correct.
v3 transacts **the round's terminal outcome** — win or bust — over one tiny
authoritative subtree. §9 maps exactly where the extraction hypothesis holds and
where it breaks, now sharpened to a single **epoch-guarded terminal-state
arbitration** primitive.

---

## v3 changes (what changed from v2, and why)

Every item below is driven by the external EM review. Blockers first.

1. **Terminal-outcome transaction redesign — fixes EM blockers 1, 2, 3
   (§2/§3/§4/§11).** v2's `claimBuzz` transacted only `round/buzz` and then
   resolved the round with a non-transactional `update()`. That created three
   correctness failures the EM called blockers:
   - **Blocker 1 — the v2 epoch guard was not epoch-guarded.** `claimBuzz`
     could not see authoritative `round.number`; "claim if vacant or stale"
     compared the *claimant's* epoch to the *existing claim's* epoch, so a
     delayed round-N retry seeing a legitimate round-(N+1) claim would judge the
     *current* claim stale and overwrite it with the old N claim.
   - **Blocker 2 — a correct ring and a bust could race to different
     outcomes.** `roundConduct` read `buzz === null`, decided *bust/all-zero*,
     and pushed a settlement; meanwhile a correct player could commit
     `claimBuzz` → *winner/points*. Nothing serialized those two
     **phase-changing** decisions; last write won. The "identical-shape race is
     harmless" argument never applied — the two outcomes are deliberately not
     identical.
   - **Blocker 3 — a delayed round-N settlement could mutate round N+1.**
     Settlement was a multi-path `update()` carrying a round number in its
     *data*, not gated on a *compare-against-current-epoch condition*. A delayed
     patch could write `phase: reveal`, an old absolute total, and old results
     into the fresh round.

   v3's fix (the EM's recommended redesign): put the small authoritative
   gameplay state under **one transaction boundary** (`gameState/`) and transact
   the **resolution** itself. A correct ring runs a transaction that commits only
   if `phase === roundActive`, `round.number === myRound`, and `outcome === null`;
   a bust runs the same transaction attempting `{kind:"bust"}`. Whichever
   terminal outcome serializes first wins; a stale-N operation encountering N+1
   simply aborts; a duplicate fallback is idempotent; an old settlement
   *physically cannot* overwrite the new state. All three blockers dissolve by
   construction. `round/buzz` and `claimBuzz` are removed; `round/outcome` and
   `resolveRound`/`advanceRound` replace them.

2. **`atStep` now comes from the transaction snapshot, not the client
   (§1.3/§1.4/§4).** v2 scored a win at the ringer's *last-received*
   `currentStep`, then claimed stale propagation was bounded to one step and
   symmetric — neither is guaranteed. A lagging phone can be several updates
   behind and network latency is asymmetric; in primary-TV mode a player can
   watch the TV show step 5 while their phone believes step 3 and then be scored
   at step 3 — visible unfairness. The winner transaction now reads `currentStep`
   from the **server-side transaction snapshot**, so scoring uses the same
   authoritative step everyone sees. (EM "I would redesign the critical path.")

3. **Fallback deadlines use server-corrected time, not raw `Date.now()`
   (§1.4/§4.4).** v2's non-owner dead-man deadline was `startedAt +
   … + Date.now()`; a fast client clock could bust *early* and change the
   outcome, not merely change *when* an identical outcome occurs. v3 computes all
   deadline/grace checks against `serverNow()` derived from Firebase's
   `.info/serverTimeOffset`, and authors `startedAt`/`stepStartedAt` with server
   timestamps. Cross-client skew can no longer flip an outcome. (EM "The fallback
   clock claim is similarly overstated.")

4. **Easy-mode game-theory bug fixed (§1.3/§1.7).** With four choices and the
   max-1000 curve, a blind step-1 guess had EV `0.25 × 1000 = 250`, beating the
   125 for waiting to the fully-revealed flag — the mechanic paid for exactly the
   random early smash the product says it doesn't want. v3 keeps choices
   **disabled until `choiceUnlockStep` (default 5)** in `inputMode:"choice"`, and
   documents an alternate gentler curve (max ≈500) as a locked config. No
   negative scores (lockout remains the cost). (EM "game-theory bug in easy
   mode.")

5. **Typeahead race acknowledged (§1.3).** The default typeahead makes the buzzer
   partly a typing/autocomplete race, not solely a recognition race — "Brazil"
   commits faster than "Bosnia and Herzegovina." v3 states this plainly, no
   longer calls the winner "simply the first to recognize the flag," and flags
   the input surface as a **prototype-before-baking-constants** item. (EM
   "typing/autocomplete race.")

6. **Reveal-phase fallback writer added — dead-owner-during-reveal corner
   rejected (§4.4/§7/§11).** v2 accepted a dead reveal owner permanently
   stalling the game as "GeoParty parity." The EM rejected that: "parity with the
   existing product is an architectural argument, not a reason to leave a party
   game frozen," and noted that with proper epoch-guarded terminal arbitration a
   delayed any-phone `reveal → nextRound` fallback is not scary. v3 adds an
   epoch-guarded, idempotent `advanceRound` transaction runnable by any phone
   after a reveal-phase dead-man deadline. Only the narrow *held-then-owner-dies*
   and *game-over-handoff* corners remain (§4.4).

7. **Analytics holes fixed (§12).** `flag_round` claimed "bust rate by difficulty
   tier" without a `difficulty` property; neither event recorded `inputMode`;
   `ringCount` cannot be reconstructed from persisted state because losing
   *correct* claimants abort their transaction and are stored nowhere; and the
   one-per-round emitter was unspecified (risking one `flag_round` per phone). v3
   adds `difficulty` and `inputMode` to both events, adds a non-identifying
   deterministic `roundKey = hash(gameSeed, number)` for downstream
   dedup/reconstruction, reconstructs `ringCount` from de-duplicated `flag_ring`
   events, and names the single emitter: the phone whose `resolveRound`
   transaction **committed** (exactly-once by serialization). (EM "spec holes.")

8. **Config locked and versioned at game start (§2/§8).** Deterministic
   derivation only stays deterministic if every client shares pool, ordering,
   hash/PRNG, and settings. v3 locks `difficulty`, `inputMode`, all scoring
   params, `roundCount`, `target`, `gridN`, `stepMs`, plus `datasetVersion` and
   `rulesVersion` in `settings` at game creation (immutable thereafter),
   **canonically sorts the pool by ISO before the seeded shuffle**, and specifies
   a version-compatibility check (a client whose bundled dataset/rules version
   differs from the room's refuses to derive). (EM "lock … when the game
   begins.")

9. **Smaller details nailed down (§8):** clamp `roundCount` to the eligible pool
   size; `gridN` default 4, range 3–6; `Map<normalizedName, iso[]>` collision
   handling for ambiguous aliases ("Congo", "Korea"); an explicit
   country-eligibility predicate; and a fixed reveal-canvas + `object-fit:
   contain` rule so nonstandard aspect ratios (Nepal, Switzerland, Vatican,
   Qatar) tile cleanly. (EM "smaller implementation details.")

10. **`file://` contradiction resolved (§8.2/§13).** GeoParty's README says local
    dev needs an HTTP server because ES modules do not run from `file://`, yet v2
    used graceful `file://` operation as a hard reason for vendoring. v3 restates
    the requirement as **"works offline once served/cached"** (HTTP origin +
    cache, never literal `file://`), which is honest for any ES-module app.
    Vendoring the flags stays — but justified by offline-cache and no-CDN, not by
    `file://`. (EM "the `file://` contradiction.")

11. **Data licensing stated, not buried (§8.3).** `mledoze/countries` is ODbL;
    `flag-icons` is MIT. A reduced `flags.json` derived from the ODbL database
    carries ODbL attribution + share-alike independently of the app-code license;
    the vendored SVGs carry MIT notices. v3 adds an explicit licensing section and
    a shipped `data/ATTRIBUTION.md`. (EM "data licensing.")

12. **§9.4 net conclusion revised (§9).** The EM: v2's claim that the extraction
    hypothesis "holds for every synchronization mechanism" is too strong; the
    experiment actually uncovered that the reusable primitive is an
    **epoch-guarded terminal-state arbitration primitive**, not merely an
    epoch-guarded buzzer claim. §9.2/§9.4 are rewritten around the unified
    claim/bust/settlement/advance model.

**Preserved from v2 (EM-approved, do not regress):** the private wrong-ring →
full-disclosure-at-reveal decision (§5/§10); the TV topology ("everyone always
has a phone; TV presence merely changes where the reveal is rendered", §0/§6);
the deterministic `gameSeed`, repeat-free game sequence, and deterministic
easy-mode alternatives (§8); the pure/glue split, the phase machine, and the
extraction framing of §9.

---

## 0. The one clarification the first-pass got blurry — topology vs. mode

*(Unchanged from v2; EM-approved. Restated because it anchors everything.)*

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

- **Mode = is a TV present?** Purely a *rendering* question, decided by
  `screenHeartbeat` liveness, changing **no authority and no writer**:
  - **Couch-with-TV (PRIMARY).** A TV subscribes and renders the big progressive
    reveal. Phones become lean buzzers (they still *can* render a minimal reveal,
    but eyes are on the TV).
  - **Everyone-plays (FALLBACK, no TV).** Each phone renders its own reveal from
    the identical `currentStep` feed. Same logic, minus the shared screen. Copy
    adapts on `screenHeartbeat` presence — exactly the pattern h2h phones use
    today.

This satisfies owner constraint #1 (TV always connectable, both modes) *for
free*: the TV connects by subscribing and rendering `currentStep`. It satisfies
#2 (TV is a passive renderer, writes only `screenHeartbeat`) because the reveal
cadence is owned by the `hostTeam` phone, never the TV. It satisfies #3
(winner-becomes-host) because the reveal owner *is* the `hostTeam`, which rotates
to the winner. The three owner constraints collapse into "reuse h2h's `hostTeam`
model and treat the TV as one more subscriber."

> **Correction to the brief:** §1.12 frames couch as "host phone is the buzz-in
> surface" and everyone-plays as "each phone renders its own reveal." That
> conflates *who buzzes* (always: everyone, on their own phone) with *who renders
> the reveal* (TV if present, else each phone). Buzzing is always per-phone. The
> only thing the TV's presence changes is the reveal renderer.

---

## 1. Game rules (complete)

### 1.1 Setup and lobby

- A player creates a room (6-letter code, no I/O — reuse GeoParty's generator and
  `isValidRoomCode`). `mode: "flag"`. At creation the creator writes: the
  room-level `gameSeed` (§8), the **locked** `settings` block (§2/§8, immutable
  for the whole game), and `datasetVersion`/`rulesVersion` (§8.1). Then it writes
  `gameState/phase: lobby`.
- Each additional player joins by code and claims a slot via
  `claimTeamSlot(code, tN, {name, deviceId, total:0})` — a transaction on
  `gameState/teams/tN` (§3). Up to 4 slots (`t1..t4`), matching GeoParty's cap;
  more is a settings knob but 4 keeps the TV render cheap and the transaction
  contention meaningful.
- Optionally a TV joins by code and just subscribes; it writes only
  `screenHeartbeat`.
- The room creator is the initial `hostTeam` (reveal owner). Thereafter it
  rotates to the previous game's winner (§7).

### 1.2 Round loop (one flag)

1. **Round start.** The reveal owner runs `advanceRound` (§3/§4), which
   transactionally sets `gameState` to a fresh round: `phase: roundActive`,
   `round = { number, flagSeed, answerIso, startedAt(server ts), currentStep: 1,
   stepStartedAt(server ts), outcome: null, results: {}, private: {} }`.
   `answerIso` is embedded at round start so every phone self-scores its own
   guess (same accepted posture as GeoParty's embedded `truth`: devtools-peeking
   is not a threat we carry). `flagSeed` and `answerIso` for round *k* are pure
   functions of `(gameSeed, k)` (§8), so an owner refresh mid-game re-derives the
   identical flag rather than resampling.
2. **Progressive reveal.** The flag is revealed across **`STEPS = 8`** steps: a
   tile grid de-occludes *and* a parallel blur→sharp track sharpens. The reveal
   owner advances the step every `stepMs` (default 1500 ms) by a **plain
   throttled write** of `{currentStep, stepStartedAt(server ts)}` to
   `gameState/round` — one small write per 1.5 s, far under the 4/s throttle.
   **The step number is the clock** (§1.4). A concurrent resolution transaction
   simply re-runs against the fresher `currentStep` (§4).
3. **Ring in.** At any time a player commits a guess (a country) on their phone.
   That commit *is* the ring. Correctness is evaluated locally against the
   embedded `answerIso` (§1.6):
   - **Correct →** attempt `resolveRound(code, {kind:"win", team: tN,
     roundNumber}, cfg)` (§4). If it commits, this player wins the round and the
     transaction *itself* has already flipped the room to `reveal`, settled
     totals, and stamped results — there is no separate settlement write. If it
     aborts, read `outcome`: a pre-existing `win` → show "too late — someone rang
     first"; a `bust` or an advanced `round.number` → "round over."
   - **Wrong →** the phone locks *itself* out for the round and writes its private
     lockout to `gameState/round/private/tN` (§5). No renderer and no other
     phone's live decision reads it (§5.2). The reveal continues.
4. **Bust.** If the reveal completes (`currentStep === STEPS`) plus a grace
   window (`graceMs = 3000`) with no correct ring, the round **busts**: the owner
   (and, as fallback, any non-owner phone past the dead-man deadline) attempts
   `resolveRound(code, {kind:"bust", roundNumber}, cfg)`. The transaction settles
   zero points to everyone, sets `outcome: {kind:"bust"}`, and flips to `reveal`
   showing the full flag and the answer (§1.5). Win and bust are competing
   terminal outcomes of the *same* transaction boundary; the first to serialize
   wins (§4).
5. **Reveal + advance.** `phase: reveal` shows the full flag, the answer, who won
   (or "nobody"), the points awarded, updated standings, and the wrong-ring
   comedy beat (§5.3). Soft auto-advance (S6 machine, reused) counts down; the
   reveal owner may hold it (`autoAdvanceAt: null`). Advance to the next round
   (or `gameOver`) is the epoch-guarded `advanceRound` transaction, runnable by
   the owner **or**, past the reveal-phase dead-man deadline, any non-owner phone
   (§4.4).

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

#### The typeahead is partly a typing race — acknowledged (v3)

A correctness note the EM rightly insisted on stating: with a typeahead, the
buzzer is **not solely a recognition race — it is partly a typing/autocomplete
race**. A player who instantly recognizes "Bosnia and Herzegovina" can lose to a
player who recognizes "Brazil" slightly later, because "Brazil" reaches an
unambiguous commit in far fewer keystrokes/interactions. This is not necessarily
wrong for a party game (fast decisive input is itself a skill), but the spec must
**not** describe the transaction winner as "simply the first person who
recognized the flag." What actually wins is *the first person to drive a correct
ISO to commit*, which folds recognition speed together with input speed.

Consequences and mitigations, to be validated by prototype:

- **Prototype the input surface before baking scoring constants into
  architecture.** `stepMs`, `STEPS`, `BASE`, and `choiceUnlockStep` should be
  tuned against a real typeahead prototype (how many steps does a typical commit
  actually span?), then locked (§8.1). Treat the numbers in §1.7 as provisional
  defaults, not settled truth.
- Mitigations available without changing the architecture: rank the autocomplete
  by prefix + popularity so the common answer is the first Enter-able row; allow
  commit-on-first-exact-prefix; and note that `inputMode:"choice"` removes the
  typing race entirely (a tap), which is one more reason it exists for kids.
- Whatever the input surface, **`atStep` is the authoritative snapshot step**
  (§1.4), so input latency costs a player *time-to-commit* but never introduces
  clock-skew scoring errors.

#### Easy-mode `inputMode:"choice"` — 4 options, identical across phones, unlocked late (v3)

When `inputMode === "choice"`, every phone renders the **same 4 options** so no
player gets an easier set. The options are derived **deterministically from
`flagSeed`** (never sampled locally): `chooseOptions(flagSeed, answerIso, pool) →
[iso, iso, iso, iso]` — the correct ISO plus 3 same-tier distractors, then the 4
order-shuffled, all by a `flagSeed`-seeded shuffle. Because it is a pure function
of `flagSeed` (embedded in `round`), every phone and the TV compute an identical
option list and order, and an owner refresh reproduces it exactly.

- **Options are visible but disabled until `choiceUnlockStep` (default 5).**
  v2 let a choice be committed from step 1. The EM's game-theory analysis: with
  the max-1000 curve, a blind step-1 pick has EV `0.25 × 1000 = 250`; a blind
  step-4 pick `0.25 × 625 = 156.25`; waiting to the fully revealed flag at step 8
  gives 125 with near-certainty. So the dominant strategy was *smash a random
  answer early* — exactly what the product rejects. **Fix:** the four buttons
  render greyed with "look at the flag first!" until `currentStep >=
  choiceUnlockStep`, after which they are tappable. At `choiceUnlockStep = 5` a
  blind pick has EV `0.25 × scoreRing(5) = 0.25 × 500 = 125`, equal to the
  near-certain reward for identifying the fully revealed flag, and it *risks the
  round's lockout* (§1.7) — so blind-smashing is dominated by waiting-to-identify,
  and identifying earlier than step 5 is impossible in choice mode. Recognition
  skill (identify at 5–6 with confidence) is what pays.
- **Alternate, config-selectable:** a gentler `choice`-mode scoring profile
  (`base ≈ 500`) instead of the late unlock, per the EM's either/or. v3 ships the
  **late-unlock** default (one knob, standard curve) and documents the gentler
  curve as a locked alternate (§1.7/§8.1). No negative scores are introduced;
  lockout is the nicer mechanic (EM).

The ring is committed the instant the player confirms a selection. The step used
for scoring (`atStep`) is **not** read from the client at all in v3 — it is the
`currentStep` present in the winning transaction's server snapshot (§1.4/§4).

### 1.4 The clock is the step number, read from the transaction snapshot (v3)

GeoParty's discipline is "all countdowns render from `endsAt − Date.now()` on the
local clock; time is never ticked through Firebase." Flag Reveal keeps the spirit
and sharpens it further than v2:

- **Scoring authority = `currentStep` in the winning transaction's snapshot.**
  `currentStep` is a single-writer cadence integer (the reveal owner). A win's
  `atStep` is the value of `gameState/round/currentStep` that the *server-side
  transaction* reads at commit — **not** the ringer's last-received value. This
  removes the v2 unfairness the EM flagged: a lagging phone (multiple updates
  behind, asymmetric latency) can no longer be scored at a stale low step while
  the TV visibly shows a higher one. Everyone is scored at the same authoritative
  step the shared screen is showing.
- **Visual interpolation = local clock, cosmetic only.** Between step writes, a
  phone/TV may animate the blur track using `serverNow() − stepStartedAt` for a
  fluid feel. Never feeds scoring.
- **Owner bust trigger = step completion, not wall-clock.** The reveal owner is
  also the cadence writer, and mobile browsers throttle background-tab timers.
  So the owner must **not** bust on a wall-clock formula (a briefly backgrounded
  owner would stall `currentStep` and bust a round that was never fully
  revealed). Instead the owner attempts a bust only when `currentStep === STEPS`
  *and* `serverNow() ≥ stepStartedAt + graceMs` (grace measured from the *final*
  step's `stepStartedAt`). The step integer, not the wall clock, gates the
  owner's bust attempt; the transaction then arbitrates it against any concurrent
  win (§4).
- **Fallback bust deadline = server-corrected time from the authored
  `startedAt`.** Every *non-owner* phone (the dead-man fallback) computes
  `bustAt = round.startedAt + STEPS·stepMs + 3·graceMs` and attempts a bust only
  if `serverNow() ≥ bustAt` and no outcome exists. **`serverNow()` = `Date.now()
  + serverTimeOffset`**, where `serverTimeOffset` is read from Firebase's
  `.info/serverTimeOffset`. This is the v3 fix to the EM's "fallback clock"
  objection: a raw-`Date.now()` fast client could bust *early* and change the
  outcome; a server-corrected clock cannot. The `×3 graceMs` offset (mirroring
  the forfeit sweep) keeps the owner winning the bust race in the common case,
  and the transaction guarantees a single terminal outcome regardless.
- **Accepted behavior of a stalled-but-alive owner:** if the owner's tab is
  throttled but its connection is live, steps freeze at a cheap step, rings at
  that step score high (players are not penalized), and — because the owner never
  reaches `currentStep === STEPS` — the round ends only when a correct ring's
  transaction commits, or when a non-owner's server-corrected fallback deadline
  arrives. Fine; state it, don't defend against it.

> **Residual, accepted (smaller than v2's):** because `atStep` is the snapshot
> step, a fast ringer whose transaction commits just after a cadence advance is
> scored at the *newer* (higher) step — costing at most one step (~125 pts). This
> is bounded to ±1 step of commit latency, symmetric across players, and — unlike
> v2 — always consistent with the step the TV is showing, so it is never
> *visibly* unfair. This strictly improves on v2's "score at the client's stale
> step."

### 1.5 Bust

- **Trigger (owner):** `phase === roundActive`, `outcome === null`,
  `currentStep === STEPS`, and `serverNow() ≥ stepStartedAt + graceMs` (§1.4).
  Owner attempts `resolveRound({kind:"bust", roundNumber})`.
- **Trigger (fallback, any non-owner phone):** `phase === roundActive`,
  `outcome === null`, and `serverNow() ≥ round.startedAt + STEPS·stepMs +
  3·graceMs`. Same `resolveRound({kind:"bust", …})` attempt.
- **The TV never triggers a bust** (it runs no `roundConduct`, §4.4/§6).
- **Arbitration:** the bust attempt is the *same transaction* a win uses. If a
  win has already committed (`outcome.kind === "win"`), the bust updater sees a
  non-null outcome and aborts — no all-zero settlement can clobber a winner
  (**this is the fix to EM blocker 2**). If the bust commits first, a later
  correct ring's win transaction aborts on the non-null bust outcome.
- **Effect (bust):** `outcome: {kind:"bust"}`, `phase: reveal`, every
  `results/tN` = `{correct:false, points:0, rangOut:<from private?>, wrongIso,
  wrongStep}` (§4.3/§5.3), no team total changes — all written atomically by the
  transaction.
- The reveal shows the full flag and the answer so the busted round still *pays
  off as a reveal* ("ohh, it was Chad!"), plus any wrong-ring comedy beats
  disclosed from `private/*` at settlement (§5.3).

### 1.6 Answer normalization and alias collisions (v3)

Pure `normalizeAnswer(guess, answerIso, aliases) → bool`, and the same
normalization builds the autocomplete index:

- Fold case, trim, collapse internal whitespace, strip diacritics
  (`"Côte d'Ivoire"` → `"cote divoire"`), drop a leading `"the "`.
- Match against the country's English name **and** its alias list (`"USA"`,
  `"United States"`, `"America"`, `"UK"`, `"Britain"`, `"Burma"`↔`"Myanmar"`,
  `"Holland"`↔`"Netherlands"`, etc.).
- Because the commit surface resolves to an ISO before ringing, the *win-path*
  check is `committedIso === answerIso`. `normalizeAnswer` earns its place by
  (a) building the index and (b) supporting an optional typed free-text mode.

**Collision handling (v3 — `Map<normalizedName, iso[]>`).** Some normalized
strings map to more than one ISO — the classic cases are "Congo" (Republic of
the Congo `CG` vs. Democratic Republic of the Congo `CD`), "Korea" (`KR`/`KP`),
"Guinea" (`GN`/`GW`/`GQ` as bare "guinea"), and any bare form of a
compound-named pair. Canonical country *names* are unique by construction, but
*aliases* can collide. Rule:

- `buildAnswerIndex(dataset) → Map<normalizedName, iso[]>` — the value is an
  **array**; a normalized key with `length > 1` is a collision.
- **Typeahead (default):** a colliding normalized entry is expanded into
  **distinct disambiguated options**, one per ISO, each with a clarifying label
  ("Congo – Dem. Rep." → `CD`; "Congo – Rep." → `CG`). The user selects one; the
  committed ISO is unambiguous. A bare collision string is therefore never a
  single resolvable typeahead row.
- **Free-text mode (optional):** a bare colliding guess is accepted iff
  `answerIso ∈ index.get(normalized)` — i.e. "congo" is counted correct when the
  answer is *either* Congo. This is deliberately lenient (a party call) and is
  documented as such; it applies only to the optional free-text mode, never to
  typeahead or choice.
- The autocomplete index build has a test asserting every colliding key produces
  distinct, labeled, single-ISO options (no colliding key is ever offered as one
  ambiguous row).

### 1.7 Scoring

```
scoreRing(atStep, steps, base, min) =
    max(min, round(base × (steps − atStep + 1) / steps))
```

Defaults (**typeahead / world tier**): `BASE = 1000`, `MIN = 100`, `STEPS = 8`.

| atStep | points |
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
speed-within-step bonus** (this keeps scoring clock-skew-immune). `MIN` is a
floor that only binds under non-default configs; a late-but-correct ring is never
worth zero (zero is reserved for busts and wrong rings).

- **`atStep` is the winning transaction's snapshot step (§1.4)** — the scoring
  input is server-authoritative, not client-supplied.
- **Easy mode (`inputMode:"choice"`):** the same curve applies, but options are
  disabled until `choiceUnlockStep` (default 5), so the *effective* choice-mode
  range is 500 (step 5) down to 125 (step 8) — which is what closes the
  game-theory hole (§1.3). Alternate locked config: `scoreProfile:"gentle"` sets
  `base = 500` and unlocks from step 1, giving a max of 500 with a smoother curve
  (EM's either/or). Ship the late-unlock default; treat the choice of profile as
  a locked, prototype-tuned setting (§8.1).
- **Wrong ring: zero, and locked out for the round** — the cost is opportunity,
  not a negative score (§10). No negative scores in v3 (EM).

### 1.8 Win condition

Dual, driven by locked settings:

- `target > 0`: **first team to reach `target` total** ends the game immediately
  at the reveal that crosses it.
- else (`target === 0`, the default): **highest total after `effectiveRoundCount`
  flags** (§8, where `effectiveRoundCount = min(roundCount, eligiblePoolSize)`).

`gameWinner(teams, {target, roundNumber, roundCount})` is a **pure,
deterministic fold computed locally on every device** (no write, exactly like
h2h `gameWinner` / Crown Night). Tie-break, in order: highest total → fewest
rounds taken to reach that total (`reachedTotalAt`, settled with each win) →
lowest slot id `tN`. Because it is deterministic on identical data and every
client shares the locked settings/version (§8.1), the game-over crown needs no
write; the `reveal → gameOver` transition is the same `advanceRound` transaction
(§4.4) so it is still epoch-guarded.

Defaults: `roundCount = 10`, `target = 0`. A "race to 5000" variant is
`target = 5000` with `roundCount` high (still clamped to pool size).

### 1.9 Modes (rendering only — restated for completeness)

Both modes run the identical writer set. The reveal owner writes cadence; the TV,
if present, renders it; if absent, each phone renders it. The mode is detected
per device from `screenHeartbeat` liveness (stamped on the *receiver's* own clock
at receipt, ancient-beat-ignored — GeoParty's skew-proof S7 rule, reused). See
§6.

---

## 2. RTDB data model

Everything lives under `rooms/{CODE}`, composed once by `roomRef()` — unchanged,
still the single choke point for every read/write/subscribe/transaction. **v3's
structural change:** the small authoritative gameplay state lives under one
subtree, **`gameState`**, which is the boundary of the resolution/advance
transactions (§4). Room-level, immutable-during-game fields sit outside it.

```
rooms/{CODE}
  createdAt          ms epoch (existing rule: ≤ server now + 5 min skew)
  mode               "flag"
  gameSeed           deterministic game-level seed (whole flag sequence; §8) — immutable in-game
  datasetVersion     dataset (flags.json) version — LOCKED at creation (§8.1)
  rulesVersion       scoring/derivation algorithm version — LOCKED at creation (§8.1)
  settings           LOCKED at game start, immutable for the whole game (§8.1):
                     { roundCount, target, stepMs, gridN, revealAspect,
                       base, min, steps, choiceUnlockStep, scoreProfile,
                       difficulty ("easy"|"world"|"expert"),
                       inputMode ("typeahead"|"choice") }
  hostTeam           tN — reveal owner; rotates to the winner per GAME (§7)
  screenHeartbeat    ms epoch — the ONLY thing the TV writes (unchanged)
  nextRoom           pointer into a FINISHED room → subscribers follow (unchanged)

  gameState          ← the authoritative subtree; the resolution/advance TRANSACTION boundary (§4)
    phase            lobby | roundActive | reveal | gameOver
    round
      number         1-based
      flagSeed       per-round reveal/option seed = hash(gameSeed, number) (§8) — set at round start
      answerIso      ISO-3166-1 alpha-2, embedded at round start (self-scoring)
      startedAt      SERVER timestamp — authored at round start (bust-clock anchor)
      currentStep    1..STEPS — SINGLE-WRITER cadence integer (the clock); plain throttled write
      stepStartedAt  SERVER timestamp of the current step (interpolation + owner bust gate)
      outcome        null | {kind:"win", team, atStep} | {kind:"bust"}
                     ← the TERMINAL state; set ONLY by the resolveRound TRANSACTION (§4)
      results/tN     { correct, points, atStep, rangOut, wrongIso, wrongStep }
                     ← written ONLY by the resolveRound transaction (atomic with outcome)
      private/tN     { lockedRound, wrongStep, wrongIso }
                     ← own-phone plain write on a wrong ring; read ONLY by the resolveRound
                       transaction (to disclose at reveal) and by the owning phone on resume (§5)
      revealAt       countdown target, set by the resolveRound transaction (S6, reused)
      autoAdvanceAt  revealAt + 15s; null = the reveal owner held it (owner plain write; S6)
    teams/t1..t4     { name, deviceId, total, reachedTotalAt }
                     name/deviceId via claimTeamSlot (transaction on gameState/teams/tN);
                     total/reachedTotalAt via the resolveRound transaction (absolute settlement)
```

Notes:

- **The `round/buzz` path and `claimBuzz` are removed (v3).** The contended
  concept is no longer "claim a buzzer then resolve"; it is "transact the
  terminal `outcome`." A correct ring writes `outcome: {kind:"win", …}` *through*
  the resolution transaction, which also settles results/totals/phase atomically.
- **Why one subtree:** the resolution transaction must atomically read
  `currentStep` (for `atStep`), read `private/*` (for disclosure), check
  `phase`/`round.number`/`outcome`, and write `outcome`, `results/*`, `phase`,
  and `teams/*` totals. All of those must be in **one** transactable ref, and the
  common ancestor of `round` and `teams` is `gameState`. It is tiny; one
  transaction per round-ending event is not extravagant (EM).
- **Plain writes into `gameState` children are fine.** Cadence
  (`currentStep`/`stepStartedAt`), wrong-ring `private/*`, and the S6 hold
  (`autoAdvanceAt: null`) are single-owner/own-phone plain writes to children of
  the transacted ref. A plain write concurrent with an in-flight resolution
  transaction simply causes Firebase to **re-run** the updater against the
  fresher snapshot (desirable — it picks up the latest `currentStep`). Firebase
  re-runs the update function against newer server state on concurrent writes;
  that is exactly the behavior the resolution transaction relies on.
- **`gameSeed`, `settings`, `datasetVersion`, `rulesVersion`, `hostTeam`** are
  written once (at creation / at host rotation) and never mutated during the
  game, so they are *not* in `gameState` and are passed to the pure resolution
  functions as `cfg` (§3). Round *k*'s `answerIso`/`flagSeed` are pure functions
  of `(gameSeed, k)`; an owner refresh re-derives the identical round.
- **Ownership:** `results/*` and `teams/*` totals are **transaction-owned**
  (single committed writer per round-ending event) — no divergence possible on
  the settled fields. `private/tN` is own-phone-written; `currentStep`/
  `stepStartedAt` cadence is single-owner; `name`/`deviceId` is `claimTeamSlot`.
- Old/other clients ignore unknown paths (additive-path convention, unchanged).

---

## 3. Module seams (pure/glue split preserved)

Mirrors GeoParty's layout: decision logic in a new **pure, tested** module; DOM +
Firebase glue in thin `*-ui.js` files; the transaction helpers beside
`claimTeamSlot` in `firebase.js`.

### New pure module — `js/flag.js` (tested, no DOM, no network)

- `gameFlags(gameSeed, effectiveRoundCount, difficulty, pool) → [iso, …]` and
  `flagForRound(gameSeed, number, …) → { answerIso, flagSeed }` — deterministic
  derivation of the whole game's flag sequence from `gameSeed` over the
  **canonically ISO-sorted** eligible pool (§8.1); repeat-free within a game;
  easy-first-round guard; so a refresh resumes free.
- `revealPlan(flagSeed, steps, gridN) → { tileOrder:[…], blur:[…] }` — seeded
  shuffle of `gridN²` tile indices partitioned into `steps` groups, plus a
  monotonic-decreasing blur schedule (default `20px → 0` across `steps`). Pure
  data; the UI paints pixels onto the fixed reveal canvas (§8.4).
- `exposedAt(plan, step) → { tiles:number[], blurPx:number }` — which tiles are
  de-occluded and the blur at step `k`. Pure.
- `chooseOptions(flagSeed, answerIso, pool) → [iso, iso, iso, iso]` — easy-mode
  option set (§1.3): correct ISO + 3 same-tier distractors, order-shuffled, all
  by a `flagSeed`-seeded shuffle → identical on every device. Pure.
- `choiceUnlocked(currentStep, cfg) → bool` — whether choice buttons are tappable
  yet (`currentStep >= cfg.choiceUnlockStep`), the game-theory gate (§1.3). Pure.
- `scoreRing(atStep, steps, base, min) → points` (§1.7).
- `normalizeAnswer(guess, answerIso, aliases) → bool` (§1.6); also
  `buildAnswerIndex(dataset) → Map<normalizedName, iso[]>` for the autocomplete,
  with collision handling (§1.6).
- **`resolveOutcome(gameState, attempt, cfg) → gameState' | undefined`** — the
  pure core of the resolution transaction (§4). `attempt` is `{kind:"win", team,
  roundNumber}` or `{kind:"bust", roundNumber}`. Returns the full new `gameState`
  on success, or `undefined` to abort. Guards, settlement, disclosure, and
  `atStep = gameState.round.currentStep` all live here — unit-testable without
  Firebase. This replaces v2's `adjudicateBuzz` + `settleFlip` with **one**
  function, since claim and settlement are now one atomic step.
- **`advanceState(gameState, fromRound, cfg) → gameState' | undefined`** — the
  pure core of the advance transaction (§4.4): `lobby → roundActive` (round 1)
  and `reveal → (roundActive | gameOver)`. Epoch-guarded (`phase`,
  `round.number`); idempotent; deterministic (fresh round derived from
  `(gameSeed, fromRound+1)`; `gameOver` decided by `gameWinner`). Returns the
  full new `gameState` or `undefined`.
- `roundConduct(gameState, serverNow, isOwner, cfg) → "continue" | "resolve-win"
  | "resolve-bust" | "advance"` — the pure decision function each phone runs on
  every snapshot to decide *whether* to attempt a transaction (§4.4). `isOwner`
  selects the owner's step-completion bust vs. the non-owner's server-corrected
  dead-man deadline; also drives the reveal-phase advance fallback.
- `gameWinner(teams, cfg) → tN | null` and `carryStandings(teams, winnerTeam) →
  {teams, hostTeam}` for game-over → next room (§7).
- `versionCompatible(room, bundled) → bool` — `room.datasetVersion ===
  bundled.datasetVersion && room.rulesVersion === bundled.rulesVersion` (§8.1).

### New glue

- `js/flag-ui.js` — the player phone: lobby/slot claim, buzzer surface, reveal
  render (used when no TV), reveal-owner cadence loop when this phone *is*
  `hostTeam`, and the `roundConduct`-driven transaction attempts. Logic-light;
  every rule calls into `flag.js`. Reads `.info/serverTimeOffset` once and
  exposes `serverNow()`.
- `js/screen-flag.js` — the TV renderer: subscribes, renders `currentStep` via
  `exposedAt`, standings, winner, crown. Writes only `screenHeartbeat`. **Runs no
  `roundConduct` transactions** (owner constraint #2). No authority.

### `js/firebase.js` additions — the terminal-outcome arbitration primitive (v3)

```js
// v3: transact the ROUND'S TERMINAL OUTCOME (win OR bust) over the tiny
// gameState subtree. Epoch-guarded, idempotent, server-serialized. This REPLACES
// v2's claimBuzz. Only a phone that has evaluated its OWN guess as correct calls
// this with {kind:"win"}; the owner/fallbacks call it with {kind:"bust"}.
//
// The updater cannot flip a live outcome: it commits ONLY when phase is
// roundActive, round.number matches, and outcome is null. A stale-round op sees a
// mismatched round.number and aborts; a duplicate sees a non-null outcome and
// aborts. atStep is read from the SERVER snapshot's currentStep, never the client.
export async function resolveRound(code, attempt, cfg) {
  const res = await runTransaction(roomRef(code, "gameState"), (gs) =>
    resolveOutcome(gs, attempt, cfg));   // pure (flag.js); returns gs' or undefined
  return res.committed;
}

// v3: epoch-guarded, idempotent round advance (reveal -> roundActive|gameOver,
// and lobby -> roundActive for round 1). Runnable by the reveal owner OR, past
// the reveal-phase dead-man deadline, ANY non-owner phone (never the TV). The
// fresh round is a deterministic function of (gameSeed, number), so racing
// advancers agree; the transaction makes it happen exactly once.
export async function advanceRound(code, fromRound, cfg) {
  const res = await runTransaction(roomRef(code, "gameState"), (gs) =>
    advanceState(gs, fromRound, cfg));   // pure (flag.js); returns gs' or undefined
  return res.committed;
}
```

`roomRef` stays the only path composer; transactions stay the *only* non-`update`
writes. `claimTeamSlot` (verbatim) plus `resolveRound` and `advanceRound` are the
three transactional writes — all instances of the same **epoch-guarded
terminal-state arbitration** primitive (§9.2).

### Dataset — new repo only

`data/flags.json` in the **Flag Reveal repo** (never touch GeoParty's `data/`):
`{ iso2, name, aliases:[…], tier:"easy"|"world"|"expert", eligible:bool }[]`, plus
`data/ATTRIBUTION.md` (§8.3). See §8 for source, versioning, and the vendored-SVG
decision.

---

## 4. Concurrency: one transaction boundary, one terminal outcome (v3)

This is the redesigned core. §9 is the honest extraction map; this section is the
mechanism. The v3 principle, stated once: **every phase-changing write is an
epoch-guarded transaction over `gameState`.** There are exactly two such
transactions — `resolveRound` (roundActive → reveal, win or bust) and
`advanceRound` (lobby/reveal → roundActive/gameOver) — plus the untouched
`claimTeamSlot`. No phase-changing write is a bare `update()`.

### 4.1 First-CORRECT-terminal-outcome-wins, not first-to-act

The brief said the transaction claims "first." Sharpen it two ways:

- **Only a correct ring ever attempts a `win` outcome.** Correctness is evaluated
  *locally, before* the transaction, against the embedded `answerIso`. A wrong
  ring never contends — it writes only the phone's own `private/*` lockout (§5).
- **The arbitrated thing is the round's *terminal outcome*, not a buzzer slot.**
  Win (`{kind:"win", team, atStep}`) and bust (`{kind:"bust"}`) are competing
  values for the *same* `outcome` field, set by the *same* transaction. Whichever
  serializes first wins; the loser's updater sees a non-null `outcome` and
  aborts. This is what fixes EM blocker 2 (win vs. bust can no longer both land).

### 4.2 The win path

1. Player commits ISO `X` at the displayed `currentStep` (via typeahead, or a
   `flagSeed`-derived choice option unlocked at `choiceUnlockStep`, §1.3).
2. Phone computes `X === answerIso`.
   - **false →** plain write `gameState/round/private/tN = {lockedRound:
     round.number, wrongStep: displayedStep, wrongIso: X}`; disable the local
     buzzer for the round; return. (Round continues; emit `flag_ring`
     `correct:false`, §12.)
   - **true →** `resolveRound(code, {kind:"win", team: tN, roundNumber:
     round.number}, cfg)`.
     - `committed === true` → I won. The transaction has *already* set
       `outcome`, `results/*`, `teams/*` totals, `phase: reveal`, and
       `revealAt`/`autoAdvanceAt` atomically. Render the reveal from the new
       state. Emit `flag_round` (§12) — this committing phone is the single
       emitter.
     - `committed === false` → read `outcome`: a pre-existing `win` (from another
       team) → "too late"; a `bust` → "round busted"; an advanced `round.number`
       → "round over." Emit `flag_ring` with `contested:true` if the pre-existing
       outcome was a `win` (a correct ring that lost the race, §12).

Note: unlike v2 there is **no separate flip/settlement write** — the win
transaction *is* the settlement. `resolveOutcome` computes, from its snapshot:
`atStep = gameState.round.currentStep`; the winner's `points = scoreRing(atStep,
steps, base, min)`; `teams/{winner}/total = prior total + points` (absolute,
recomputed from the snapshot, never an increment); `teams/{winner}/reachedTotalAt
= round.number`; each `results/tN`; and `phase: reveal` + S6 fields.

### 4.3 Settlement is inside the transaction (no identical-shape race left)

`resolveOutcome` builds the entire reveal patch atomically:

```
outcome:  {kind:"win", team: winner, atStep}   // atStep = snapshot currentStep
phase:    "reveal"
round/results/{winner}: { correct:true, atStep, points: scoreRing(atStep,…), rangOut:false }
round/results/{other}:  { correct:false, points:0,
                          rangOut:   <from gameState.round.private/{other}?>,
                          wrongIso:  <from …private/{other}?>,
                          wrongStep: <from …private/{other}?> }
teams/{winner}/total:   <snapshot prior total + points>   (ABSOLUTE)
teams/{winner}/reachedTotalAt: round.number
round/revealAt, round/autoAdvanceAt                       (S6, reused)
```

- **No divergence on settled fields.** Because exactly one `resolveRound`
  transaction commits per round-ending event (server serialization), there is a
  *single* writer of `outcome`, `results/*`, and totals. v2's "identical-shape
  totals race" and its "wrong-ring disclosure divergence exception" are both
  **gone** — there is nothing to race. This is a net simplification (the EM
  predicted v3 "could become considerably simpler").
- **One residual, cosmetic:** a wrong ring whose `private/*` write lands *after*
  the winning transaction's snapshot is **not disclosed** at reveal (the comedy
  beat is missed for that one ring). This is a *missed* disclosure, never a
  *divergent* one; it never affects totals, standings, winner, or phase (all
  computed from `round`/`teams`, never from a post-hoc read). Bounded and
  acceptable; state it. (If desired, the reveal UI may show "someone also rang"
  generically, but v3 does not require it.)

### 4.4 The fallbacks — `roundConduct`, now transaction attempts

Because the reveal owner is the sole cadence and advance writer, a dead owner
would hang the game. **Every phone** (never the TV, §6) runs `roundConduct` on
each snapshot and attempts the appropriate *transaction* (which is idempotent and
epoch-guarded, so duplicates are free):

- **`phase === roundActive`, `outcome === null`:**
  - **owner:** attempt `resolve-bust` when `currentStep === STEPS` and
    `serverNow() ≥ stepStartedAt + graceMs` (step-completion gate).
  - **non-owner:** attempt `resolve-bust` when `serverNow() ≥ round.startedAt +
    STEPS·stepMs + 3·graceMs` (server-corrected dead-man deadline, §1.4).
  - (A `win` is attempted only by a correct ringer, §4.2 — not by
    `roundConduct`.)
- **`phase === reveal`, `outcome !== null`, same `round.number`:** attempt
  **`advance`** (`advanceRound(code, round.number, cfg)`) when the advance is due:
  - **owner:** at `autoAdvanceAt` (S6 auto-advance), or on manual next.
  - **non-owner (v3 reveal-phase fallback):** when `autoAdvanceAt` is non-null
    and `serverNow() ≥ autoAdvanceAt + 3·graceMs` — the dead-owner-during-reveal
    guard the EM required. `advanceRound` is epoch-guarded and idempotent, so a
    delayed or duplicate fallback is harmless.
- **else → `continue`.**

`advanceState` decides `reveal → gameOver` vs `reveal → roundActive` with
`gameWinner` (pure, deterministic on the snapshot + locked settings), so every
advancer agrees on the target; the transaction makes it happen exactly once.

> **Remaining accepted corners (both far narrower than v2's):**
> 1. **Held-then-owner-dies.** If the owner deliberately held the reveal
>    (`autoAdvanceAt: null`) and then dies, no fallback fires (the hold is
>    intentional and respected). A human restarts by creating a new room. This is
>    a deliberate-pause corner, not the "any dead owner at reveal freezes the
>    game" corner v2 accepted.
> 2. **Game-over → new-room handoff.** Creating the *next game's room* +
>    `nextRoom` pointer stays winner-owned (GeoParty parity, §7). A dead winner at
>    `gameOver` doesn't advance to the next *game* — but the current game has
>    fully resolved and displayed its crown. This is the standard GeoParty
>    game-to-game exposure, not a mid-game freeze.
>
> The v2 corner the EM explicitly rejected — a dead owner freezing the *round-to-
> round* reveal advance — is fixed by the reveal-phase fallback above.

### 4.5 Stale operations — handled by construction, not by a special guard (v3)

v2 needed a two-layer stale-claim guard because its epoch check lived *outside*
the transacted path. v3 needs none, because the epoch (`round.number`) is *inside*
the transacted subtree and every phase-changing write checks it:

- A delayed round-N `resolveRound` retries against the current `gameState`; if the
  room has advanced to round N+1, the updater sees `round.number === N+1 !==
  attempt.roundNumber` and **aborts**. It physically cannot write into round N+1
  (fixes EM blocker 1 and blocker 3 at once).
- A delayed round-N `advanceRound(fromRound: N)` sees `phase !== reveal` or
  `round.number !== N` and aborts.
- A duplicate `resolveRound` sees `outcome !== null` and aborts; a duplicate
  `advanceRound` sees the already-advanced phase/number and aborts.

So the entire "stale write from a dying phone" class collapses into "the
transaction aborts." No separate settle-time epoch check is required, though the
renderers still ignore a `round` whose `outcome`/`number` they do not expect
(ordinary defensive rendering).

---

## 5. Private per-phone state (the second novel concept)

*(EM-approved; preserved. Only the storage location — now inside `gameState/round`
— and the single reader — now the `resolveRound` transaction — are updated.)*

GeoParty has *zero* hidden information. Flag Reveal needs the wrong-ring lockout
to be private *during the round* — no other phone or the TV may learn, while play
is live, that or what a phone rang wrong. This forces a "private subtree" concept
the kernel does not have. §9 is honest about how far it actually goes.

### 5.1 The path and who reads it

- `gameState/round/private/tN = { lockedRound, wrongStep, wrongIso }`, written
  **only** by team tN's own phone (plain write), on a wrong ring.
- Read back **only** by the owning phone on resume (to restore its own lockout
  across a refresh — so a wrong-then-refresh phone stays locked out; local-only
  memory would lose this).
- Read by the **`resolveRound` transaction once, at settlement**, from its
  atomic `gameState` snapshot, solely to stamp `results/tN.{rangOut, wrongIso,
  wrongStep}` (a *post-round* disclosure, §5.3). No renderer, no other phone's
  live decision, ever reads it.

### 5.2 The contract — and its honest boundary

**Contract:** *no renderer and no live-play decision reads `round/private/*`.*
The scene builders in `screen-flag.js` and the live buzzer UI in `flag-ui.js` are
never handed `round/private` as input. The **only** reader is the `resolveRound`
transaction updater at settlement, and its output is disclosed only in
`phase: reveal`. Enforced by a test analogous to GeoParty's Decoy "hidden-in-play"
test: assert the render/scene functions and `roundConduct` never read
`round/private`.

**Boundary (state this plainly):** RTDB is world-readable within `rooms/` by
design, and every subscriber pulls the whole room via `subscribeRoom`'s
`onValue`. So "private" is a **render-discipline contract, not a transport
guarantee.** A determined devtools peeker on a rival phone *can* read
`round/private/*`. This is consistent with — and no weaker than — GeoParty's
already-accepted posture that the embedded `answerIso` is peekable
("devtools-peeking is not a threat we carry"). The suspense survives because
casual party players do not open devtools; a game whose *integrity* depended on
secrecy could not be built on this stack without server-side rules or auth
(§9.3). The EM explicitly endorsed this honesty ("private by rendering
discipline, not actual secrecy — exactly the right boundary to articulate").

> **Correction to the brief:** §3/§5 of the brief calls this a "private subtree,
> never on the live feed" contract as if it were a transport property. It is not,
> under a flat world-readable DB. It is a render-and-decision-boundary contract.
> That distinction is the sharpest finding of the whole experiment (§9.3) and
> must not be papered over.

### 5.3 Full disclosure at reveal (EM-approved)

`private/*` is disclosed **only at reveal**, after the round is decided, and
**fully**, not just as a boolean:

- **During the round**, knowing a rival rang wrong lets you free-ride the
  remaining steps (the flag is guessable-but-hard) — so it stays private. That is
  the suspense the render-discipline contract protects, and it is what keeps a
  wrong ring **cheap enough to risk**: a shy or younger player who dares an early
  ring is not broadcast a live failure. A buzzer game where people fear to buzz
  is dead; this is what produces the early-step contested claims the experiment
  wants.
- **At settlement**, that strategic value expires. So `resolveOutcome` reads
  `round/private/*` from its snapshot and surfaces `{rangOut, wrongIso,
  wrongStep}` into each non-winner's `results/tN`. The reveal plays the **full
  comedy beat** — *"OHHH, Dave rang Belgium at step 2!"* — with **zero strategic
  leak**, exactly like §1.5's "ohh, it was Chad!" payoff. This dominates
  boolean-only disclosure and public-with-penalty: all the suspense of private,
  nearly all the table energy of public. The EM called this decision "excellent."
- Because disclosure is now *inside* the atomic resolution transaction, there is
  no disclosure-divergence exception (contrast v2 §4.3). The only residual is a
  wrong ring whose `private/*` write lands after the winning snapshot — *missed*,
  not divergent (§4.3).

---

## 6. The TV — passive in both modes

*(Unchanged from GeoParty's model / v2; EM-approved. Restated because it is an
owner constraint.)*

- The TV **subscribes** and **renders** `currentStep` via
  `exposedAt(revealPlan(flagSeed, …), currentStep)` on the fixed reveal canvas
  (§8.4), plus standings/winner/crown and, at reveal, the wrong-ring comedy beats
  from `results/*` (§5.3).
- The TV **writes only `screenHeartbeat`**. It holds **no authority**, owns no
  timer, never advances a step, never flips a phase, and **never runs a
  `resolveRound`/`advanceRound` transaction** — a TV pushing an outcome or an
  advance would violate owner constraint #2. All fallback writers are phones only
  (§4.4).
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

- The reveal owner is `hostTeam`. It owns the cadence timer, starts each round
  (`advanceRound` from lobby / reveal), and is the primary advancer at reveal —
  with the v3 non-owner reveal-phase fallback (§4.4) covering a dead owner
  *between rounds*.
- At game over (`phase: gameOver`, reached via the epoch-guarded `advanceRound`
  transition), `gameWinner` (pure, deterministic, every device — no write) names
  the winner. The winner's phone creates the **next room** (game-to-game is a new
  room, as in h2h), writes `carryStandings(teams, winnerTeam)` — which zeroes
  totals for a fresh game (or carries them for a "season," a settings knob) and
  sets `hostTeam = winnerTeam` — writes a fresh `gameSeed` and the locked
  `settings`/`datasetVersion`/`rulesVersion` for the new game (§8), all **before**
  the `nextRoom` pointer, on the same connection (the ordering guarantee the
  pointer already relies on). Subscribers (and any TV) follow the pointer.
- **Rotation is per-game, not per-round (correction to the brief).** Within a
  single game (multiple flags), `hostTeam` does **not** move between rounds; the
  brief's "becomes host for the next *round*" should read "for the next *game*."
  Mid-game reveal-owner rotation would add a needless handoff race.
- The **game-over → new-room handoff remains winner-owned** (GeoParty parity). A
  dead winner at `gameOver` is the one narrow remaining exposure (§4.4); it is a
  between-*games* corner, not the between-*rounds* freeze the EM rejected.

---

## 8. Dataset, flag sequencing, versioning & licensing

**Recommendation: bundle `mledoze/countries` (ODbL) names/aliases as a static
`data/flags.json` in the Flag Reveal repo, and VENDOR the flag SVGs into the repo
(from `lipis/flag-icons`, MIT, or a public-domain set).**

- **Names/aliases:** `mledoze/countries` is the richest public option (English +
  common alternate spellings + translations), feeding both `normalizeAnswer` and
  the autocomplete index. Reduce it at author time to `{ iso2, name, aliases[],
  tier, eligible }`.
- **Flag images — vendor, do not hot-link.** Decided: **vendor.** A CDN hot-link
  breaks the offline-after-served story (§8.2), adds a third-party runtime
  dependency the no-deps rule frowns on, and creates a tampering surface;
  vendored SVGs (a few hundred KB total) ship in the repo, load from a relative
  path, work offline once cached, and are served from our own Pages origin.
- **Difficulty tiers** (`settings.difficulty`) select the flag pool by
  recognizability: `easy` (well-known flags, optionally `inputMode:"choice"` for
  kids), `world` (the default mixed pool), `expert` (obscure and visually-similar
  flags — Chad/Romania, Indonesia/Monaco, Mali/Guinea — where the progressive
  reveal genuinely matters).

### 8.1 Deterministic sequencing, config locking & versioning (v3)

Deterministic derivation is only deterministic if **every client shares the same
pool, ordering, hash/PRNG behavior, and settings.** v3 makes that explicit.

- **`gameSeed`** is written **once at room creation** (re-minted per game at host
  rotation, §7).
- **Locked settings.** At game start the creator writes an **immutable**
  `settings` block plus `datasetVersion` and `rulesVersion`. Nothing in
  `settings`/`gameSeed`/`datasetVersion`/`rulesVersion` may change for the life of
  the game. Locked fields: `roundCount`, `target`, `stepMs`, `gridN`,
  `revealAspect`, `base`, `min`, `steps`, `choiceUnlockStep`, `scoreProfile`,
  `difficulty`, `inputMode`. (Scoring/game-theory constants are provisional until
  the input-surface prototype, §1.3 — but once a game starts they are frozen for
  that game.)
- **Version-compatibility check.** On subscribe, a client runs
  `versionCompatible(room, bundled)` (§3). If `datasetVersion` or `rulesVersion`
  mismatches the client's bundled versions, the client **refuses to derive** the
  sequence and shows an "update your app to join this game" state rather than
  silently deriving a divergent flag list. This prevents a code/data-skewed phone
  from splitting a room.
- **Canonical ordering.** `gameFlags` first **canonically sorts the eligible pool
  by ISO** (`iso2` ascending) *before* the seeded shuffle, so pool-file ordering
  (or a future re-ordering of `flags.json`) cannot change the derived sequence for
  a given `(gameSeed, rulesVersion, datasetVersion)`.
- **Derive-don't-store.** The game's flag list is a pure function of
  `(gameSeed, rulesVersion, datasetVersion)`: `gameFlags(gameSeed,
  effectiveRoundCount, difficulty, pool)` = a seeded shuffle without replacement
  over the ISO-sorted eligible tier (easy-first-round guard), so it is repeat-free
  by construction. Round *k*'s flag is `gameFlags(...)[k-1]` and its per-round
  `flagSeed = hash(gameSeed, k)`; both are embedded into `round` at start, but
  because they are derivable, an owner refresh re-authors the identical round —
  no resample, no divergence, no stored cursor (`round.number` is the cursor).
- **`roundCount` vs. pool size.** `effectiveRoundCount = min(settings.roundCount,
  eligiblePoolSize)`. If the requested `roundCount` exceeds the eligible pool, the
  game runs the pool-size number of rounds (no repeats — repeat-free is a stated
  invariant). For a `target`-based game, the game ends when the target is reached
  *or* the pool is exhausted, whichever first; at pool exhaustion, highest total
  wins (§1.8). Surface the clamp in the lobby ("this tier has N flags").
- **Easy-mode `chooseOptions`** is likewise a pure fn of `flagSeed`, so every
  phone/TV shows the identical 4 options in identical order, and a refresh
  reproduces them.

### 8.2 Offline story — "works offline once served/cached," not `file://` (v3)

The EM flagged a real contradiction: GeoParty's README says local development
needs an HTTP server because **ES modules do not run from `file://`**, while v2
used graceful `file://` operation as a hard reason for vendoring. Resolution:

- **The requirement is "works offline once served/cached," not literal
  `file://`.** This app — like GeoParty itself — is an ES-module app; it must be
  served from an HTTP origin (GitHub Pages in production; `python3 -m
  http.server` or equivalent for local dev). `file://` is *not* a supported
  deployment for any ES-module app and never was; do not claim it.
- **Offline means cached-after-first-load.** After the site has been served once,
  it must keep working with the network down — hence vendored flags (relative
  paths, no CDN round-trip) and the derive-don't-store seed (no server round-trip
  to resume a game). If stronger offline is wanted, a service worker precaching
  the app shell + `flags.json` + vendored SVGs is the mechanism; it is optional
  and additive, not required for v1.
- **Vendoring is still the right call** — justified now by offline-cache + no-CDN
  dependency + no-tamper-surface, *not* by `file://`. §13 restates the
  CLAUDE.md "degrade offline / `file://`" rule under this honest interpretation.

### 8.3 Data licensing (v3 — state it, don't bury it)

Two different licenses are in play and they attach to different artifacts:

- **`data/flags.json` (names/aliases) is a derived database from
  `mledoze/countries`, which is ODbL.** A reduced/modified `flags.json` is a
  *derivative database* and must carry **ODbL attribution + share-alike** for the
  data file, independently of whatever license covers the application code.
  Publish `flags.json` under ODbL with attribution to `mledoze/countries`.
- **Vendored flag SVGs from `lipis/flag-icons` are MIT** — retain the MIT
  copyright notice for the image assets. (A public-domain flag set, if used
  instead, has its own — typically no — requirements; record whichever is used.)
- **Application code** carries its own (separate) license.
- **Deliverable:** ship `data/ATTRIBUTION.md` documenting each source, its
  license, and the share-alike obligation on `flags.json`. Reference it from the
  repo README. This is a ship item, not a footnote.
- **Do not touch** GeoParty's `data/location_pool.json` or its pool suite. Flag
  Reveal ships its own `data/flags.json` with its own integrity test (shape,
  unique ISO codes, every eligible entry has ≥1 vendored SVG, tiers valid,
  `datasetVersion` present).

### 8.4 Eligibility, `gridN`, and nonstandard aspect ratios (v3)

- **Eligible countries (predicate).** `eligible: true` in `flags.json` means the
  entry counts as a guessable country. v3 defines the default set as **UN member
  states + the 2 UN observer states (Holy See / Vatican, State of Palestine)** —
  ~195 entries, each with a distinct national flag — derived from
  `mledoze/countries` filtered to `independent === true`, then curated.
  Subnational flags, dependencies, and contested/partial-recognition entities are
  **excluded by default** (visually confusing and politically fraught); a
  `territories` tier may re-include a curated set as an explicit config. Which
  entities are eligible is a *data-authoring* decision baked into `flags.json`
  and versioned by `datasetVersion`.
- **`gridN` default and range.** `settings.gridN` default **4** (a 4×4 = 16-tile
  grid); allowed range **3–6** (9–36 tiles). Constraint: `gridN² ≥ STEPS` so
  every step de-occludes at least one tile; `revealPlan` partitions `gridN²`
  tiles into `STEPS` groups (`ceil(gridN²/STEPS)` per step, remainder front- or
  back-loaded deterministically). At the default, 16 tiles / 8 steps = 2
  tiles/step.
- **Nonstandard aspect ratios (Nepal, Switzerland, Vatican, Qatar).** The tile
  grid must partition a *rectangle*, but real flags vary from 1:1 (CH, VA) to
  11:28 (QA) to Nepal's non-rectangular pennant. Rule: render every flag into a
  **fixed reveal canvas** of aspect `settings.revealAspect` (default **3:2**)
  using `object-fit: contain` (letterbox) so the flag's true aspect is preserved
  with transparent padding. The `gridN × gridN` tile grid overlays the **canvas**,
  not the flag bounds, so tiling is identical for every flag and `revealPlan` /
  `exposedAt` stay pure functions of `(flagSeed, gridN, step)` — independent of
  the flag's own aspect. Consequences (accepted): for extreme-aspect or
  non-rectangular flags, some tiles reveal only padding; the reveal still works
  (the flag simply occupies fewer tiles). Nepal's SVG carries its own `viewBox`
  and letterboxes into the canvas with transparent padding like any other.

---

## 9. Extraction map — what the kernel abstracts, what it can't

This is the experiment's payload. v3 revises §9.2 and §9.4 per the EM: the
reusable primitive is bigger and cleaner than v2 claimed.

### 9.1 REUSES cleanly (the kernel holds)

| Kernel piece | How Flag Reveal reuses it |
|---|---|
| `roomRef()` single choke point | Unchanged; every read/write/subscribe/transaction routes through it. |
| Phase machine + `canTransition` | New 4-state machine (§11), same enforcement shape; all phase changes now transactional (§4). |
| Disjoint-path last-write-wins | `private/tN`, single-writer `currentStep` cadence, and the `autoAdvanceAt: null` hold are disjoint by owner. |
| Pool seed / cursor | `gameSeed` + derive-don't-store round derivation mirrors `poolCursor` intent (§8.1); refresh-resume is free; now version-locked. |
| ≤4 writes/s throttle | Cadence is 1 write / `stepMs` (≈0.67/s) — trivially under budget. |
| Clock discipline | Sharpened: the *single-writer step integer, read from the transaction snapshot,* is the score clock; the owner's bust gate is step completion; non-owner deadlines use server-corrected time (§1.4). |
| `screenHeartbeat` passive-TV + S7 liveness | Verbatim; the TV is one more subscriber, both modes, runs no transactions. |
| `nextRoom` + `followedCodes` chain | Verbatim for game-to-game handoff. |
| `hostTeam` rotation | Verbatim (winner becomes reveal owner next game). |
| `claimTeamSlot` transaction | Verbatim for slot claiming — one instance of the arbitration primitive (§9.2). |
| "Local until commit" pattern (SUPER SURE arming) | Reused: correctness is decided *locally* and only *committed* via the resolution transaction; wrong rings never leave the phone except as private state. |
| Consent/analytics seam | Extend `EVENT_SCHEMA`; aggregates only (§12). |

*What v2 listed here but v3 folds into §9.2:* the "reveal-flip identical-shape
settlement race" and the separate "deadlock / fallback-flip guard." v3 has **no**
non-transactional settlement race to inherit — settlement is inside the
resolution transaction (§4.3). The deadlock/fallback guard is now an idempotent
epoch-guarded transaction, which is the *same* primitive as the buzzer, not a
separate reused mechanism (§9.2).

### 9.2 BREAKS — must rewrite: from "contended claim" to "terminal-state arbitration" (v3)

- **What breaks:** the write-ownership table's headline rule — *"writers never
  contend on the same path"* — is false. N phones race to set the round's
  `outcome`, and a bust competes with a win for the same field.
- **Where the hypothesis HOLDS:** the *mechanism* already exists. An RTDB
  transaction is `claimTeamSlot` with a different path and predicate; the server
  serializes it; the loser aborts client-side. Nothing new was invented at the
  Firebase layer.
- **Where the hypothesis BREAKS (and how v2 got the model wrong):** v2 modeled
  concurrency as *two* peers — disjoint-path last-write-wins, and a
  contended-**buzzer-claim** first-write-wins — and left *settlement* as an
  ordinary `update()`. The EM proved that is incorrect: claim, bust, settlement,
  and epoch validation are **not** separable. A buzzer claim that then resolves
  the round non-transactionally admits (1) the reverse epoch race, (2) a
  win-vs-bust race to different outcomes, and (3) a stale settlement mutating the
  next round. All three vanish only when the **terminal outcome and its
  settlement are one epoch-guarded transaction over one small authoritative
  subtree.**
- **The corrected extracted primitive:** not "compare-and-set a buzzer slot," but
  **an epoch-guarded terminal-state arbitration over a tiny authoritative
  subtree** — *"commit a terminal state transition (win / bust / advance) only if
  `(phase, epoch)` match and the slot is unresolved; settle all dependent state
  in the same transaction; read any time/step input from the server snapshot, not
  the client."* `claimTeamSlot`, `resolveRound`, and `advanceRound` are three
  instances of it (slot claim, round resolution, round advance). This subsumes
  v2's "contended first-write-wins" *and* the reveal-flip settlement race *and*
  the deadlock guard into **one** named concept — which is both more correct and
  simpler (the EM: v3 "could become considerably simpler as well as actually
  implementation-ready").

### 9.3 BREAKS — must rewrite: private state (and it only half-works)

*(Unchanged in substance from v2; EM-endorsed.)*

- **What breaks:** GeoParty has zero hidden information; there is no "private
  subtree" concept in the kernel.
- **Where the hypothesis HOLDS:** at the **render/decision boundary.** A clean,
  testable contract — "no renderer or live-play decision reads `round/private/*`"
  — is expressible and enforceable exactly like the Decoy hidden-in-play test.
  For casual party play, this fully delivers the suspense.
- **Where the hypothesis BREAKS:** at the **transport boundary.** RTDB is
  world-readable within `rooms/` and every subscriber pulls the whole room, so
  "private" cannot be a transport or cryptographic guarantee — a devtools peeker
  reads it. The kernel *cannot* offer a true "never on the live feed" secrecy
  primitive without leaving its own posture (server-side per-path read rules +
  auth, or client-side crypto — both violate no-server/no-auth/no-deps). **So the
  honest extracted contract is narrower than the brief implied:**
  *"private-by-render-discipline"* (good for hidden information whose value is
  social, not adversarial), **not** *"private-by-transport."* Any future game
  whose correctness depends on secrecy (sealed bids resisting a determined peer,
  hidden roles) is **not expressible** on this kernel. That boundary is the
  second, subtler extraction result.

### 9.4 Net (revised per EM)

The extraction hypothesis is **not** "holds for every synchronization mechanism"
as v2 claimed. More precisely:

- The **stateless/disjoint mechanisms** (phase machine shape, throttle,
  seed/cursor derivation, heartbeat/next-room chain, `hostTeam` rotation, the
  "local until commit" pattern) reuse cleanly.
- The **concurrency model** does *not* reuse as-is: building a buzzer forced the
  kernel to discover that its several ad-hoc concurrency devices (the `claimSlot`
  transaction, the reveal-flip identical-shape race, the deadlock fallback, and
  the round epoch) are facets of **one** missing primitive — *epoch-guarded
  terminal-state arbitration over a small authoritative subtree.* That is the
  real, and more valuable, extraction finding; v2's "epoch-guarded buzzer claim"
  was too small a lesson.
- The **privacy concept** reuses only render-deep — a hard ceiling (§9.3).

Two invariants broken; one concurrency *model* unified upward into a stronger
primitive; one privacy concept capped. That is the maximal-signal-per-build
outcome the experiment wanted — and it is a *sharper* payload than v2 reported,
because the EM's blockers are exactly what revealed the unified primitive.

---

## 10. Wrong ring — private during the round, disclosed at reveal (decision preserved)

**Decision (EM-approved): PRIVATE during the round, FULL disclosure at the
reveal** — surface `{rangOut, wrongIso, wrongStep}` per non-winner at settlement
(§5.3). The optional non-identifying "rings so far: N" tension counter stays
**OFF for v1** and is noted as undesigned.

### Reasoning

- **Product / suspense:** the entire hook is a *progressive* reveal. If a phone
  can see *during the round* that rivals rang and missed, it learns the flag is
  guessable-but-hard and free-rides the remaining steps — the reveal's tension
  deflates. Private-during-play keeps every player's information to *their own
  eyes and the flag*. And private lockout makes a wrong ring **cheap enough to
  risk** — the shy or younger player who dares an early ring is not broadcast a
  live failure. A buzzer game where people fear to buzz is dead; this is what
  produces the early-step contested claims the experiment wants.
- **But keep the party payoff.** "OHHH, Dave rang Belgium at step 2!" is a
  live-play leak only *during* the round; at reveal it is pure payoff. §5.3's own
  logic — the private information's strategic value expires at settlement —
  licenses disclosing *everything* at reveal.
- **Experiment value:** private is what *forces the second novel kernel concept
  to exist* (§9.3). Public-with-penalty needs no private subtree and throws away
  half the experiment's signal.

### The optional counter — OFF for v1, and undesigned

A live "rings so far: N" pulse is **not free**: it is either a *third* contended
transaction (a new mechanism to specify/test) or derived by renderers **counting
`private/*`** — which directly **violates the render-discipline contract** the
experiment exists to test. There is also a residual leak: a *correct* ring
immediately flips to `reveal`, so any pulse that does not resolve to a reveal is
implicitly a wrong ring, leaking "the flag has been under-guessed." Therefore:
**ship v1 with the counter OFF**, giving the cleanest test of the hidden-subtree
contract. If it ever ships, it needs its own design paragraph (which transaction
path, or how it stays off `private/*`).

---

## 11. Phase machine

Head-to-head-shaped (no global "guessing" phase — buzzing happens *within*
`roundActive`), and in v3 **every transition is an epoch-guarded transaction**
(§4), so `canTransition` is enforced *inside* the transaction updater, not by a
trusting `update()`.

```
lobby → roundActive → reveal → (roundActive | gameOver)
gameOver  terminal (next game = new room via nextRoom)
```

`canTransition(from, to)` allowlist, enforced by `resolveOutcome` / `advanceState`
inside the transaction (the TV never proposes a transition; fallbacks only ever
attempt a *legal, idempotent, epoch-guarded* transition):

| from | to | who / when | primitive |
|---|---|---|---|
| lobby | roundActive | reveal owner starts round 1 | `advanceRound` (from lobby) |
| roundActive | reveal | correct ring (`win`) or bust (owner/fallback); guard: `phase===roundActive ∧ round.number===N ∧ outcome===null` | `resolveRound` |
| reveal | roundActive | reveal owner (or S6 auto-advance), **or non-owner reveal-phase fallback** (§4.4), when more rounds remain and no `target` reached; guard: `phase===reveal ∧ round.number===N ∧ outcome!==null` | `advanceRound` |
| reveal | gameOver | same as above when `gameWinner` is decided | `advanceRound` |
| gameOver | — | terminal; winner's phone writes the next room + `gameSeed` + locked settings + `nextRoom` | (new room) |

Illegal transitions (e.g. `roundActive → gameOver` directly, or `reveal →
reveal`) are rejected inside the transaction updater. Because both fallback
writers compute their target with the same pure `advanceState`/`resolveOutcome`
functions and the transaction is idempotent, they never produce an illegal or
divergent transition. A held reveal whose owner then dies is the one narrow
stall (§4.4); ordinary dead-owner-at-reveal is covered by the reveal-phase
fallback.

---

## 12. Instrumentation (mandatory — CLAUDE.md)

Extend `EVENT_SCHEMA` (the hard allowlist); aggregates only, never answer text,
guesses, ISO codes as free strings, team names, room codes, or anything
identifying. Two events, with the v3 property fixes:

- **`flag_ring`** — one per ring, emitted by the **ringing phone**. Props:
  `mode` (`tv`|`phone`), `atStep` (int — the displayed step for a wrong ring, or
  the settled `outcome.atStep` for the winner), `correct` (bool), `points` (int,
  0 for wrong), `contested` (bool — a *correct* ring whose `resolveRound(win)`
  aborted on a pre-existing `win` outcome, i.e. it lost the race), **`difficulty`**
  (v3), **`inputMode`** (v3), **`roundKey`** (v3 — a non-identifying deterministic
  round id = a truncated `hash(gameSeed, round.number)`; `gameSeed` is random, so
  this is not identifying). **Feeds the headline KPI:** are correct rings actually
  colliding (the experiment's success condition)?
- **`flag_round`** — one per round at reveal, emitted by **exactly one phone: the
  one whose `resolveRound` transaction committed** (§4.2). Because exactly one
  resolution transaction commits per round-ending event, this is exactly-once by
  construction — fixing v2's "potentially one `flag_round` per connected phone."
  Props: `mode`, `outcome` (`won`|`busted`), `winningStep` (int|null),
  **`difficulty`** (v3 — enables the "bust rate by difficulty tier" KPI the schema
  previously couldn't support), **`inputMode`** (v3 — probably the strongest
  explanatory variable), `roundNumber`, **`roundKey`** (v3). *`ringCount` is
  **not** a property of `flag_round`* — it cannot be reconstructed from persisted
  round state (losing correct claimants abort and are stored nowhere). Instead it
  is **reconstructed downstream** as the count of distinct `flag_ring` events
  sharing a `roundKey`, de-duplicated on `(roundKey, atStep, mode, correct)` to
  absorb PostHog delivery duplication.

Notes:

- **`wrongIso` is disclosed in the room UI at reveal** (party value, §5.3) but is
  **never** emitted to analytics — no ISO codes as free strings, per the schema
  allowlist.
- **`roundKey` is derived from `gameSeed`, never from the room code** (the room
  code is on the party's TV and is treated as identifying for masking, §13). It
  gives analytics a stable join key without leaking identity.
- Add sanitizer tests in the new repo's `tests/analytics.test.js` (assert no
  coordinate-shaped, ISO-shaped, room-code-shaped, or free-text keys survive),
  and document both events, their KPIs, and the downstream `ringCount`
  reconstruction in the repo's `docs/analytics.md`. If an event is judged to add
  no signal, say so explicitly in the change summary rather than skipping
  silently.

---

## 13. What must NOT change

- **Consent gating is inviolable.** All capture through `track()`/`trackError()`
  from `consent.js`; never reference PostHog directly; never capture pre-opt-in;
  never weaken banner/revoke. Aggregates only (§12). `POSTHOG_INIT_OPTIONS` stays
  mutable.
- **`roomRef()` stays the sole room path choke point.** Every
  read/write/subscribe/transaction routes through it.
- **Transactions stay the ONLY non-`update()` writes, and now there are three —
  `claimTeamSlot`, `resolveRound`, `advanceRound` — all instances of one
  epoch-guarded terminal-state arbitration primitive (§9.2).** Every
  phase-changing write is a transaction guarded on `(phase, round.number,
  outcome)`; no phase change is a bare `update()`. This is the v3 correctness
  spine (EM blockers 1–3).
- **Settlement is atomic with the outcome.** The winner/points/totals/results/
  phase are all written by the single committed `resolveRound` transaction, using
  **absolute** totals recomputed from the snapshot (never increments) and
  **`atStep` read from the server snapshot** (never the client). No separate
  settlement `update()` exists.
- **Throttle ≤4 writes/s per writer.** Cadence and any live mirror obey the
  dirty-flag + 250 ms pattern, canceled on phase change.
- **Clocks never ticked through Firebase; skew never flips an outcome.** Score
  clock = the single-writer `currentStep` integer read from the transaction
  snapshot; the owner's bust gate is step completion; **non-owner deadlines use
  server-corrected time** (`.info/serverTimeOffset`), and `startedAt`/
  `stepStartedAt` are server timestamps (§1.4).
- **Private is render-discipline, not transport.** No renderer and no live-play
  decision reads `round/private/*`; the only reader is the `resolveRound`
  transaction at settlement (§5). Test-enforced.
- **Pure/glue split.** Decision logic in `flag.js` (tested); `flag-ui.js` /
  `screen-flag.js` stay thin. Every feature ships tests + instrumentation.
- **Passive TV.** The TV writes only `screenHeartbeat`; it never gains authority,
  a timer, or a fallback transaction (owner constraint #2, §6).
- **`hostTeam`-rotation (per game), `nextRoom`+`followedCodes`, S7 skew-proof
  liveness, S6 auto-advance** all reused verbatim; the S6 advance is now the
  `advanceRound` transaction with a non-owner reveal-phase fallback (§4.4).
- **Config + version locking.** `settings`, `gameSeed`, `datasetVersion`,
  `rulesVersion` are immutable for the life of a game; clients refuse to derive on
  version mismatch; the pool is canonically ISO-sorted before the seeded shuffle
  (§8.1).
- **Session-replay masking** for any new screen rendering a team name or room
  code (`data-ph-mask`); any new map/tile surface under `blockSelector`; update
  the replay-mask checklist in the same change.
- **No build, no deps, no server.** *"Degrade offline / `file://`"* is honored as
  **"works offline once served/cached"** (ES modules require an HTTP origin;
  `file://` is not a supported mode for any ES-module app, GeoParty included, per
  its own README). Vendored flag SVGs (§8) and the derive-don't-store seed make an
  offline resume need no server round-trip (§8.2).
- **Data licensing.** `flags.json` ships under ODbL (attribution + share-alike);
  vendored SVGs retain their MIT notice; `data/ATTRIBUTION.md` documents both
  (§8.3).
- **Do not touch GeoParty's `data/`, `tools/`, or its pool suite.** Flag Reveal is
  its own repo with its own `data/flags.json` and its own integrity test.

---

## 14. Corrections to the first-pass brief (summary)

1. **Topology vs. mode (§0).** One h2h-shaped topology with two *render* modes;
   buzzing is always per-phone, only the reveal renderer changes with TV
   presence.
2. **First-correct-terminal-outcome, not first-to-act (§4.1).** Only a correct
   ring attempts a `win` outcome; wrong rings never contend; win and bust are
   competing terminal outcomes of one transaction.
3. **Private is render-deep, not transport-deep (§5.2, §9.3).** Under a flat
   world-readable RTDB it is a render/decision discipline only — the subtler half
   of the extraction result.
4. **Rotation is per-game, not per-round (§7).**
5. **Clock sharpening (§1.4).** Score clock = the single-writer step integer read
   from the *transaction snapshot*; the owner's bust is gated on step completion;
   non-owner deadlines use server-corrected time.
6. **Vendor the flag SVGs (§8),** justified by offline-cache + no-CDN, not
   `file://`.
7. **The extraction framing (§9).** The mechanism (transactions) already exists;
   what the experiment forces is *promoting* it into one **epoch-guarded
   terminal-state arbitration** primitive covering claim, bust, settlement, and
   advance — and discovering a *hard ceiling* on privacy (render-deep only).

## 15. What the v3 review changed relative to v2 (traceability)

For reviewers checking coverage against the EM review, each EM point maps to a
section:

- Blocker 1 (epoch guard not epoch-guarded) → §2, §3, §4.5, §9.2.
- Blocker 2 (win vs. bust race) → §1.5, §4.1, §4.4.
- Blocker 3 (stale settlement mutates next round) → §2, §4.3, §4.5.
- Recommended redesign (transact the resolution) → §2 (`gameState`), §3
  (`resolveRound`/`advanceRound`/`resolveOutcome`/`advanceState`), §4.
- `atStep` from the transaction snapshot → §1.3, §1.4, §4.2/§4.3.
- Server-time fallback clock → §1.4, §4.4, §13.
- Easy-mode game-theory bug → §1.3, §1.7.
- Typeahead race acknowledged → §1.3.
- Dead-owner-during-reveal fallback → §4.4, §7, §11.
- Analytics inconsistencies (difficulty/inputMode/ringCount/single-emitter) →
  §12.
- Lock + version config at game start; canonical ISO sort → §2, §8.1, §13.
- `roundCount` > pool, `gridN`, alias collisions, eligibility, aspect ratios →
  §1.6, §8.1, §8.4.
- `file://` contradiction → §8.2, §13.
- Data licensing → §8.3, §13.
- §9.4 net conclusion revised → §9.2, §9.4.
