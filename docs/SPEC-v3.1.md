# FLAG REVEAL — implementation-ready spec (v3.1)

*Architect/designer deliverable, 2026-08-23. Design-only: no GeoParty repo
changes. Register follows `geoparty/docs/architecture.md` — plain and direct.
This is v3.1: a revision of `SPEC-v3.md` incorporating Fable's independent
design review of v3 (APPROVE WITH CHANGES: distributed correctness 8.5/10,
implementation readiness 7.5/10). Fable confirmed v3's terminal-outcome
concurrency redesign is correct and needs **no further external review round** —
the remaining work is mechanical. v3.1 applies Fable's 7 REQUIRED changes so the
spec reaches "implement from this alone," plus the cheap RECOMMENDED items. See
"v3.1 changes" below. The v3 changes (which incorporated the external
engineering-manager review of v2) are preserved verbatim beneath them as
lineage.*

A flag-guessing party game for a family/group around a TV, each with a phone.
Static no-build GitHub Pages + Firebase RTDB, no server code — the same
constraints, the same pure/glue discipline, and (almost) the same sync kernel as
GeoParty. This document is written so an engineer can implement from it alone.

The headline is unchanged: Flag Reveal deliberately breaks **two** GeoParty
invariants at once — *zero hidden information* and *writers never contend on the
same path* — which is the whole point of building it. What v3 changed is *how*
the contention is arbitrated: v2 transactionally claimed a buzzer and then
non-transactionally resolved the round, which the EM showed is not correct.
v3 transacts **the round's terminal outcome** — win or bust — over one tiny
authoritative subtree. v3.1 does not touch that spine; it closes the mechanical
gaps Fable's review found in and around it (the same-client transaction-cancel
interaction, the abort taxonomy, `applyLocally`, the `lockedRound` disclosure
filter, transaction-timestamp honesty, the dead-owner degenerate loop, and the
analytics dedup key). §9 maps exactly where the extraction hypothesis holds and
where it breaks, now with the primitive named precisely: a **predicate-guarded
compare-and-set over RTDB**, whose round-scoped specialization is **epoch-guarded
terminal-state arbitration**.

---

## v3.1 changes (what changed from v3, and why)

Every item below is driven by Fable's independent design review of v3. The seven
REQUIRED (blocking) changes come first; the RECOMMENDED (non-blocking) items
follow. None of them alters the v3 correctness spine — they are the mechanical
completeness work Fable said remained. Where a required change and a recommended
one touched the same sentence, the required intent won.

### REQUIRED (blocking) — all applied

1. **The plain-write/transaction interaction note was wrong for the one client
   that matters (§2).** v3 said a plain write concurrent with an in-flight
   resolution transaction "simply causes Firebase to re-run the updater against
   the fresher snapshot (desirable)." That is true only for writes from **other**
   clients. A **same-client** `set()`/`update()` at an overlapping path
   **cancels that client's own pending transaction** — the transaction callback
   receives an abort with error `"set"`. The one client that mixes both is the
   reveal owner: its cadence plain writes to `gameState/round/currentStep` and its
   S6 hold write (`autoAdvanceAt: null`) share paths with its own `resolveRound`
   (bust) and `advanceRound` transactions. **Fix (§2):** correct the note; mandate
   that the owner **cancels its cadence/hold timers *before* attempting its own
   transaction** (the existing "canceled on phase change" throttle discipline is
   *not* sufficient — the cancel must happen before the phase change commits); and
   specify that a `"set"`-aborted transaction is retried on the next snapshot.
   (Fable REQUIRED 1.)

2. **The abort taxonomy was incomplete and mis-rendered correct rings as "round
   over" (§4.2).** v3 enumerated three abort reasons (rival win / bust / advanced
   round). Fable found at least three more, each of which silently swallows a
   player's **correct first ring**: (i) `runTransaction`'s first run executes
   against the **local cache**; on a just-reconnected phone that cache can be
   empty, so the updater is invoked with `gs == null`, and returning `undefined`
   there **aborts without ever consulting the server**; (ii) transient network
   failure / retry exhaustion; (iii) the same-client `"set"` cancel from change 1.
   A fourth gap: a pre-existing `win` from the player's **own** team (the commit
   succeeded but the ack was lost before the phone learned it) must render **"you
   won,"** not "too late." **Fix (§4.2):** enumerate all abort causes and add the
   rule — *on abort where the snapshot still shows the same round active with
   `outcome == null` (or on a thrown error), retry the attempt* — and branch
   own-team pre-existing win to "you won." (Fable REQUIRED 2.)

3. **`applyLocally: false` is mandatory for `resolveRound` and `advanceRound`
   (§3/§4/§13).** Firebase's default `applyLocally: true` applies the updater's
   result **optimistically to the local cache**, firing local `onValue` events —
   including on the ancestor `rooms/{CODE}` subscription every renderer hangs off.
   So a correct-but-losing ringer's phone would briefly hold a **locally-applied
   full settlement**: `phase: reveal`, itself as winner, and — the contract
   breach — **every rival's `private/*` disclosed into `results/*`, mid-round,**
   before the server rejects the transaction and re-runs it. It also flashes a
   **false "you won."** **Fix:** mandate `applyLocally: false` on both
   transactions, and say why (the mid-round `private/*` disclosure leak and the
   false-win flash). (Fable REQUIRED 3.)

4. **`resolveOutcome` must disclose `private/tN` only when
   `private.tN.lockedRound === round.number` (§4.3/§5).** `private/tN` is a plain,
   unguarded own-phone write (it must be — it is the own-phone path). A delayed
   wrong-ring write can therefore fabricate a disclosure in the **next** round:
   player rings wrong in round N; the write is delayed; round N resolves and
   `advanceState` resets `private: {}` in round N+1; the straggler lands, writing
   `{lockedRound: N, wrongIso, wrongStep}` into round N+1's subtree; round N+1's
   `resolveOutcome` reads `private/tN` and stamps `rangOut: true, wrongIso: …`
   into N+1's results — a comedy beat for a round the player never rang in. The
   `lockedRound` field exists **precisely** to defeat this, but v3's settlement
   patch never filtered on it. **Fix:** `resolveOutcome` discloses `private/tN`
   only when `private.tN.lockedRound === round.number`; add a unit test. One line
   of pure-function logic. (Fable REQUIRED 4.)

5. **Timestamps written inside transactions are writer offset-estimates, not
   true server stamps (§1.4/§2/§13).** The SDK cannot send the
   `ServerValue.TIMESTAMP` sentinel **through a transaction** — a compare-and-set
   needs a concrete value, so a deferred token is resolved **client-side** from
   the writer's `serverTimeOffset` estimate before commit. What actually lands is
   the **writer's offset-corrected clock**, not a true server stamp. The design
   survives this — every deadline that consumes these fields carries **≥ 3·`graceMs`
   (9 s)** of slack, far above realistic offset-estimate error — but the spec must
   say so, because (a) an engineer will discover the token behaves differently in
   transactions and won't know whether it matters, and (b) v3 §13 promised
   something ("`startedAt`/`stepStartedAt` are server timestamps") the platform
   cannot deliver through this write path. **Fix:** one honest paragraph; **no
   design change**. (Fable REQUIRED 5.)

6. **The dead-owner degenerate loop after a fallback advance must be documented
   (§4.4).** The reveal-phase any-phone advance (v3's EM requirement) is correct,
   but one round further: a non-owner's fallback `advanceRound` authors round N+1
   — and the **cadence writer for N+1 is still the dead `hostTeam`**. So
   `currentStep` freezes at 1, nothing further reveals, and the round ends only via
   a correct blind-ish ring or the non-owner fallback bust at
   `startedAt + STEPS·stepMs + 3·graceMs` (~21 s). With a **permanently** dead
   owner the game cycles: step-1-frozen round → bust → advance → repeat. That is
   strictly better than v2's hard freeze, and host-migration (with its
   two-cadence-writers race) is rightly out of scope — but the spec must **state**
   this degraded steady-state and the human recovery (make a new room). **Fix:**
   documentation only. (Fable REQUIRED 6.)

7. **The `flag_ring` dedup key and emission semantics are fixed (§12).** v3
   reconstructed `ringCount` from `flag_ring` events de-duplicated on
   `(roundKey, atStep, mode, correct)`. That key **doesn't distinguish players** —
   two different phones ringing at the same step with the same correctness
   collapse into one event. The experiment's stated success condition is "are
   correct rings actually colliding" — precisely the case of two `correct:true`
   rings in the same round at (frequently) the same step, which this key
   **conflates**. GeoParty's CLAUDE.md explicitly allows **slot ids** in analytics
   properties. **Fix:** add the slot id (`team: tN`) to `flag_ring`; dedup on
   **`(roundKey, team, correct)`**; specify the `atStep` a **losing-correct**
   ringer emits (v3 left it unspecified — defined only for wrong rings and the
   winner); and downgrade "exactly-once" for `flag_round` to **"at-most-once
   emission"** (a phone that commits and then crashes before emitting loses the
   event — exactly-once is a property of the **commit**, not the emission).
   (Fable REQUIRED 7.)

### RECOMMENDED (non-blocking) — applied where cheap and unambiguous

8. **§1.4 residual note rewritten.** Commit-latency (±1 step, scoring) is now
   separated from display-staleness (unbounded, scoring-irrelevant but
   perception-relevant); the "never visibly unfair" claim is scoped to **TV
   mode**; and the no-exploit property is stated: **the snapshot step is always
   ≥ any step any phone has displayed, so lag can only *reduce* a player's score,
   never inflate it.** (Fable RECOMMENDED 8.)

9. **§9.2/§13 sharpen the `claimTeamSlot` distinction.** v3 called `claimTeamSlot`
   "an instance of the same epoch-guarded terminal-state arbitration primitive."
   It is not — it has **no epoch and no phase guard**; it is a plain
   predicate-guarded compare-and-set ("claim if vacant"). The clean formulation:
   the **kernel primitive is a predicate-guarded CAS via RTDB transaction**;
   `resolveRound`/`advanceRound` are its **round-scoped specialization** where the
   predicate *must* include `(phase, epoch, outcome)`; `claimTeamSlot` is the
   **degenerate instance** that misled v2 into thinking the predicate could stay
   local. Sharper, not weaker. (Fable RECOMMENDED 9.)

10. **Small items.** (i) §3: `flag-ui.js` **subscribes** to
    `.info/serverTimeOffset` (it does not read it once) — the offset is
    re-estimated on reconnect, and a stale offset is exactly what the
    server-corrected-clock fix exists to prevent. (ii) `outcome === null` guards
    are written **`outcome == null`** throughout — RTDB never stores nulls, so an
    unresolved outcome is an **absent key** (`undefined`), and strict `=== null`
    is an easy pure-function bug; `== null` matches both. (iii) §4.3 states
    explicitly that `resolveOutcome` returns the **full replacement `gameState`**
    and that **`private/*` is dropped** at settlement (the disclosed values now
    live in `results/*`). (iv) §4.4/§7 add the **lobby-dead-creator** and
    **gameOver-dead-winner** recovery lines (manual "anyone taps New Game").
    (Fable RECOMMENDED 10.)

---

## v3 changes (what changed from v2, and why — preserved as lineage)

Every item below is driven by the external EM review of v2. Blockers first.
These are unchanged by v3.1 except where a v3.1 item above sharpens the wording
(noted inline in the referenced sections).

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
   if `phase === roundActive`, `round.number === myRound`, and `outcome == null`;
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
   `.info/serverTimeOffset`, and authors `startedAt`/`stepStartedAt` with
   server-corrected timestamps. Cross-client skew can no longer flip an outcome.
   (EM "The fallback clock claim is similarly overstated.") *(v3.1 §1.4 clarifies
   that transaction-authored stamps are offset-estimates; the ≥3·graceMs slack
   covers it.)*

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
   and *game-over-handoff* corners remain (§4.4). *(v3.1 §4.4 documents the
   further-round degenerate loop this produces under a permanently dead owner.)*

7. **Analytics holes fixed (§12).** `flag_round` claimed "bust rate by difficulty
   tier" without a `difficulty` property; neither event recorded `inputMode`;
   `ringCount` cannot be reconstructed from persisted state because losing
   *correct* claimants abort their transaction and are stored nowhere; and the
   one-per-round emitter was unspecified (risking one `flag_round` per phone). v3
   adds `difficulty` and `inputMode` to both events, adds a non-identifying
   deterministic `roundKey = hash(gameSeed, number)` for downstream
   dedup/reconstruction, reconstructs `ringCount` from de-duplicated `flag_ring`
   events, and names the single emitter: the phone whose `resolveRound`
   transaction **committed**. *(v3.1 §12 corrects the dedup key to include the
   slot id and downgrades the emitter guarantee to at-most-once.)*

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
    claim/bust/settlement/advance model. *(v3.1 §9.2 further separates the kernel
    CAS primitive from its round-scoped specialization.)*

**Preserved from v2 (EM-approved, do not regress):** the private wrong-ring →
full-disclosure-at-reveal decision (§5/§10); the TV topology ("everyone always
has a phone; TV presence merely changes where the reveal is rendered", §0/§6);
the deterministic `gameSeed`, repeat-free game sequence, and deterministic
easy-mode alternatives (§8); the pure/glue split, the phase machine, and the
extraction framing of §9.

---

## 0. The one clarification the first-pass got blurry — topology vs. mode

*(Unchanged from v2/v3; EM-approved. Restated because it anchors everything.)*

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
   `round = { number, flagSeed, answerIso, startedAt(server-corrected ts),
   currentStep: 1, stepStartedAt(server-corrected ts), outcome: null, results:
   {}, private: {} }`. `answerIso` is embedded at round start so every phone
   self-scores its own guess (same accepted posture as GeoParty's embedded
   `truth`: devtools-peeking is not a threat we carry). `flagSeed` and `answerIso`
   for round *k* are pure functions of `(gameSeed, k)` (§8), so an owner refresh
   mid-game re-derives the identical flag rather than resampling. *(The `startedAt`
   / `stepStartedAt` authored inside this transaction are writer offset-estimates,
   not true server stamps — §1.4.)*
2. **Progressive reveal.** The flag is revealed across **`STEPS = 8`** steps: a
   tile grid de-occludes *and* a parallel blur→sharp track sharpens. The reveal
   owner advances the step every `stepMs` (default 1500 ms) by a **plain
   throttled write** of `{currentStep, stepStartedAt}` to `gameState/round` — one
   small write per 1.5 s, far under the 4/s throttle. **The step number is the
   clock** (§1.4). A concurrent resolution transaction from *another* phone simply
   re-runs against the fresher `currentStep`; the owner's *own* cadence write and
   its *own* resolution transaction interact differently and must be sequenced
   (§2).
3. **Ring in.** At any time a player commits a guess (a country) on their phone.
   That commit *is* the ring. Correctness is evaluated locally against the
   embedded `answerIso` (§1.6):
   - **Correct →** attempt `resolveRound(code, {kind:"win", team: tN,
     roundNumber}, cfg)` (§4). If it **commits**, this player wins the round and
     the transaction *itself* has already flipped the room to `reveal`, settled
     totals, and stamped results — there is no separate settlement write. If it
     **aborts or throws**, do **not** assume "round over": re-read the snapshot
     and branch per the full abort taxonomy in §4.2 (retry a benign abort; render
     "you won" for an own-team pre-existing win; "too late" only for a rival win;
     "busted" for a bust; "round over" only when the round number has genuinely
     advanced).
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
  if `serverNow() ≥ bustAt` and `outcome == null`. **`serverNow()` = `Date.now()
  + serverTimeOffset`**, where `serverTimeOffset` is **subscribed** from
  Firebase's `.info/serverTimeOffset` (§3 — it is re-estimated on reconnect, so a
  live subscription, not a one-shot read). This is the v3 fix to the EM's
  "fallback clock" objection: a raw-`Date.now()` fast client could bust *early*
  and change the outcome; a server-corrected clock cannot. The `×3 graceMs`
  offset (mirroring the forfeit sweep) keeps the owner winning the bust race in
  the common case, and the transaction guarantees a single terminal outcome
  regardless.
- **Accepted behavior of a stalled-but-alive owner:** if the owner's tab is
  throttled but its connection is live, steps freeze at a cheap step, rings at
  that step score high (players are not penalized), and — because the owner never
  reaches `currentStep === STEPS` — the round ends only when a correct ring's
  transaction commits, or when a non-owner's server-corrected fallback deadline
  arrives. Fine; state it, don't defend against it.

#### Timestamps written inside transactions are offset-estimates, not true server stamps (v3.1)

An engineer implementing the deadline math **must** know this, and §13 must not
over-promise it: **the SDK cannot send `ServerValue.TIMESTAMP` through a
transaction.** A transaction is a compare-and-set — its updater must return a
**concrete** value tree — so any deferred `TIMESTAMP` sentinel placed inside a
transaction updater is resolved **client-side** from the writer's current
`serverTimeOffset` estimate **before** the compare-and-set is issued. What
actually lands on the server is therefore the **writer's offset-corrected local
clock**, not a true server timestamp.

- **Which fields this affects.** Everything authored *inside a transaction*:
  `round.startedAt` and the round-start `round.stepStartedAt` (authored by
  `advanceState` inside `advanceRound`), and `round.revealAt` / `round.autoAdvanceAt`
  (authored by `resolveOutcome`/`advanceState`). The *per-step* cadence
  `stepStartedAt`, by contrast, is a **plain throttled write** (not a
  transaction) and *may* use the real `ServerValue.TIMESTAMP` token — but the
  deadline math tolerates either, so an implementation may use the
  offset-corrected value uniformly for simplicity.
- **Why the design survives it.** Every deadline that consumes these fields
  carries **≥ 3·`graceMs` (9 s)** of slack: the non-owner bust deadline is
  `startedAt + STEPS·stepMs + 3·graceMs`, and the non-owner reveal-advance
  deadline is `autoAdvanceAt + 3·graceMs`. Realistic `serverTimeOffset` estimate
  error (tens to low hundreds of ms after a successful sync) is far below 9 s, so
  an offset-estimated stamp cannot move which phone wins a fallback race, and it
  cannot flip a terminal outcome — the transaction still arbitrates a single
  outcome regardless of which phone's deadline fires first. **No design change is
  required.** This paragraph exists so no one "fixes" the token behavior and no
  one trusts a transaction-authored stamp to sub-second precision.

> **Residual, accepted (smaller than v2's), separated into two independent axes
> (v3.1):**
>
> - **Commit-latency (±1 step, scoring-relevant, bounded).** Because `atStep` is
>   the snapshot step, a fast ringer whose transaction commits just after a
>   cadence advance is scored at the *newer* (higher) step — costing at most one
>   step (~125 pts). This is bounded to ±1 step of commit latency and symmetric
>   across players.
> - **Display-staleness (unbounded, scoring-irrelevant, perception-relevant).** A
>   phone's *rendered* step can lag the authoritative `currentStep` by an
>   unbounded amount (a slow link, a throttled tab). This never touches scoring —
>   scoring reads the server snapshot, not the display — but a player may *feel*
>   they rang "at step 3" and be scored at step 4. In **TV mode** this is never
>   *visibly* unfair: everyone is scored at the step the shared TV shows, which is
>   the authority. In **no-TV mode** a player's own lagging phone is the only
>   reference they have, so the perception gap is real though the score is still
>   correct.
> - **No-exploit property (v3.1).** In both modes the snapshot step is **always
>   ≥ any step any phone has displayed** (the cadence integer only increases, and
>   a phone can only render a value it has already received). So display lag can
>   only cause a player to be scored at a **higher-or-equal** step than they
>   thought — it can only **reduce** a player's score, never **inflate** it.
>   There is no lag-based scoring exploit. This strictly improves on v2's "score
>   at the client's stale step," which *could* inflate a lagging player's score.

### 1.5 Bust

- **Trigger (owner):** `phase === roundActive`, `outcome == null`,
  `currentStep === STEPS`, and `serverNow() ≥ stepStartedAt + graceMs` (§1.4).
  Owner attempts `resolveRound({kind:"bust", roundNumber})`.
- **Trigger (fallback, any non-owner phone):** `phase === roundActive`,
  `outcome == null`, and `serverNow() ≥ round.startedAt + STEPS·stepMs +
  3·graceMs`. Same `resolveRound({kind:"bust", …})` attempt.
- **The TV never triggers a bust** (it runs no `roundConduct`, §4.4/§6).
- **Arbitration:** the bust attempt is the *same transaction* a win uses. If a
  win has already committed (`outcome.kind === "win"`), the bust updater sees a
  non-null outcome and aborts — no all-zero settlement can clobber a winner
  (**this is the fix to EM blocker 2**). If the bust commits first, a later
  correct ring's win transaction aborts on the non-null bust outcome.
- **Effect (bust):** `outcome: {kind:"bust"}`, `phase: reveal`, every
  `results/tN` = `{correct:false, points:0, rangOut:<from private, filtered by
  lockedRound>, wrongIso, wrongStep}` (§4.3/§5.3), no team total changes — all
  written atomically by the transaction.
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

#### Guess mode — "First correct wins" vs "Multiple guesses" (v3.1.x)

A host choice at room creation, locked into settings like difficulty/inputMode
(`settings.multiGuess`, §2/§8.1). Two lockout policies:

- **First correct wins** (default, `multiGuess` absent/false): the wrong-ring
  cost above — one wrong ring ends that team's round.
- **Multiple guesses** (`multiGuess: true`): a wrong ring is still recorded (it
  feeds the reveal beats and the TV's transient "guessed wrong — keep looking!"
  hint, via the same `gameState/round/private/tN` write) but does **not** lock
  the team out. They keep guessing until they ring correct, a rival wins, or the
  round busts. The first correct ring still wins; a team that rang wrong earlier
  can still win by ringing correct later.

**The arbitration is untouched — this is the key invariant.** The three
transactional writes are unchanged; no new transaction, no new phase flip. The
mode changes exactly one thing: the *client's* re-guess gate. `resolveOutcome`
already trusts the ringing team as the winner and never assumes a prior
wrong-ringer is out, so a wrong-then-right team wins with **no** change to the
resolve/advance cores. The only touch points are (a) `shouldLockOut(cfg)` /
`guessModeLabel(cfg)` — two pure, tested helpers in `js/flag.js`; (b) the phone
gating `myLockRound` + the input on `shouldLockOut(cfg)` in `commitGuess`; and
(c) the `guessMode` analytics dimension (`single`|`multi`) on `flag_ring` /
`flag_round` (§12). The private wrong-ring write stays a bare `update()` in
**both** modes (it never changes a phase) — in multi-guess it is simply a beats
record rather than a lockout, and the phone never re-gates on it.

Design note (winner's own earlier wrong ring): in multi-guess mode a winner who
rang wrong before ringing correct settles as `correct` (their earlier wrong ring
is **not** re-surfaced in their own beats row — the win is the headline). Other
teams' wrong rings still show in beats exactly as in lockout mode.

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
                       inputMode ("typeahead"|"choice"),
                       multiGuess (bool; §1.7 guess mode — absent/false = "First
                         correct wins" lockout, true = "Multiple guesses") }
  hostTeam           tN — reveal owner; rotates to the winner per GAME (§7)
  screenHeartbeat    ms epoch — the ONLY thing the TV writes (unchanged)
  nextRoom           pointer into a FINISHED room → subscribers follow (unchanged)

  gameState          ← the authoritative subtree; the resolution/advance TRANSACTION boundary (§4)
    phase            lobby | roundActive | reveal | gameOver
    round
      number         1-based
      flagSeed       per-round reveal/option seed = hash(gameSeed, number) (§8) — set at round start
      answerIso      ISO-3166-1 alpha-2, embedded at round start (self-scoring)
      startedAt      transaction-authored ts — writer OFFSET-ESTIMATE, not a true server stamp (§1.4)
                     (bust-clock anchor; the ≥3·graceMs slack absorbs the estimate error)
      currentStep    1..STEPS — SINGLE-WRITER cadence integer (the clock); plain throttled write
      stepStartedAt  step timestamp (interpolation + owner bust gate); round-start value is
                     transaction-authored (offset-estimate), per-step cadence value is a plain write (§1.4)
      outcome        absent(unresolved) | {kind:"win", team, atStep} | {kind:"bust"}
                     ← the TERMINAL state; set ONLY by the resolveRound TRANSACTION (§4).
                       RTDB stores no nulls — "unresolved" is an ABSENT key; guards test `outcome == null`.
      results/tN     { correct, points, atStep, rangOut, wrongIso, wrongStep }
                     ← written ONLY by the resolveRound transaction (atomic with outcome)
      private/tN     { lockedRound, wrongStep, wrongIso }
                     ← own-phone plain write on a wrong ring; read ONLY by the resolveRound
                       transaction (to disclose at reveal, FILTERED on lockedRound===number, §4.3)
                       and by the owning phone on resume (§5). DROPPED at settlement (§4.3).
      revealAt       countdown target, set by the resolveRound transaction (S6, reused) — transaction-authored ts
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
  `currentStep` (for `atStep`), read `private/*` (for filtered disclosure), check
  `phase`/`round.number`/`outcome`, and write `outcome`, `results/*`, `phase`,
  and `teams/*` totals. All of those must be in **one** transactable ref, and the
  common ancestor of `round` and `teams` is `gameState`. It is tiny; one
  transaction per round-ending event is not extravagant (EM).
- **Plain writes into `gameState` children — and the same-client transaction
  cancel (v3.1 REQUIRED 1).** Cadence (`currentStep`/`stepStartedAt`), wrong-ring
  `private/*`, and the S6 hold (`autoAdvanceAt: null`) are single-owner/own-phone
  plain writes to children of the transacted ref. The interaction depends on
  **who** issues the plain write:
  - **From a *different* client:** a plain `set()`/`update()` concurrent with an
    in-flight resolution transaction simply causes Firebase to **re-run** that
    transaction's updater against the fresher server snapshot (desirable — the
    re-run picks up the latest `currentStep`). This is the behavior the win/bust
    arbitration relies on.
  - **From the *same* client (the correction):** a `set()`/`update()` at a path
    that **overlaps that client's own pending transaction path cancels the
    transaction** — the transaction callback fires with an abort whose error is
    `"set"`, and the transaction does **not** commit. The **one** client that
    mixes both is the **reveal owner**: its cadence writes to
    `gameState/round/currentStep` / `stepStartedAt` and its S6 hold write
    (`autoAdvanceAt: null`) share the `gameState` subtree with **its own**
    `resolveRound` (bust) and `advanceRound` transactions. A stray cadence tick
    firing between the owner deciding to bust and the bust committing would abort
    the owner's own bust with `"set"`.
  - **Mandate (v3.1):** the owner **cancels its cadence timer and any pending S6
    hold write *before* it attempts its own `resolveRound`/`advanceRound`
    transaction.** The existing "throttle canceled on phase change" discipline is
    **not sufficient** — the phase change is written *by* the transaction, so it
    has not committed yet at the moment the transaction starts; the cancel must
    happen **before** the transaction attempt, gated on `roundConduct` returning
    `resolve-bust`/`advance` for *this owner*, not on the phase having already
    flipped.
  - **Retry-on-`"set"` (v3.1):** if a `resolveRound`/`advanceRound` transaction
    nonetheless aborts with error `"set"` (a cadence/hold write slipped in), treat
    it as a **benign abort** and **retry on the next snapshot** (§4.2) — it is not
    a terminal outcome and must not be rendered as "round over."
- **`applyLocally: false` is mandatory on `resolveRound` and `advanceRound`
  (v3.1 REQUIRED 3).** See §3 (code) and §4.3 (why) — without it, a losing
  ringer's phone would optimistically apply a full settlement to its local cache,
  briefly leaking every rival's `private/*` into `results/*` on the shared
  `rooms/{CODE}` subscription and flashing a false "you won."
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
  on success, or `undefined` to abort. **Must return `undefined` on `gameState ==
  null`** (the empty-local-cache first run, §4.2) — it cannot resolve without
  state. Guards use `== null` for the unresolved outcome (an absent key, never a
  stored null). Guards, settlement, **`lockedRound`-filtered disclosure** (§4.3),
  and `atStep = gameState.round.currentStep` all live here — unit-testable
  without Firebase. This replaces v2's `adjudicateBuzz` + `settleFlip` with
  **one** function, since claim and settlement are now one atomic step.
- **`advanceState(gameState, fromRound, cfg) → gameState' | undefined`** — the
  pure core of the advance transaction (§4.4): `lobby → roundActive` (round 1)
  and `reveal → (roundActive | gameOver)`. Epoch-guarded (`phase`,
  `round.number`); idempotent; deterministic (fresh round derived from
  `(gameSeed, fromRound+1)`; `gameOver` decided by `gameWinner`). Resets
  `private: {}` and `results: {}` in the fresh round. Returns the full new
  `gameState` or `undefined`.
- `roundConduct(gameState, serverNow, isOwner, cfg) → "continue" | "resolve-win"
  | "resolve-bust" | "advance"` — the pure decision function each phone runs on
  every snapshot to decide *whether* to attempt a transaction (§4.4). `isOwner`
  selects the owner's step-completion bust vs. the non-owner's server-corrected
  dead-man deadline; also drives the reveal-phase advance fallback. (Never reads
  `round/private` — test-enforced, §5.2.)
- `gameWinner(teams, cfg) → tN | null` and `carryStandings(teams, winnerTeam) →
  {teams, hostTeam}` for game-over → next room (§7).
- `versionCompatible(room, bundled) → bool` — `room.datasetVersion ===
  bundled.datasetVersion && room.rulesVersion === bundled.rulesVersion` (§8.1).

### New glue

- `js/flag-ui.js` — the player phone: lobby/slot claim, buzzer surface, reveal
  render (used when no TV), reveal-owner cadence loop when this phone *is*
  `hostTeam`, and the `roundConduct`-driven transaction attempts. Logic-light;
  every rule calls into `flag.js`. **Subscribes** to `.info/serverTimeOffset`
  (re-estimated on every reconnect — a stale one-shot read is exactly what the
  server-corrected-clock fix exists to prevent) and exposes `serverNow() =
  Date.now() + serverTimeOffset`. When this phone is the reveal owner, it
  **cancels its cadence/hold timers before attempting its own
  `resolveRound`/`advanceRound`** (§2). It handles transaction aborts per the
  full taxonomy in §4.2 (retry benign aborts; never mis-render a swallowed
  correct ring as "round over").
- `js/screen-flag.js` — the TV renderer: subscribes, renders `currentStep` via
  `exposedAt`, standings, winner, crown. Writes only `screenHeartbeat`. **Runs no
  `roundConduct` transactions** (owner constraint #2). No authority.

### `js/firebase.js` additions — the terminal-outcome arbitration primitive (v3, `applyLocally` in v3.1)

```js
// v3: transact the ROUND'S TERMINAL OUTCOME (win OR bust) over the tiny
// gameState subtree. Epoch-guarded, idempotent, server-serialized. This REPLACES
// v2's claimBuzz. Only a phone that has evaluated its OWN guess as correct calls
// this with {kind:"win"}; the owner/fallbacks call it with {kind:"bust"}.
//
// The updater cannot flip a live outcome: it commits ONLY when phase is
// roundActive, round.number matches, and outcome == null. A stale-round op sees a
// mismatched round.number and aborts; a duplicate sees a non-null outcome and
// aborts. atStep is read from the SERVER snapshot's currentStep, never the client.
//
// v3.1: applyLocally:false is MANDATORY. The default (true) applies the updater's
// result OPTIMISTICALLY to the local cache and fires local onValue events on the
// ancestor rooms/{CODE} subscription — so a losing ringer's phone would briefly
// hold a full settlement locally: phase:reveal, itself as winner, and EVERY
// rival's private/* disclosed into results/* mid-round (a render-contract breach),
// plus a false "you won" flash, before the server rejects and re-runs. Disable it.
export async function resolveRound(code, attempt, cfg) {
  const res = await runTransaction(
    roomRef(code, "gameState"),
    (gs) => resolveOutcome(gs, attempt, cfg),   // pure (flag.js); returns gs' or undefined
    { applyLocally: false });                    // v3.1: no optimistic local settlement
  return res.committed;
}

// v3: epoch-guarded, idempotent round advance (reveal -> roundActive|gameOver,
// and lobby -> roundActive for round 1). Runnable by the reveal owner OR, past
// the reveal-phase dead-man deadline, ANY non-owner phone (never the TV). The
// fresh round is a deterministic function of (gameSeed, number), so racing
// advancers agree; the transaction makes it happen exactly once.
//
// v3.1: applyLocally:false here too — an optimistically-applied advance would
// flash the next round's blank state (and re-render every subscriber) before the
// server confirms the winner of the advance race.
export async function advanceRound(code, fromRound, cfg) {
  const res = await runTransaction(
    roomRef(code, "gameState"),
    (gs) => advanceState(gs, fromRound, cfg),   // pure (flag.js); returns gs' or undefined
    { applyLocally: false });
  return res.committed;
}
```

`roomRef` stays the only path composer; transactions stay the *only* non-`update`
writes. `claimTeamSlot` (verbatim) plus `resolveRound` and `advanceRound` are the
three transactional writes. All three are instances of the kernel's
**predicate-guarded compare-and-set over RTDB**; `resolveRound`/`advanceRound`
are its **round-scoped specialization** whose predicate is `(phase, epoch,
outcome)`, while `claimTeamSlot` is the **degenerate, guard-local** instance
(§9.2).

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
`claimTeamSlot`. No phase-changing write is a bare `update()`. All outcome guards
are written **`outcome == null`** (an unresolved outcome is an *absent* key, not
a stored null — §2).

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

### 4.2 The win path — with the full abort taxonomy (v3.1)

1. Player commits ISO `X` at the displayed `currentStep` (via typeahead, or a
   `flagSeed`-derived choice option unlocked at `choiceUnlockStep`, §1.3).
2. Phone computes `X === answerIso`.
   - **false →** plain write `gameState/round/private/tN = {lockedRound:
     round.number, wrongStep: displayedStep, wrongIso: X}`; disable the local
     buzzer for the round; return. (Round continues; emit `flag_ring`
     `correct:false`, §12.)
   - **true →** `resolveRound(code, {kind:"win", team: tN, roundNumber:
     round.number}, cfg)`, then branch on the result:
     - **`committed === true` → I won.** The transaction has *already* set
       `outcome`, `results/*`, `teams/*` totals, `phase: reveal`, and
       `revealAt`/`autoAdvanceAt` atomically. Render the reveal from the new
       state. Emit `flag_round` (§12) — this committing phone is the emitter.
     - **`committed === false` OR the call threw → do NOT assume "round over."**
       Re-read the current `gameState` snapshot and branch on the abort taxonomy
       below. The single governing rule (v3.1):
       > **On any abort where the snapshot still shows the *same* round active
       > (`round.number === my roundNumber ∧ phase === "roundActive" ∧ outcome ==
       > null`), or on a thrown error, RETRY the `resolveRound` attempt on the
       > next snapshot.** A correct first ring must never be silently
       > mis-rendered as "round over."

   **Abort taxonomy — every way `committed === false` (or a throw) can happen:**

   | # | Cause | Snapshot signature | Correct rendering |
   |---|---|---|---|
   | a | **Empty-local-cache first run.** `runTransaction`'s first invocation runs against the **local cache**; a just-reconnected phone can have an empty cache, so the updater is called with `gs == null`, and `resolveOutcome` returns `undefined` — aborting **without ever consulting the server**. (Uncommon; the reconnected-phone-attempting-a-fallback case.) | same round still active | **RETRY** (benign) |
   | b | **Transient network failure / retry exhaustion.** The SDK's own retry budget is exhausted, or the call rejects. | same round still active | **RETRY** (benign) |
   | c | **Same-client `"set"` cancel.** A cadence/hold plain write from *this* phone (only the owner) overlapped its own transaction path and cancelled it with error `"set"` (§2). | same round still active | **RETRY** (benign) |
   | d | **Rival win already committed.** `outcome.kind === "win"` and `outcome.team !== tN`. | resolved, other team | **"too late — someone rang first"**; emit `flag_ring` `contested:true` (§12) |
   | e | **OWN-team win already committed (v3.1 gap).** `outcome.kind === "win"` and `outcome.team === tN`. My commit *did* land, but the ack was lost before this phone learned it. | resolved, my team | **"you won"** — render the reveal from state. Do **not** show "too late." Do **not** double-emit `flag_round` (emit at most once, keyed on `roundKey`, §12). |
   | f | **Bust already committed.** `outcome.kind === "bust"`. | resolved, bust | **"round busted"** |
   | g | **Round genuinely advanced.** `round.number > my roundNumber` (or `phase` past `roundActive` for a later round). | new round | **"round over"** (the only case that legitimately renders this) |

   The v3.1 fix is that causes **a, b, c** — which v3 lumped into the
   "advanced round.number → round over" bucket — are now correctly retried, and
   cause **e** renders "you won" rather than "too late." Without this, a
   just-reconnected phone's correct first ring (a), a flaky-network correct ring
   (b), an owner's own correct ring cancelled by its own cadence tick (c), or a
   phone that actually won but lost the ack (e) would all be mis-shown as a loss.

Note: unlike v2 there is **no separate flip/settlement write** — the win
transaction *is* the settlement. `resolveOutcome` computes, from its snapshot:
`atStep = gameState.round.currentStep`; the winner's `points = scoreRing(atStep,
steps, base, min)`; `teams/{winner}/total = prior total + points` (absolute,
recomputed from the snapshot, never an increment); `teams/{winner}/reachedTotalAt
= round.number`; each `results/tN`; and `phase: reveal` + S6 fields.

### 4.3 Settlement is inside the transaction (no identical-shape race left)

`resolveOutcome` returns the **full replacement `gameState`** — the whole subtree
is replaced, so anything not carried forward is dropped. It builds the entire
reveal patch atomically:

```
outcome:  {kind:"win", team: winner, atStep}   // atStep = snapshot currentStep
phase:    "reveal"
round/results/{winner}: { correct:true, atStep, points: scoreRing(atStep,…), rangOut:false }
round/results/{other}:  { correct:false, points:0,
                          rangOut:   <from private/{other} IFF lockedRound===number, else false>,
                          wrongIso:  <from private/{other} IFF lockedRound===number, else absent>,
                          wrongStep: <from private/{other} IFF lockedRound===number, else absent> }
teams/{winner}/total:   <snapshot prior total + points>   (ABSOLUTE)
teams/{winner}/reachedTotalAt: round.number
round/revealAt, round/autoAdvanceAt                       (S6, reused)
// round/private is DROPPED (not carried into the replacement gameState) — the
// disclosed values now live in results/*; nothing else reads private post-settlement.
```

- **`private/tN` disclosure is filtered on `lockedRound` (v3.1 REQUIRED 4).**
  `private/tN` is a **plain, unguarded own-phone write** (it must be — it is the
  own-phone path, §5). A **delayed** wrong-ring write can therefore fabricate a
  disclosure in the **next** round:
  1. Player rings wrong in round N → their phone writes `private/tN =
     {lockedRound: N, wrongIso, wrongStep}`, but the write is **delayed** in
     flight.
  2. Round N resolves; `advanceState` opens round N+1 with `private: {}`.
  3. The straggler write lands — into round N+1's `private/tN` subtree.
  4. Round N+1's `resolveOutcome`, reading `private/tN` blindly, would stamp
     `rangOut: true, wrongIso: …` into N+1's results — **a comedy beat for a
     round the player never rang in.**
  The `lockedRound` field exists **precisely** to defeat this. **Rule:**
  `resolveOutcome` discloses `private/tN` into `results/tN` **only when
  `private.tN.lockedRound === gameState.round.number`**; otherwise it treats that
  player as not-having-rung (`rangOut: false`, no `wrongIso`/`wrongStep`). One
  line of pure-function logic. **Unit test (required):** a `private/tN` bearing a
  stale `lockedRound` (≠ current `round.number`) is **not** disclosed — assert
  the settled `results/tN.rangOut === false`.
- **No divergence on settled fields.** Because exactly one `resolveRound`
  transaction commits per round-ending event (server serialization), there is a
  *single* writer of `outcome`, `results/*`, and totals. v2's "identical-shape
  totals race" and its "wrong-ring disclosure divergence exception" are both
  **gone** — there is nothing to race. This is a net simplification (the EM
  predicted v3 "could become considerably simpler").
- **One residual, cosmetic:** a wrong ring whose `private/*` write lands *after*
  the winning transaction's snapshot (but bearing the *current* `lockedRound`) is
  **not disclosed** at reveal (the comedy beat is missed for that one ring). This
  is a *missed* disclosure, never a *divergent* one; it never affects totals,
  standings, winner, or phase (all computed from `round`/`teams`, never from a
  post-hoc read). Bounded and acceptable; state it. (If desired, the reveal UI may
  show "someone also rang" generically, but v3 does not require it.)

### 4.4 The fallbacks — `roundConduct`, now transaction attempts

Because the reveal owner is the sole cadence and advance writer, a dead owner
would hang the game. **Every phone** (never the TV, §6) runs `roundConduct` on
each snapshot and attempts the appropriate *transaction* (which is idempotent and
epoch-guarded, so duplicates are free):

- **`phase === roundActive`, `outcome == null`:**
  - **owner:** attempt `resolve-bust` when `currentStep === STEPS` and
    `serverNow() ≥ stepStartedAt + graceMs` (step-completion gate). *(The owner
    cancels its cadence timer before this attempt, §2.)*
  - **non-owner:** attempt `resolve-bust` when `serverNow() ≥ round.startedAt +
    STEPS·stepMs + 3·graceMs` (server-corrected dead-man deadline, §1.4).
  - (A `win` is attempted only by a correct ringer, §4.2 — not by
    `roundConduct`.)
- **`phase === reveal`, `outcome != null`, same `round.number`:** attempt
  **`advance`** (`advanceRound(code, round.number, cfg)`) when the advance is due:
  - **owner:** at `autoAdvanceAt` (S6 auto-advance), or on manual next. *(Cancels
    its S6 hold write before attempting, §2.)*
  - **non-owner (v3 reveal-phase fallback):** when `autoAdvanceAt` is non-null
    and `serverNow() ≥ autoAdvanceAt + 3·graceMs` — the dead-owner-during-reveal
    guard the EM required. `advanceRound` is epoch-guarded and idempotent, so a
    delayed or duplicate fallback is harmless.
- **else → `continue`.**

`advanceState` decides `reveal → gameOver` vs `reveal → roundActive` with
`gameWinner` (pure, deterministic on the snapshot + locked settings), so every
advancer agrees on the target; the transaction makes it happen exactly once.

#### The dead-owner degenerate loop after a fallback advance (v3.1 REQUIRED 6)

Follow the reveal-phase fallback one round further. A **non-owner's** fallback
`advanceRound` authors round N+1 correctly — but **the cadence writer for round
N+1 is still the dead `hostTeam`.** Nobody is advancing `currentStep`, so:

- `currentStep` **freezes at 1**; no further tiles de-occlude, no further
  sharpening. The round is stuck on a barely-revealed flag.
- The round can still **end** two ways: (a) a player who recognizes the flag from
  step 1 rings correct (a hard, "blind-ish" ring), committing a `win`; or (b) the
  **non-owner fallback bust** fires at `round.startedAt + STEPS·stepMs +
  3·graceMs` (~21 s with defaults) — note the deadline is anchored on
  `startedAt`, so it still arrives even though `currentStep` never reached
  `STEPS`.
- With a **permanently** dead owner, the game therefore settles into a
  **degraded steady-state cycle:** step-1-frozen round → (~21 s) bust → non-owner
  fallback advance → next step-1-frozen round → bust → … repeating until humans
  intervene.

This is **strictly better than v2's hard freeze** (the game keeps resolving
rounds and showing reveals, just slowly and under-revealed), and it is the
correct trade: **host-migration** — handing cadence ownership to a live phone —
introduces a *two-cadence-writers* race (two phones both advancing `currentStep`,
both busting) that is deliberately **out of scope**. The spec's position:
document the degenerate loop and its **human recovery** — *anyone taps "New Game"
to create a fresh room* (a live phone becomes the new `hostTeam`/cadence writer).
Do not attempt automatic host-migration in v1.

> **Remaining accepted corners (all narrower than v2's, with explicit human
> recovery):**
> 1. **Held-then-owner-dies.** If the owner deliberately held the reveal
>    (`autoAdvanceAt: null`) and then dies, no fallback fires (the hold is
>    intentional and respected). **Recovery:** a human creates a new room. This is
>    a deliberate-pause corner, not the "any dead owner at reveal freezes the
>    game" corner v2 accepted.
> 2. **Permanently-dead-owner degenerate loop.** The step-1-frozen → bust →
>    advance cycle above. **Recovery:** anyone taps "New Game."
> 3. **Lobby-dead-creator (v3.1).** If the creator (initial `hostTeam`) dies in
>    the lobby before starting round 1, no phone runs `advanceRound` from `lobby`
>    (round-1 start is owner-triggered). **Recovery:** anyone taps "New Game" /
>    creates a new room.
> 4. **Game-over → new-room handoff / gameOver-dead-winner (v3.1).** Creating the
>    *next game's room* + `nextRoom` pointer stays winner-owned (GeoParty parity,
>    §7). A dead winner at `gameOver` doesn't advance to the next *game* — but the
>    current game has fully resolved and displayed its crown. **Recovery:** anyone
>    taps "New Game." This is the standard GeoParty game-to-game exposure, not a
>    mid-game freeze.
>
> The v2 corner the EM explicitly rejected — a dead owner freezing the *round-to-
> round* reveal advance — is fixed by the reveal-phase fallback above; what
> remains is the slow, self-recovering degenerate loop (corner 2) and the manual
> recovery lines (corners 1, 3, 4).

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
- A duplicate `resolveRound` sees `outcome != null` and aborts; a duplicate
  `advanceRound` sees the already-advanced phase/number and aborts.

So the entire "stale write from a dying phone" class collapses into "the
transaction aborts." No separate settle-time epoch check is required, though the
renderers still ignore a `round` whose `outcome`/`number` they do not expect
(ordinary defensive rendering). Note the distinction from §4.2's benign aborts:
an abort caused by a genuine epoch mismatch (the round advanced) renders "round
over"; an abort caused by an empty cache, a network blip, or a same-client `"set"`
cancel is **retried** (§4.2), because the round is still live.

---

## 5. Private per-phone state (the second novel concept)

*(EM-approved; preserved. Only the storage location — inside `gameState/round` —
the single reader — the `resolveRound` transaction — and, in v3.1, the
`lockedRound` disclosure filter, are updated.)*

GeoParty has *zero* hidden information. Flag Reveal needs the wrong-ring lockout
to be private *during the round* — no other phone or the TV may learn, while play
is live, that or what a phone rang wrong. This forces a "private subtree" concept
the kernel does not have. §9 is honest about how far it actually goes.

### 5.1 The path and who reads it

- `gameState/round/private/tN = { lockedRound, wrongStep, wrongIso }`, written
  **only** by team tN's own phone (plain write), on a wrong ring. **`lockedRound`
  is the current `round.number`** — it stamps *which* round this lockout belongs
  to, and is the filter that defeats a straggler write leaking into the next
  round (§4.3).
- Read back **only** by the owning phone on resume (to restore its own lockout
  across a refresh — so a wrong-then-refresh phone stays locked out; local-only
  memory would lose this). The owning phone restores its lockout **only when
  `lockedRound === round.number`** (a stale `lockedRound` means the round already
  moved on — do not re-lock).
- Read by the **`resolveRound` transaction once, at settlement**, from its
  atomic `gameState` snapshot, **filtered on `lockedRound === round.number`
  (v3.1)**, solely to stamp `results/tN.{rangOut, wrongIso, wrongStep}` (a
  *post-round* disclosure, §5.3). No renderer, no other phone's live decision,
  ever reads it.

### 5.2 The contract — and its honest boundary

**Contract:** *no renderer and no live-play decision reads `round/private/*`.*
The scene builders in `screen-flag.js` and the live buzzer UI in `flag-ui.js` are
never handed `round/private` as input. The **only** reader is the `resolveRound`
transaction updater at settlement, and its output is disclosed only in
`phase: reveal`. Enforced by a test analogous to GeoParty's Decoy "hidden-in-play"
test: assert the render/scene functions and `roundConduct` never read
`round/private`. *(v3.1 note: `applyLocally: false` on `resolveRound`, §3, is part
of upholding this contract — without it, the transaction's optimistic local apply
would surface disclosed `private/*` values into `results/*` on the shared
`rooms/{CODE}` subscription mid-round, defeating the render-discipline contract
before the server even confirms the outcome.)*

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
  `round/private/*` from its snapshot (filtered on `lockedRound === round.number`,
  §4.3) and surfaces `{rangOut, wrongIso, wrongStep}` into each non-winner's
  `results/tN`. The reveal plays the **full comedy beat** — *"OHHH, Dave rang
  Belgium at step 2!"* — with **zero strategic leak**, exactly like §1.5's "ohh,
  it was Chad!" payoff. This dominates boolean-only disclosure and
  public-with-penalty: all the suspense of private, nearly all the table energy
  of public. The EM called this decision "excellent."
- Because disclosure is now *inside* the atomic resolution transaction, there is
  no disclosure-divergence exception (contrast v2 §4.3). The only residual is a
  wrong ring whose `private/*` write lands after the winning snapshot — *missed*,
  not divergent (§4.3) — and a straggler from a prior round is filtered out
  entirely by `lockedRound` (v3.1, §4.3).

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
  *between rounds* (and the v3.1-documented degenerate loop under a *permanently*
  dead owner, §4.4).
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
- **The game-over → new-room handoff remains winner-owned** (GeoParty parity). A
  dead winner at `gameOver` is a narrow remaining exposure (§4.4 corner 4) with a
  manual recovery ("anyone taps New Game"); it is a between-*games* corner, not
  the between-*rounds* freeze the EM rejected.

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

This is the experiment's payload. v3 revised §9.2 and §9.4 per the EM: the
reusable primitive is bigger and cleaner than v2 claimed. v3.1 sharpens §9.1/§9.2
per Fable: `claimTeamSlot` is **not** an instance of the epoch-guarded arbitration
— it is the degenerate, guard-local ancestor of it.

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
| **`claimTeamSlot` transaction** | Verbatim for slot claiming — the **degenerate, guard-local** instance of the kernel's predicate-guarded CAS; *not* an epoch-guarded arbitration (§9.2). |
| "Local until commit" pattern (SUPER SURE arming) | Reused: correctness is decided *locally* and only *committed* via the resolution transaction; wrong rings never leave the phone except as private state. |
| Consent/analytics seam | Extend `EVENT_SCHEMA`; aggregates only (§12). |

*What v2 listed here but v3 folds into §9.2:* the "reveal-flip identical-shape
settlement race" and the separate "deadlock / fallback-flip guard." v3 has **no**
non-transactional settlement race to inherit — settlement is inside the
resolution transaction (§4.3). The deadlock/fallback guard is now an idempotent
epoch-guarded transaction, which is the round-scoped specialization of the *same*
kernel primitive as the buzzer, not a separate reused mechanism (§9.2).

### 9.2 BREAKS — must rewrite: from "contended claim" to "terminal-state arbitration" (v3), with the primitive named precisely (v3.1)

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
- **The corrected extracted primitive — stated as a two-level hierarchy (v3.1).**
  Fable's sharpening: do **not** call all three transactional writes "the same
  epoch-guarded arbitration primitive." They are not the same — `claimTeamSlot`
  has **no epoch and no phase guard**. The precise formulation is a hierarchy:
  - **Kernel primitive:** a **predicate-guarded compare-and-set via an RTDB
    transaction** — *"commit a write only if the current snapshot satisfies a
    predicate; the server serializes; the loser aborts client-side."* This is what
    the Firebase layer already provides.
  - **Round-scoped specialization (the thing this experiment *forced into
    existence*):** **epoch-guarded terminal-state arbitration** — the same CAS
    where the predicate *must* include `(phase, epoch, outcome)` and where the
    transaction *also settles all dependent state atomically and reads any
    time/step input from the server snapshot, not the client.* `resolveRound` and
    `advanceRound` are its two instances (round resolution, round advance).
  - **`claimTeamSlot` is the degenerate instance:** a plain predicate-guarded CAS
    ("claim if the slot is vacant") with **no epoch and no phase** in its
    predicate. It is precisely the case whose guard *can* stay local — and it is
    exactly what **misled v2** into believing a *contended* claim's predicate
    (buzzer, resolution) could also stay local. It could not: the moment the
    predicate must span `(phase, epoch, outcome)` and the write must settle
    dependent state, the guard-local shortcut becomes the three blockers.
  - So the experiment's payload is *upward*: the buzzer forced the kernel to
    recognize that its ad-hoc concurrency devices (the `claimSlot` CAS, the
    reveal-flip identical-shape race, the deadlock fallback, and the round epoch)
    are a **degenerate CAS plus a missing specialization of it** — epoch-guarded
    terminal-state arbitration — not four separate mechanisms. This is both more
    correct and simpler (the EM: v3 "could become considerably simpler as well as
    actually implementation-ready").

### 9.3 BREAKS — must rewrite: private state (and it only half-works)

*(Unchanged in substance from v2/v3; EM-endorsed.)*

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

### 9.4 Net (revised per EM, sharpened per Fable)

The extraction hypothesis is **not** "holds for every synchronization mechanism"
as v2 claimed. More precisely:

- The **stateless/disjoint mechanisms** (phase machine shape, throttle,
  seed/cursor derivation, heartbeat/next-room chain, `hostTeam` rotation, the
  "local until commit" pattern) reuse cleanly.
- The **concurrency model** does *not* reuse as-is: building a buzzer forced the
  kernel to discover that its several ad-hoc concurrency devices (the `claimSlot`
  CAS, the reveal-flip identical-shape race, the deadlock fallback, and the round
  epoch) are **facets of one hierarchy** — a **predicate-guarded CAS** whose
  **round-scoped specialization** is *epoch-guarded terminal-state arbitration
  over a small authoritative subtree.* `claimTeamSlot` is the degenerate,
  guard-local base case; `resolveRound`/`advanceRound` are the specialization that
  the experiment actually needed and that v2 was missing. That is the real, and
  more valuable, extraction finding; v2's "epoch-guarded buzzer claim" was too
  small a lesson, and calling all three "the same primitive" (v3's wording) blurred
  the very distinction that explains v2's error.
- The **privacy concept** reuses only render-deep — a hard ceiling (§9.3).

Two invariants broken; one concurrency *model* unified upward into a stronger
primitive (with its degenerate base case now correctly distinguished); one
privacy concept capped. That is the maximal-signal-per-build outcome the
experiment wanted — and it is a *sharper* payload than v2 reported, because the
EM's blockers (and Fable's primitive-naming) are exactly what revealed the
hierarchy.

---

## 10. Wrong ring — private during the round, disclosed at reveal (decision preserved)

**Decision (EM-approved): PRIVATE during the round, FULL disclosure at the
reveal** — surface `{rangOut, wrongIso, wrongStep}` per non-winner at settlement
(§5.3), filtered on `lockedRound === round.number` (§4.3). The optional
non-identifying "rings so far: N" tension counter stays **OFF for v1** and is
noted as undesigned.

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
attempt a *legal, idempotent, epoch-guarded* transition). Guards below test
`outcome == null` / `outcome != null` (an absent key, not a stored null — §2):

| from | to | who / when | primitive |
|---|---|---|---|
| lobby | roundActive | reveal owner starts round 1 | `advanceRound` (epoch-guarded specialization) |
| roundActive | reveal | correct ring (`win`) or bust (owner/fallback); guard: `phase===roundActive ∧ round.number===N ∧ outcome==null` | `resolveRound` (epoch-guarded specialization) |
| reveal | roundActive | reveal owner (or S6 auto-advance), **or non-owner reveal-phase fallback** (§4.4), when more rounds remain and no `target` reached; guard: `phase===reveal ∧ round.number===N ∧ outcome!=null` | `advanceRound` |
| reveal | gameOver | same as above when `gameWinner` is decided | `advanceRound` |
| gameOver | — | terminal; winner's phone writes the next room + `gameSeed` + locked settings + `nextRoom` | (new room) |

Illegal transitions (e.g. `roundActive → gameOver` directly, or `reveal →
reveal`) are rejected inside the transaction updater. Because both fallback
writers compute their target with the same pure `advanceState`/`resolveOutcome`
functions and the transaction is idempotent, they never produce an illegal or
divergent transition. A held reveal whose owner then dies is one narrow stall
(§4.4 corner 1); the *permanently* dead owner produces the self-recovering
degenerate loop (§4.4 corner 2); ordinary dead-owner-at-reveal is covered by the
reveal-phase fallback. `claimTeamSlot` is **not** in this table — it changes no
phase and is the guard-local base primitive, not an epoch-guarded transition
(§9.2).

---

## 12. Instrumentation (mandatory — CLAUDE.md)

Extend `EVENT_SCHEMA` (the hard allowlist); aggregates only, never answer text,
guesses, ISO codes as free strings, team names, room codes, or anything
identifying. Slot ids (`tN`) **are** permitted (CLAUDE.md explicitly allows slot
ids in analytics properties). Two events, with the v3 property additions and the
v3.1 dedup/emission fixes:

- **`flag_ring`** — one per ring, emitted by the **ringing phone**. Props:
  - `mode` (`tv`|`phone`).
  - **`team`** (`tN` — the ringing phone's slot id; v3.1). This is what lets the
    downstream `ringCount` reconstruction distinguish *players*, which the v3 key
    could not (see below). Slot ids are an allowed, non-identifying property.
  - `atStep` (int) — **what each ring emits (v3.1 makes this exhaustive):**
    - **wrong ring:** the phone's **displayed** step at the moment it rang (it has
      no snapshot; the displayed step is the honest local value).
    - **winning ring:** the settled **`outcome.atStep`** from the committed
      transaction (server-authoritative).
    - **losing-correct ring (v3.1 — previously unspecified):** the ring's own
      **displayed** step at commit (the same value the phone attempted). This
      phone lost the race so there is no `outcome.atStep` *for it*; the displayed
      step is what is available and is the meaningful "when did they try" value.
  - `correct` (bool).
  - `points` (int, 0 for wrong or losing-correct).
  - `contested` (bool — a *correct* ring whose `resolveRound(win)` aborted on a
    pre-existing **rival** `win`, i.e. it lost the race; §4.2 case d).
  - **`difficulty`** (v3), **`inputMode`** (v3).
  - **`roundKey`** (v3 — a non-identifying deterministic round id = a truncated
    `hash(gameSeed, round.number)`; `gameSeed` is random, so this is not
    identifying).

  **Feeds the headline KPI:** *are correct rings actually colliding* (the
  experiment's success condition)?

- **`flag_round`** — one per round at reveal, emitted by **the phone whose
  `resolveRound` transaction committed** (§4.2). Emission is **at-most-once**
  (v3.1), not exactly-once: exactly one transaction *commits* per round-ending
  event (server serialization), but the committing phone can crash between commit
  and emission and lose the event. So exactly-once is a property of the **commit**,
  not the **emission** — an occasional missing `flag_round` (never a duplicate) is
  expected and acceptable. (This still fixes v2's "potentially one `flag_round`
  per connected phone"; the guarantee is now *at most one per round*, honestly
  stated.) Props: `mode`, `outcome` (`won`|`busted`), `winningStep` (int|null),
  **`difficulty`** (v3 — enables the "bust rate by difficulty tier" KPI the schema
  previously couldn't support), **`inputMode`** (v3 — probably the strongest
  explanatory variable), `roundNumber`, **`roundKey`** (v3).

  *`ringCount` is **not** a property of `flag_round`* — it cannot be reconstructed
  from persisted round state (losing correct claimants abort and are stored
  nowhere). Instead it is **reconstructed downstream** as the count of distinct
  `flag_ring` events sharing a `roundKey`, **de-duplicated on `(roundKey, team,
  correct)`** (v3.1).

**The dedup-key fix (v3.1 REQUIRED 7).** v3 de-duplicated on `(roundKey, atStep,
mode, correct)`. That key does **not distinguish players**: two *different* phones
ringing at the same step with the same correctness collapse into **one** event —
which is exactly the collision the experiment is trying to measure. The success
condition is "are two `correct:true` rings landing in the same round (frequently
at the same step)?", and the v3 key erased precisely that signal. Dedup on
**`(roundKey, team, correct)`** instead:

- It absorbs PostHog delivery duplication (the same phone's same ring re-delivered
  is one `(roundKey, team, correct)` tuple).
- It preserves *distinct players* (two `correct:true` rings from `t1` and `t2` in
  the same round are two tuples → `ringCount` counts both → the collision is
  visible).
- `atStep` is intentionally **dropped from the dedup key**: a single player rings
  at most once per correctness class per round (a wrong ring locks them out; a
  correct ring resolves or is retried to the same outcome), so `(roundKey, team,
  correct)` already uniquely identifies a real ring — including `atStep` would
  let a client-side step re-estimate spuriously split one player's ring into two.

Notes:

- **`wrongIso` is disclosed in the room UI at reveal** (party value, §5.3) but is
  **never** emitted to analytics — no ISO codes as free strings, per the schema
  allowlist.
- **`roundKey` is derived from `gameSeed`, never from the room code** (the room
  code is on the party's TV and is treated as identifying for masking, §13). It
  gives analytics a stable join key without leaking identity.
- Add sanitizer tests in the new repo's `tests/analytics.test.js` (assert no
  coordinate-shaped, ISO-shaped, room-code-shaped, or free-text keys survive; and
  that `team` is a bare `tN` slot id, not a name), and document both events, their
  KPIs, and the downstream `ringCount` reconstruction (including the
  `(roundKey, team, correct)` key) in the repo's `docs/analytics.md`. If an event
  is judged to add no signal, say so explicitly in the change summary rather than
  skipping silently.

---

## 13. What must NOT change

- **Consent gating is inviolable.** All capture through `track()`/`trackError()`
  from `consent.js`; never reference PostHog directly; never capture pre-opt-in;
  never weaken banner/revoke. Aggregates only (§12). `POSTHOG_INIT_OPTIONS` stays
  mutable.
- **`roomRef()` stays the sole room path choke point.** Every
  read/write/subscribe/transaction routes through it.
- **Transactions stay the ONLY non-`update()` writes, and there are three —
  `claimTeamSlot`, `resolveRound`, `advanceRound`.** They form a **two-level
  hierarchy**, not one flat primitive (v3.1): the kernel primitive is a
  **predicate-guarded compare-and-set via RTDB transaction**; `resolveRound`/
  `advanceRound` are its **round-scoped specialization**, *epoch-guarded
  terminal-state arbitration*, whose predicate is `(phase, round.number,
  outcome)`; `claimTeamSlot` is the **degenerate, guard-local** base case (no
  epoch, no phase). Every **phase-changing** write is an epoch-guarded transaction
  guarded on `(phase, round.number, outcome)`; no phase change is a bare
  `update()`. This is the v3 correctness spine (EM blockers 1–3); do not collapse
  the hierarchy back into "all three are the same primitive" (§9.2).
- **`applyLocally: false` on `resolveRound` and `advanceRound` (v3.1).** Both
  transactions MUST pass `{ applyLocally: false }`. The default optimistic local
  apply would surface a full settlement into the local cache — leaking every
  rival's `private/*` into `results/*` on the shared `rooms/{CODE}` subscription
  mid-round and flashing a false "you won" — before the server confirms the
  outcome (§3/§4.3).
- **Settlement is atomic with the outcome.** The winner/points/totals/results/
  phase are all written by the single committed `resolveRound` transaction, using
  **absolute** totals recomputed from the snapshot (never increments) and
  **`atStep` read from the server snapshot** (never the client). No separate
  settlement `update()` exists. `private/*` disclosure at settlement is **filtered
  on `lockedRound === round.number`** and `private/*` is **dropped** from the
  replacement `gameState` (v3.1, §4.3).
- **The owner sequences its own plain writes before its own transactions
  (v3.1).** Because a same-client `set()`/`update()` at an overlapping path
  cancels that client's pending transaction with error `"set"`, the reveal owner
  MUST cancel its cadence/hold timers **before** attempting its own
  `resolveRound`/`advanceRound`; a `"set"`-aborted transaction is retried on the
  next snapshot (§2/§4.2). "Canceled on phase change" is not sufficient — the
  cancel precedes the phase-change commit.
- **The abort taxonomy is exhaustive and never mis-renders a correct ring
  (v3.1).** A failed `resolveRound(win)` is branched per §4.2: retry the benign
  aborts (empty-cache first run returning `undefined`, transient network / retry
  exhaustion, same-client `"set"` cancel); render "you won" for an own-team
  pre-existing win; and reserve "round over" for a genuinely advanced round.
  `resolveOutcome` returns `undefined` on `gameState == null`, and all outcome
  guards use `== null` (an absent key, never a stored null).
- **Throttle ≤4 writes/s per writer.** Cadence and any live mirror obey the
  dirty-flag + 250 ms pattern, canceled on phase change (and on the owner's own
  pre-transaction cancel, §2).
- **Clocks never ticked through Firebase; skew never flips an outcome.** Score
  clock = the single-writer `currentStep` integer read from the transaction
  snapshot; the owner's bust gate is step completion; **non-owner deadlines use
  server-corrected time** subscribed from `.info/serverTimeOffset` (§1.4, §3).
  **Timestamps authored *inside a transaction* (`startedAt`, round-start
  `stepStartedAt`, `revealAt`, `autoAdvanceAt`) are writer offset-estimates, not
  true server stamps** (v3.1 — the `ServerValue.TIMESTAMP` sentinel cannot pass
  through a compare-and-set; §1.4). The design tolerates this because every
  consuming deadline carries ≥ 3·`graceMs` (9 s) of slack, far above realistic
  offset-estimate error. Do not "fix" the token behavior and do not trust a
  transaction-authored stamp to sub-second precision.
- **Private is render-discipline, not transport.** No renderer and no live-play
  decision reads `round/private/*`; the only reader is the `resolveRound`
  transaction at settlement, filtered on `lockedRound` (§4.3/§5). Test-enforced,
  and reinforced by `applyLocally: false` (above).
- **Pure/glue split.** Decision logic in `flag.js` (tested); `flag-ui.js` /
  `screen-flag.js` stay thin. Every feature ships tests + instrumentation.
- **Passive TV.** The TV writes only `screenHeartbeat`; it never gains authority,
  a timer, or a fallback transaction (owner constraint #2, §6).
- **`hostTeam`-rotation (per game), `nextRoom`+`followedCodes`, S7 skew-proof
  liveness, S6 auto-advance** all reused verbatim; the S6 advance is now the
  `advanceRound` transaction with a non-owner reveal-phase fallback (§4.4). The
  permanently-dead-owner degenerate loop and the lobby/gameOver dead-actor corners
  recover manually ("anyone taps New Game", §4.4).
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
   non-owner deadlines use server-corrected time; transaction-authored timestamps
   are offset-estimates, not true server stamps (v3.1).
6. **Vendor the flag SVGs (§8),** justified by offline-cache + no-CDN, not
   `file://`.
7. **The extraction framing (§9).** The mechanism (transactions) already exists;
   what the experiment forces is *promoting* the kernel's degenerate
   predicate-guarded CAS into its **round-scoped specialization** — *epoch-guarded
   terminal-state arbitration* — covering resolution, settlement, and advance — and
   discovering a *hard ceiling* on privacy (render-deep only). `claimTeamSlot` is
   the degenerate base case, not an instance of the specialization (v3.1).

## 15. Traceability — how the reviews map to sections

For reviewers checking coverage.

### Fable's v3.1 REQUIRED changes → sections

- REQUIRED 1 (same-client `"set"` cancel; owner cancels timers before its own
  transaction; retry `"set"` aborts) → §2, §4.2, §4.4, §13.
- REQUIRED 2 (exhaustive abort taxonomy; retry benign aborts; own-team
  pre-existing win → "you won") → §1.2, §4.2, §4.5, §13.
- REQUIRED 3 (`applyLocally: false` on `resolveRound`/`advanceRound`) → §3
  (code), §4.3, §5.2, §13.
- REQUIRED 4 (`lockedRound`-filtered disclosure; unit test) → §4.3, §5, §13.
- REQUIRED 5 (transaction timestamps are offset-estimates, not server stamps) →
  §1.4, §2 (field comments), §13.
- REQUIRED 6 (dead-owner degenerate loop + human recovery) → §4.4, §7.
- REQUIRED 7 (`flag_ring` dedup key `(roundKey, team, correct)`; losing-correct
  `atStep`; `flag_round` at-most-once) → §12.

### Fable's v3.1 RECOMMENDED changes → sections

- RECOMMENDED 8 (residual note: commit-latency vs. display-staleness; TV-scoped
  "never visibly unfair"; no-inflation property) → §1.4.
- RECOMMENDED 9 (sharpen `claimTeamSlot` — degenerate CAS, not epoch-guarded
  arbitration; two-level primitive hierarchy) → §9.1, §9.2, §9.4, §11, §13.
- RECOMMENDED 10 (subscribe to `.info/serverTimeOffset`; `== null` guards;
  `resolveOutcome` returns full replacement + drops `private/*`; lobby/gameOver
  dead-actor recovery lines) → §1.4, §3, §4.2, §4.3, §4.4, §7, §11.

### v3's EM-review changes → sections (unchanged lineage)

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
