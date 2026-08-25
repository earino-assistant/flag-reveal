# Framework Extraction Plan — GeoParty × FlagParty → `party-kernel`

**Prepared by:** Ox (senior architect review)
**Status:** Proposal — ready to save as `docs/framework-extraction-plan.md` in whichever repo hosts the workstream

---

## Executive Recommendation

**Extract some, now — but treat the first six weeks as a *port*, not a *product*.** The two codebases already contain a de-facto kernel that is duplicated rather than shared: `qr.js` is byte-identical, `roomcode.js`/`makeRoomCode` are twins, `analytics.js`/`consent.js` are modeled-on copies, `partyrecap.recordPartyRound` is the same idempotent fold twice, `confettiSpec`/`celebrationSpec` were explicitly cribbed, and the Firebase helper layer is 90% congruent. That duplication is actively forking today (two PRNG hash families, two auto-advance policies, two heartbeat readers, two scrubber strictness levels), so waiting raises the eventual port cost. Extract a **small, dependency-free `party-kernel` repo (~14 JS modules + a contract-test harness + a doctrine doc)**, distribute it as a **git submodule pinned per game** (fallback: vendored snapshot with a hash-drift test — the layout is identical, so the choice is reversible), and port via a **facade-first** strategy that keeps every controller's import paths stable. Total effort ≈ **10–16 focused senior-days** across 7 independently shippable phases; nothing merges unless both live games are green and smoke-passed. Freeze kernel scope at the two-proofs list below — everything single-proof stays home. The deliverable that matters is not the package; it is `CONTRACTS.md` (write taxonomy, clock doctrine, masking, determinism) plus a new-game quickstart, because that is what actually compresses the next fun-test cycle.

---

## 1. The Kernel Seam

### 1.1 What goes IN (proven by both games)

| Kernel module | Contents | Proven by | Source |
|---|---|---|---|
| `js/prng.js` | `mulberry32` (byte-identical both sides) + both string hashes (`fnv1a32Str` from `pool.js#hashSeed`, `xmur3` from `flag.js#hashSeed`) exported separately — see §2.3 freeze rule | Both | `geoparty/js/pool.js`, `flagparty/js/flag.js` |
| `js/roomcode.js` | `makeRoomCode`, `isValidRoomCode`, `ROOM_TTL_MS`/`isRoomStale`, `TV_VIAS`, `emitsScreenJoined`, `screenQuery`, `deviceId`, `cleanCodeInput` | Both | `flagparty/js/roomcode.js` (superset) + `geoparty/js/game.js#makeRoomCode` + `frontdoor.js#cleanCodeInput` |
| `js/rooms.js` | `createRooms(firebaseConfig)` factory → `roomRef` chokepoint, `readRoom/writeRoom/updateRoom/deleteRoom/subscribeRoom`, `writeScreenHeartbeat/subscribeHeartbeat`, `onConnectionChange`, `subscribeServerTimeOffset`, **`transaction(code, relPath, updater)`** (always `{applyLocally:false}`), `claimTeamSlot(code, basePath, teamId, team)`, `claimRoomCode` (collision-safe create with stale reclaim) | Both | `geoparty/js/firebase.js`, `flagparty/js/firebase.js` (`claimRoomCode`, `resolveRound`, `advanceRound`) |
| `js/phases.js` | `definePhases(names, edges) → canTransition` (~20 lines). Host-authoritative games use the table; peer-arbitrated games bake guards into transaction updaters (see §2.3) | Both (two styles) | `game.js#TRANSITIONS`, `h2h.js#H2H_TRANSITIONS`, implicit guards in `flag.js#resolveOutcome/advanceState` |
| `js/deadlines.js` | `autoAdvancePatch/holdAdvancePatch/autoAdvanceStatus/shouldAutoAdvance/advanceTarget/countdownText` — the shared-stamp countdown machine, verbatim | GeoParty (full); FlagParty (cousin policy, composes later) | `geoparty/js/autoadvance.js` |
| `js/heartbeat.js` | Writer `startHeartbeat(code, intervalMs)` + reader fold `foldHeartbeat/screenLive` with receipt-stamping and the ancient-beat guard | Both (GeoParty's reader strictly dominates; parameterize window) | `geoparty/js/couchscreen.js#foldHeartbeat`, `flagparty/js/screen-flag.js#startHeartbeat` |
| `js/analytics-core.js` | Consent get/set, `sanitizeProps/sanitizeEvent` (allowlist + types + `BANNED_KEY_RE` **as config** + digit-run threshold as config), `createTracker` (gate → queue-before-load → decline-wins-races → revoke), PostHog init **template** (EU host, `maskAllInputs`, `maskTextSelector:"[data-ph-mask]"`, canvas off, autocapture button/a allowlist) | Both | `geoparty/js/analytics.js`, `flagparty/js/analytics.js` |
| `js/consent-ui.js` | Injected banner, `openBanner/closeBanner`, surface detection hook | Both | `flagparty/js/consent.js` (simple shape); GeoParty extends with report link + release stamping |
| `js/dom.js` | `escapeHtml` (union charset — GeoParty's also escapes `'`), `toast` | Both | `flagparty/js/ui-common.js`, `geoparty/js/revealmap.js#escapeHtml` |
| `js/share.js` | `withUtm`, the Web-Share→clipboard→toast ladder, `shareToastText` | Both | `geoparty/js/share-ui.js#shareResult`, `flagparty/js/share-ui.js#shareText` |
| `js/qr.js` | Verbatim move | Both (already verbatim) | identical file in both repos |
| `js/confetti.js` | `confettiSpec` + reconciled `celebrationSpec` (drop GeoParty's `sound`/`spread` into its own fx layer; normalize `count` naming; accept a team-color resolver instead of FlagParty's hardcoded `t[1-4]` regex) | Both | `geoparty/js/fx.js`, `flagparty/js/flag.js §12b/§12c` |
| `js/recap.js` | `appendIdempotent(history, item, key)` — the same-ref-on-duplicate fold both recaps reduce to | Both | `geoparty/js/partyrecap.js#recordPartyRound`, `flagparty/js/partyrecap.js#recordPartyRound` |
| `js/daily.js` | Calendar math (`dailyKey`, `keyToUtcMs`, `dailyNumber(epoch)`, `dailyKeyFromNumber`, `daysBetweenKeys`) + validated replay-lock `load/save` (per-slot keys for GeoParty's hard mode) | Both | `geoparty/js/daily.js`, `flagparty/js/daily.js` |
| `js/nextroom.js` | `shouldFollowRoom(room, currentCode, followedCodes)` + pointer-write-ordering note | Both | `flagparty/js/flag.js §12` (extracted); `player-ui.js#followNextRoom` + `screen-ui.js#followedCodes` (inline) |
| `css/tokens.css` | The `:root` ink ramp/team colors (already identical values) | Both | both `css/style.css` headers |
| `contract/*.test.js` | Generalized harness: `console-scrub` (the lexer!), `html-contract` (ids/handlers/masks/SDK-pin), `track-schema`, **new** `sync-discipline` lint (§2.3), mask-checklist parser | Both | `tests/console-scrub.test.js`, `tests/html-contract.test.js`, `tests/track-schema.test.js`, `flagparty/tests/privacy.test.js` |
| `docs/CONTRACTS.md`, `docs/NEW-GAME.md` | The doctrine (§2.3) and the fun-test quickstart | — | distilled from both CLAUDE/spec traditions |

### 1.2 What stays OUT (do not force it)

- **Content pipelines:** Mapillary viewer + `imagery.js` observability + `pool.js` difficulty tiers (GeoParty); `flags-data.js`/`reveal-render.js`/`chooseOptions` (FlagParty). These *are* the games.
- **Mechanics:** `supersure.js`, `decoy.js`, `modifier.js`, `twist.js`, `night.js`, `ghost.js`, `records.js`, `hints.js` — GeoParty content. `flag.js`'s `resolveOutcome/advanceState/roundConduct/scoreRing/gameWinner/carryStandings` — FlagParty content (these are the *game brains*; the kernel hosts only the transaction *wrapper* they plug into).
- **Render domains:** `revealmap.js` scene system, `recap-ui.js` carousel, Leaflet glue — map-shaped. FlagParty's recap is DOM-shaped. Same pattern, different bodies; share only `appendIdempotent`.
- **Single-proof systems (candidates, not kernel):** `chrome.js` calm/play predicates, fx sound specs/tick scheduler, `tvlink.js` site-address lines, `team-names.js`, GeoParty's `trackError`/release-stamp/one-shot-diagnostics extensions, FlagParty's audio `primeAudio` unlock. Revisit when game #3 needs one — that's the two-proofs rule doing its job.

### 1.3 What a new game touches on day one (the funnel this buys)

Clone template → `createRooms(config)` + `claimRoomCode` + `claimTeamSlot` → `definePhases` or a transaction core → subscribe-and-render loop → heartbeat TV attach → `deadlines` stamp → analytics schema (≈30 lines of allowlist) + `consent-ui` → `share`/`qr` → `confetti`. That is the entire boilerplate tax on a new mechanic, and it's the metric this whole exercise is judged by.

---

## 2. The Port Map

### 2.0 The governing trick: **facade-first**

Keep every existing filename controllers import from; swap the *body* to delegate to the kernel. Controllers don't change; diffs stay reviewable; rollbacks are one-file reverts.

```js
// geoparty/js/firebase.js (after port) — same public API, new guts
import { createRooms } from "../../vendor/kernel/js/rooms.js";
const R = createRooms(firebaseConfig);
export const roomRef = R.roomRef;
export const readRoom = R.readRoom;
/* … */
```

Apply the same pattern to `analytics.js`, `consent.js`, `share-ui.js`, `daily.js`.

### 2.1 GeoParty port map

| Action | Items |
|---|---|
| **Move to kernel (import swap)** | `game.js`: `makeRoomCode/isValidRoomCode`; `frontdoor.js#cleanCodeInput`; all of `firebase.js` (via `createRooms`; keep local facade); `autoadvance.js` wholesale; `pool.js`: `hashSeed/mulberry32/shuffledPool` PRNG half; `analytics.js`: consent + sanitizer + tracker core (**keep local:** `EVENT_SCHEMA`, `EXCEPTION_PROPS`, `RELEASE_PROPS`, `maskNetworkRequest`, `oneShotInitOptions`, `sendDiagnostic`, `register/startRecording`); `consent.js` banner half; `qr.js` (delete); `share.js#withUtm` + `share-ui.js#shareResult` ladder; `partyrecap.js` idempotency → `appendIdempotent`; `fx.js#confettiSpec/celebrationSpec` (reconciled); `couchscreen.js#foldHeartbeat/screenLive` → kernel heartbeat; `daily.js` calendar+lock halves; inline nextRoom decision in `player-ui.js`/`screen-ui.js` → `nextroom.js`; `css/:root` tokens |
| **Thin adapter** | `firebase.js`, `consent.js`, `share-ui.js` facades; `pool.js` keeps difficulty/lead logic over kernel prng |
| **Stays put** | viewer/imagery/pool-tier logic, `h2h.js`, `game.js` scoring/turn schedule, `supersure/decoy/modifier/twist/night/ghost/records/hints/chrome/fx(sound)/team-names/tvlink`, all `revealmap*`/`recap-ui`, all page controllers |

**Port-time verifications (blocking):**
1. **Rules check for `claimRoomCode`:** FlagParty's `database.rules.json` permits deleting rooms with `createdAt` older than 24h, which stale-reclaim relies on. GeoParty's rules aren't in the provided source; its janitor only deletes *own* rooms. If GeoParty rules lack the time-based delete, ship kernel `claimRoomCode(..., { reclaimStale:false })` there (falls back to its current retry loop semantics) and file a rules update.
2. **PRNG freeze:** GeoParty's daily order derives through `pool.js#hashSeed` (FNV family). Swapping hash families mid-flight would reshuffle *today's* Daily and trip `recap.js`'s skew guard. Rule: kernel exposes both hashes; each game freezes its choice as content identity (FlagParty already does this instinctively via `DATASET_VERSION`/`RULES_VERSION` in `config.js` — adopt the same declaration in GeoParty docs).

### 2.2 FlagParty port map

| Action | Items |
|---|---|
| **Move to kernel** | `roomcode.js` wholesale (it's the kernel's origin); `qr.js` (delete); `firebase.js` helpers via `createRooms` — **but `resolveRound`/`advanceRound` wrappers stay local**, rebuilt in ~10 lines atop kernel `transaction()` binding `flag.js#resolveOutcome/advanceState`; `claimTeamSlot(code, "gameState", …)`; `claimRoomCode`; analytics core (local `EVENT_SCHEMA` + its stricter `BANNED_KEY_RE` including `iso|country|room|code` passed as config); `consent.js`; `share.js#withUtm` + `share-ui.js#shareText`; `partyrecap.js#recordPartyRound` idempotency; `flag.js §12b/§12c` confetti/celebration; `flag.js#shouldFollowRoom` (moves; `hash/xmur3` aliased locally); `daily.js` calendar+lock (`DAILY_EPOCH_KEY="20260823"` stays local config); `ui-common.js#escapeHtml/toast`; css tokens |
| **Thin adapter** | local `firebase.js` keeps the three-transaction API; `flag-analytics.js` unchanged (already the right shape: pure emission decisions, UI owns seen-sets) |
| **Stays put** | all of `flag.js` game cores, `reveal-render.js`, `flags-data.js`, `PACE` presets, page controllers, its stricter scrubber opt-in (`minDigitRun:4`) |

### 2.3 The hard seam: two concurrency models, one mechanism

This is the section that prevents re-forking. State it once, in `CONTRACTS.md`, and enforce it with a lint test.

**The four places the games actually diverge:**

1. **Terminal outcomes vs. benign duplicates.** FlagParty's `resolveRound` arbitrates *mutually exclusive* outcomes (win vs bust; round N→N+1 exactly once) via the epoch guard `(phase==="roundActive" && round.number===attempt.roundNumber && round.outcome==null)`. GeoParty h2h's reveal flip (`player-ui.js#onState` deadlock guard + `expiryConduct` sweeps) lets racing phones write **byte-identical** patches where last-write-wins is harmless.
2. **`applyLocally:false`.** FlagParty learned the hard way that optimistic transaction application flashes phantom settlements and leaks `private/*` into a loser's local render. GeoParty h2h never had the problem because it renders purely from echoes anyway.
3. **Totals.** Both converged on the same rule from opposite directions: GeoParty banks raw points at lock-in then writes **absolute corrected totals** in the committing reveal patch (`supersure.js#superSureSettlement` — "absolute values keep racing flip writers harmless"); FlagParty recomputes absolutes from the snapshot inside the updater (`resolveOutcome` clones teams). Same doctrine: *settlement is absolute and rides the committing write; never increment across devices.*
4. **Clocks.** FlagParty subscribes `.info/serverTimeOffset` and reads `atStep` from the server snapshot; GeoParty trusts local clocks but wraps every deadline in slack (`AUTO_ADVANCE_LAPSE_MS`, `FORFEIT_GRACE_MS`). Both obey the real rule: *decisions read snapshots; client clocks only render; deadlines carry slack.*

**The resolution — one mechanism, two sanctioned modes:**

- **Primitive:** `transaction(code, relPath, updater)` — CAS with abort-on-`undefined`, `applyLocally:false` mandatory, returns `committed`.
- **Mode A (host-authoritative):** one writer pushes patches; transitions validated by `phases.js` table; used for couch-style rooms. *(GeoParty couch.)*
- **Mode B (peer-arbitrated):** owned-path throttled LWW (≤4 Hz, per-device subtrees — live pins/poses, *never* arbitrates) + `transaction()` for anything exclusive or counted. Benign same-shape races may stay plain writes *only* when all racers compute identical bytes; prefer CAS when in doubt. *(FlagParty everywhere; GeoParty h2h hybrid.)*
- **Enforcement:** kernel `contract/sync-discipline.test.js` greps each game: (a) no `update(`/`set(` whose patch keys touch `phase`/`gameState/phase` outside the designated transactions module (precedent: `deploy-workflow.test.js`'s rooms-chokepoint guard); (b) no renderer reads `private/*` (generalizes FlagParty's `privacy.test.js`); (c) every literal `track("…")` exists in the schema (generalizes `track-schema.test.js`).

So: **yes, one primitive is enough** — the diversity lives in *policy* (which writes escalate to CAS), and policy is documented + linted, not coded into the kernel.

---

## 3. Prioritized Migration Order

Each phase ends with: both games deployed, `npm test && npm run check` green in both, manual smoke passed. Never two phases in one deploy.

| # | Phase | Ships | Days | Top risk → de-risk |
|---|---|---|---|---|
| 0 | **Pipe check** | Kernel repo v0.1: `qr.js`, `roomcode.js`, `prng.js`, `dom.js`, `share.js`, `tokens.css`. Submodule wired into both games; facades swapped | 1–2 | Import-path churn breaks Pages → `node --check` + `html-contract` catch it pre-deploy; near-zero behavior surface |
| 1 | **Analytics + consent** | `analytics-core.js`, `consent-ui.js`; both games' `analytics.js` become facade + local schema. GeoParty's consent race suite moves to kernel as the core's tests | 2–3 | GDPR-sensitive regressions → GeoParty's existing race/idempotency tests (`accept→revoke`, queued-flush ordering) become the kernel acceptance gate, run against both configs |
| 2 | **Rooms + transactions** ⭐ | `rooms.js` (`createRooms`, heartbeat writer, `transaction`, `claimTeamSlot`, `claimRoomCode`), `heartbeat.js` reader fold. FlagParty rebuilds its 3 transactions on `transaction()`; GeoParty adopts CRUD + fold (with `reclaimStale` verification) | 3–4 | Sync-spine regression on live games → pure suites (`resolveOutcome/advanceState/expiryConduct`) unchanged and green; manual smoke matrix: create/join/raced-claim/host-kill mid-round/TV sleep-rejoin/nextRoom follow. Optional: RTDB emulator as dev-only tooling (not a shipped dep) if the team wants CI-level cover |
| 3 | **Deadlines** | `deadlines.js` moved; GeoParty imports as-is | 1 | Low — verbatim module + its test file |
| 4 | **Celebration + recap + nextroom** | `confetti.js` (reconciled), `recap.js`, `nextroom.js` wired into both | 1–2 | Visual drift → fx determinism tests + screenshot eyeball on TV + phone |
| 5 | **Daily scaffold** | `daily.js` kernel halves; both games' dailies slim; lock tests move to kernel | 1–2 | Mid-day Daily reshuffle → **freeze hash families** (rule above); GeoParty keeps hard-mode slots via per-slot lock keys |
| 6 | **Doctrine + harness + stop** | `CONTRACTS.md`, `NEW-GAME.md`, `sync-discipline` lint live in both CIs, generalized `console-scrub`/`html-contract`/`track-schema` served from kernel. Tag **kernel v1.0.0**. *Stop.* | 1–2 | Scope creep → the stop condition is the deliverable |

⭐ Phase 2 is the strategic unblocker — room plumbing is the first week of every future game — but Phase 0 exists to prove the submodule + facade pipe cheaply before touching anything behavioral.

---

## 4. The Divergence Problem: Keeping the Kernel From Forking Again

Options assessed against *static, no-build, two live custom domains, solo operator + agents:*

| Option | Verdict |
|---|---|
| **Monorepo** | Rejected for now. Merging `geoparty.social` and the flag domain into one repo means deploy/artifact surgery and origin risk on live products; QR codes and share cards embed absolute URLs. Revisit only if a third game lands. |
| **npm package + CDN** | Rejected. Version-publish ceremony on every kernel tweak is friction directly against the stated goal; also implies a registry account and semver discipline nobody's asked for. |
| **jsDelivr-from-git-tag imports** | Viable but awkward: local dev against unreleased kernel needs import-map gymnastics; cache behavior adds a moving part. Keep as the *graduation path* if the kernel ever needs external consumers. |
| **Git submodule (chosen)** | Third repo `party-kernel`; each game mounts it at `vendor/kernel/` (pages workflows add `submodules: recursive` — one line each). Pointer commit = atomic version bump; drift is structurally impossible; local iteration is natural; both existing domains untouched. |
| **Fallback if submodule friction bites:** vendored snapshot + `SHA256SUMS` manifest + a drift test that fails CI on any local edit | Layout-identical to the submodule, so switching costs an afternoon. Matches the house precedent (`qr.js` was already "copied verbatim"). |

**Governance rules (cheap, written into `CONTRACTS.md`):**
1. **Two-proof rule:** nothing enters the kernel without living in both games. Single-proof features get a `// kernel-candidate:` comment and wait.
2. **Kernel changes ride a pointer-bump PR** that runs both suites; kernel repo tags `vX.Y.Z`; each game's bump states which game asked for the change.
3. **Policy divergence is legal and labeled.** Where the games deliberately differ (auto-advance authority+lapse vs. dead-man fallback; heartbeat 30 s vs. 10 s windows; scrubber strictness), the kernel parameterizes and the games assert their choice in their own tests. A comment format — `// POLICY-DIVERGENCE: <why>` — makes forks *visible* instead of silent.
4. **The lint suite is the real anti-fork device.** Code drift is annoying; *doctrine* drift (a hurried phase flip outside a transaction, a renderer peeking at `private/*`) is how the architecture dies. The `sync-discipline` test makes the expensive mistakes un-shippable.

---

## 5. What NOT To Do

1. **Don't invent a `Game` class or lifecycle hooks.** Both games are "subscribe → render(snapshot)." That sentence is the framework's runtime model. Anything richer is speculation.
2. **Don't chase TypeScript or a bundler.** The no-build discipline is load-bearing — `node --check` + `node:test` over raw ESM is the entire QA story, and it works. A build step would invalidate every structural test the repos rely on.
3. **Don't unify the PRNG silently.** Hash choice is content identity; swapping it reshuffles live Dailies mid-day. Expose both, freeze per game.
4. **Don't force one concurrency model.** Codify the escalation rule (§2.3); converting GeoParty h2h to full-CAS or weakening FlagParty to LWW are both regressions.
5. **Don't extract single-proof systems.** Hints, chrome predicates, sound engine, tvlink, streak folds (the two streak implementations have genuinely diverged — GeoParty's grace window vs. FlagParty's simple reset — and unifying them buys nothing today).
6. **Don't make the kernel know Firebase deeply.** `createRooms(config)` factory; the SDK import stays in one kernel file, swappable.
7. **Don't rename while extracting.** Mechanical moves only; renames are a separate, boring PR after v1.
8. **Don't aim for 100% dedup.** Target the identical 80%; leave honest, labeled copies where policy differs. A wrong abstraction is worse than a duplicate.
9. **Don't build the template app before v1.** A skeleton extracted from a *real* port (Phase 6, cut down from FlagParty, the smaller game) beats a speculative one.
10. **Don't measure success in coverage percentages.** Measure it in the only currency the owner named: *hours from "new mechanic idea" to "playable room with friends."* If a kernel change doesn't serve that, it waits.

---

## 6. Effort, Sequencing, and the Stop Condition

**Total: ~10–16 senior-days + agent leverage, spread over ~3 calendar weeks**, sequenced exactly as the Phase table in §3 (nothing parallel across games; both games ship at every phase boundary).

| Phase | Elapsed risk if skipped/deferred |
|---|---|
| 0 Pipe check | None — pure optionality |
| 1 Analytics | Consent bugs are reputation bugs; GeoParty's race tests are the safety net — do not shortcut them |
| 2 Rooms ⭐ | Highest-value, highest-blast-radius; budget the smoke matrix honestly |
| 3–5 | Independent; 3 and 5 can slip a week without rotting anything |
| 6 Doctrine | Skipping this is how the kernel forks again by October — it is the asset, not the code |

**Definition of done for the whole program:** a developer (human or agent) can start `NEW-GAME.md`, and within one focused day have a room, four joined phones, a passive TV, a stamped auto-advance, consent-gated analytics, a share card, and a lint-clean CI — leaving only the *pure game core* and two thin controllers unwritten. When that day is real, kernel v1 is done. Until then, every tempting addition waits behind the two-proofs rule.

The two shipped games are not passengers in this plan — they are the test suite. If a phase ever forces a choice between kernel elegance and either game's live behavior, the game wins, the kernel gets a labeled divergence, and the plan continues.