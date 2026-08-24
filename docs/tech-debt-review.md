# Tech-debt & refactor review — Flag Party

*Review seat: Fable · 2026-08-24 · diagnose-only (no source changes).*

Scope: the four axes the owner asked for — PostHog event correctness, code
duplication (within the repo and against the GeoParty kernel), URL
length/typeability, and test gaps. Files read: all of `js/`, `tests/`,
`tools/`, `docs/analytics.md`, `database.rules.json`, `config.js`, CLAUDE.md,
plus a diff against `/opt/data/geoparty/js/`.

**Overall:** the codebase is in good shape where it matters most. The
arbitration core (`js/flag.js`) is genuinely pure (imports only
`roomcode.js`, no DOM/network), the three transactional writes are the only
phase changers, and the pure layer's test coverage is strong — including the
§5.2 "roundConduct never reads private" contract test and no-mutation tests.
The debt is concentrated in (a) analytics data quality, (b) copy-paste between
the phone/TV/daily UI files, and (c) doc rot that misleads future agents.

---

## P0 — fix soon (cheap, and they corrupt data or instructions)

### P0.1 `screen_joined` fires before the room is confirmed to exist
**Axis:** analytics. **Evidence:** `js/screen-flag.js:92` —
`track("screen_joined", …)` is called inside `connect()`, *before* the
`sawState` protocol (lines 99–118) verifies the code resolves to a real room.
The heartbeat was carefully moved behind `sawState` (F4) for exactly this
reason; the analytics emit was not.

**Effect:** every mistyped TV code lands a `screen_joined` in PostHog, so the
`tv_attach_14d` KPI (`tools/posthog_metrics.mjs:212`) overcounts attaches —
worst for `via=typed`, the error-prone path — and the typed/link/qr mix is
skewed.

**Compounding:** `followRoom()` (screen-flag.js:126–137) calls `connect(next,
"follow")`, which re-emits `screen_joined` with `via:"follow"` on every
auto-followed next game. `"follow"` is undocumented (docs/analytics.md:141
says typed | link | qr; `roomcode.js` TV_VIAS deliberately excludes it), so
one physical TV session emits one attach *per game played*, inflating the
total and adding a mystery row to the report.

**Fix:** move the `track` call into the `if (!sawState)` branch of the
subscription callback; either skip the emit when `via === "follow"` or
document `follow` as a deliberate "games carried per TV session" signal.
**Risk of fixing:** none — one call site moves.

### P0.2 CLAUDE.md says the Firebase project is shared with GeoParty — it isn't anymore
**Axis:** doc rot / agent safety. **Evidence:** CLAUDE.md ("The Firebase
project is shared with GeoParty (`geoparty-9ffe7`)") vs `config.js:9–17`
(own project `flagreveal`, europe-west1 RTDB). The `.feat-firebase-split.md`
work landed but CLAUDE.md was never updated. A stale echo also survives in
`js/screen-flag.js:63–64` ("a phantom … node in the shared DB").

**Effect:** CLAUDE.md is the instruction set every agent loads. An agent
reasoning "careful, shared DB with GeoParty" will make wrong trade-offs (e.g.
refusing rules changes or cleanup jobs that are actually safe now).

**Fix:** update the CLAUDE.md bullet and the screen-flag.js comment in the
next change that touches either. **Risk:** none.

### P0.3 `share_party` is emitted but no KPI reads it (dead surface)
**Axis:** analytics. **Evidence:** emitted at `js/flag-ui.js:996–1000`;
`tools/posthog_metrics.mjs` queries `share_daily` (line 206) but never
`share_party`; `tools/posthog_report.mjs` renders a Daily share count only.

**Effect:** the party-share loop (the virality signal for the flagship mode)
is invisible in the weekly report, while the event costs schema/test/doc
surface. Per the owner's own rule, fired-but-never-read is dead surface.

**Fix (owner decision, both cheap):** either add `share_party` to a
funnel/share section of the metrics pull, or delete the event + schema entry +
docs row. Given `next_game` is already in the funnel, adding it is probably
the right call. **Risk:** none.

---

## P1 — real debt, schedule deliberately

### P1.1 No game-completion event — the funnel can't see finished or abandoned games
**Axis:** analytics (missing event). **Evidence:** `EVENT_SCHEMA`
(js/analytics.js:117–181) has no `game_over`/`game_completed`. The party
funnel (`posthog_report.mjs:145`) is `front_door_join → team_joined →
flag_round → next_game`.

**Effect:** product questions the current events cannot answer:
- **Completion rate** — how many created rooms reach `gameOver` vs. get
  abandoned mid-game? `next_game` only fires when the *winner taps Play
  again*, so "finished but didn't replay" and "abandoned at round 3" are
  indistinguishable.
- **Rounds per game / game length** — `flag_round.roundNumber` lets you infer
  it downstream with awkward per-roundKey grouping, but nothing marks the end.
- **Room-created → game-started conversion** — `front_door_create` exists,
  but nothing marks the host pressing Start (a `flag_round` with
  `roundNumber:1` is only a proxy, and it's emitted by the *resolving* phone,
  not tied to the create).

**Fix:** one `game_over` event `{mode, roundsPlayed:int, teamCount:int,
difficulty, inputMode}` emitted at-most-once by the phone whose
`advanceRound` transaction committed the `gameOver` phase (same
`committedOutcome` discipline as `flag_round`); add it to the funnel query.
**Risk:** low; the at-most-once pattern already exists.

### P1.2 Phone/TV/Daily copy-paste cluster — nine helpers exist twice or more
**Axis:** duplication (within repo). All are drifting copies, not shared code:

| Helper | Copies | Evidence |
|---|---|---|
| `escapeHtml` | 2 | flag-ui.js:1062, screen-flag.js:393 |
| `renderBoard` | 2 (near-dup: delta chip vs crown) | flag-ui.js:935, screen-flag.js:349 |
| `renderBeats` | 2 (near-dup: text vs +flag img) | flag-ui.js:954, screen-flag.js:365 |
| `poolSize` (re-derives flag.js's private `eligiblePool`) | 2 (+1 private) | flag-ui.js:1042, screen-flag.js:388, flag.js:98 |
| effective-round-count clamp `min(roundCount, poolSize)` | 4 | flag.js:148, flag.js:416, flag-ui.js:655/704, screen-flag.js:257 |
| `cfgFromRoom` | 2 (TV's is a subset) | flag-ui.js:132, screen-flag.js:40 |
| typeahead block (`NAME_INDEX`/`suggestFor`/`renderSuggest`/`hideSuggest`) | 2 | flag-ui.js:97–103 + 768–821, daily-ui.js:84–130 |
| WebAudio pop (`ringPop`/`pop`, differs only 540 vs 520 Hz) | 2 | flag-ui.js:195, daily-ui.js:60 |
| `toast` + `reduceMotion` + `$` | 2–3 | flag-ui.js, daily-ui.js, screen-flag.js |

**Effect:** the two `renderBeats`/`renderBoard` copies have already diverged
(the TV grew flag images and inline `data-ph-mask` spans; the phone relies on
container-level masks instead — two masking conventions for the same list,
which is how the `#revealResult` gap in P1.5 slipped through). The triplicated
eligibility filter means a future `eligible`-semantics change must be made in
three files or the phone and TV disagree about "Round N / M".

**Fix:** (1) export `eligiblePool` (and an `effectiveRoundCount(cfg, pool)`)
from `flag.js` — pure, instantly testable, removes 6 call sites of duplicated
logic; (2) a small `js/ui-common.js` for `escapeHtml`, `toast`, the typeahead
block, and the audio pop. Do *not* try to merge `renderBoard`/`renderBeats`
into one parametrised renderer unless the variants stop diverging — a note
that they are siblings is enough. **Risk:** low-medium (touches render paths;
needs a manual phone+TV smoke pass).

### P1.3 Room creation can silently clobber a live room, and the code namespace only fills up
**Axis:** URL/typeability trade-off + correctness. **Evidence:**
`makeRoomCode()` (js/roomcode.js:9) never checks existence; `createRoom`
(flag-ui.js:465–478) and `playAgain` (flag-ui.js:1018–1031) do a bare
`writeRoom` (`set`, firebase.js:46). `database.rules.json:8` allows a write
when the room *doesn't exist* **or is <24h old** — so a collision with a
live room is a silent full-state overwrite of someone's game, and a collision
with a stale (>24h) room is a *denied* write surfacing as "Couldn't create
the room" with no retry. Rooms are never deleted (the `deleteRoom` export in
firebase.js:58 has zero call sites), so the dead-room namespace grows forever.

**Effect at 6 chars (24⁶ ≈ 191M):** negligible today. **But this is the
constraint on the owner's "shorter codes" question** — at 5 chars (24⁵ ≈
8M), a few years of accumulated dead rooms puts create-failures in the
fractions-of-a-percent and rising, and the failure mode is user-visible.

**Fix:** make creation collision-proof regardless of length: retry
`makeRoomCode()` on a failed/denied write (or claim the code with a
transaction like `claimTeamSlot`), and pick a cleanup story (the rules
already allow anyone to delete a room — a lazy "delete stale room on
collision" would do). Note `database.rules.json:9` pins `{6}` — any length
change must ship rules + client in lockstep. **Risk:** low.

### P1.4 URL scheme — the code is not the problem; the path and domain are
**Axis:** URL length (recommend-only, as asked). Current join URL:
`https://<user>.github.io/flag-reveal/player.html?room=ABCDEF` (~70 chars).
The room code is 6 of those ~70 characters.

Recommendations, in impact order:
1. **Custom short domain** is the only big lever: `flagparty.social/…` cuts
   ~25 chars and is the thing people can *say out loud*. Everything else is
   marginal until this exists.
2. **Shorten the page path**, not the code: `p.html?room=CODE` (or teach
   `index.html` to route `?room=`) saves 10+ chars in every QR and share
   card. With a domain: `flagparty.social/p.html?room=ABCDEF` (~35 chars).
   A path-style `/p/CODE` needs the Pages 404-redirect trick — possible, but
   `p.html?room=` gets 95% of the win with zero cleverness.
3. **Drop `&via=qr` from the QR payload** (screen-flag QR only): move the
   attribution to a fragment (`#qr`) or infer it. 7 chars off the densest QR.
   Shorter payload → lower QR version → chunkier modules → easier scans from
   across a room (`js/qr.js` caps at v5; headroom is real). Note
   `screenQuery`/`TV_VIAS` (roomcode.js:25–33) already handle via-propagation
   cleanly — only the *initial* QR string needs to change.
4. **Keep 6-char codes.** Typing 5 vs 6 characters is a negligible saving,
   and 6 keeps collision math boring given P1.3 (no existence check, no
   cleanup). If the owner still wants 5, do P1.3 first.

### P1.5 One session-replay mask gap: the phone's `#revealResult`
**Axis:** privacy checklist. Player.html masks team-name containers correctly
(`#lobbyTeams`, `#revealBoard`, `#revealBeats`, `#goWinner`, `#goBoard` all
carry `data-ph-mask` — verified), **except** `#revealResult`
(player.html:172, no mask): `renderRevealScreen` (flag-ui.js:852–855) writes
"<rival team name> got it at step N" into it as plain text. The TV twin
solves this by wrapping the name in an inline `<strong data-ph-mask>`
(screen-flag.js:279) and documents the pattern in
`docs/replay-mask-checklist.md:77–87`; the checklist lists `#revealBoard` but
not `#revealResult`, which is how the gap slipped through.

**Fix:** add `data-ph-mask` to `#revealResult` (the whole line is fine to
mask) + add the row to the checklist per CLAUDE.md. **Risk:** none.

### P1.6 Analytics emission logic lives untested in the UI layer
**Axis:** tests. **Evidence:** the at-most-once/dedup machinery —
`emitRing`'s `(roundKey, correct)` set (flag-ui.js:417–433),
`emitRevealAnalytics`'s `committedOutcome` + `emittedRounds` gate
(flag-ui.js:905–931), and the `ringCount` fold — is exactly the kind of
decision logic CLAUDE.md says belongs in the pure layer, and none of it is
unit-tested. The same is true of the abort-taxonomy branch in `doWinAttempt`
(flag-ui.js:372–415), which encodes §4.2 cases a–g as untested if/else.

**Fix:** extract two pure helpers into flag.js (or a new
`js/flag-analytics.js`): `ringEmission(state, event) → {emit, props}` and
`winAttemptOutcome(snapshot, roundNumber) → "retry"|"won"|"lost"|"bust"|"over"`,
and test them; the UI keeps only the side effects. **Risk:** medium
(refactors the win path — the most safety-critical UI code; do it with the
tests written first).

---

## P2 — worth a ticket, not urgent

- **Concrete missing tests** (beyond P1.6):
  - `makeRoomCode()` output validity — nothing asserts
    `isValidRoomCode(makeRoomCode())`, so an alphabet regression (adding I/O
    back) ships silently. `tests/roomcode.test.js` tests validation only.
  - `scrubUrl` / `sanitizeBeforeSend` / `URL_PROPS` (analytics.js:27–46) have
    **zero tests** despite being the URL-privacy backstop; CLAUDE.md demands
    sanitizer tests and `tests/analytics.test.js` covers `sanitizeProps` well
    but never imports these.
  - `resolveOutcome` win where `attempt.team` isn't in `teams` (flag.js:366
    guards `newTeams[winner]` — untested edge).
  - `tools/posthog_metrics.mjs` transport (retry-on-5xx, exit contract) is
    untested; only the pure report/window pieces are. Acceptable if declared.
  - Ghost-slot class: `carryStandings` winnerOnly/season *is* well covered
    (flag.test.js:552, 567) — the bug class that shipped now has tests. ✔
- **`team_joined.team_count` is stale-by-one:** flag-ui.js:523 reads
  `room.gameState.teams` from the pre-claim snapshot, so the joiner usually
  isn't counted. Either count `+1` or document the semantics.
- **`consent_given`/`consent_denied` bypass the sanitizer:** captured via
  direct `ph.capture` (analytics.js:327, 339) rather than `track()`. Props are
  `{}` so it's harmless, but it's the only capture path outside the gate's
  schema check — an inconsistency someone will copy.
- **Dead code:** `void buildAnswerIndex` (flag-ui.js:103) and `void NAMES`
  (flag-ui.js:1178) keep an unshipped free-text mode on life support;
  `normalizeAnswer`/`buildAnswerIndex` have no UI caller. `deleteRoom`
  (firebase.js:58) has no caller. Keep (documented) or delete — currently
  they're just weight.
- **Doc rot, small:** `docs/analytics.md:3` opens "Two product events" above a
  table of fourteen. `docs/analytics.md` documents `screen_joined.via` as
  three values while the code emits a fourth (`follow`, see P0.1).
- **`.feat-*.md` sprawl:** ~30 feature-brief files sit in the repo root of a
  public Pages site (all deployed as fetchable URLs). Move to `docs/feats/`
  or delete merged ones; also `review-shots/` is untracked junk at root.
- **Daily pace constants diverge silently:** daily-ui.js:34 hardcodes
  `STEP_MS=1400 / GRACE_MS=2600`, matching neither Classic (1500/3000) nor any
  PACE preset (flag-ui.js:56). If intentional (solo feels different), say so
  in the comment; today it reads as drift.
- **`pace` is not on `flag_ring`/`flag_round`:** difficulty and inputMode ride
  every ring/round event but the third tuning knob doesn't, so "does Fast pace
  change winning-step distribution?" is unanswerable. Add if pace tuning is a
  live product question; skip if not.
- **GeoParty vendored copies:** `js/qr.js` is byte-identical to GeoParty's
  (fine — treat as vendored; a one-line "synced from GeoParty @ <sha>"
  header would make the sync intentional). `consent.js` is near-identical;
  `analytics.js`/`share*`/`daily*` are genuine adaptations, not copies — no
  action beyond the header convention.

---

## What's healthy (don't spend time here)

- `js/flag.js` purity holds: no DOM, no network, no `Math.random`/`Date.now`;
  only import is pure `roomcode.js`.
- Arbitration coverage is strong: epoch guards, `outcome == null` absent-key
  semantics, idempotent advance, owner/non-owner bust deadlines, held reveal,
  §5.2 private-read contract, input non-mutation — all tested
  (tests/flag.test.js:227–465).
- `applyLocally:false` is present on both `resolveRound` and `advanceRound`
  (firebase.js:106–133) with the rationale documented in place.
- TV passivity holds: `screen-flag.js` writes only the heartbeat, and
  `tests/privacy.test.js` enforces the no-`private` render discipline.
- The metrics tooling's no-silent-sections / exit-contract design is good and
  the report layer is genuinely tested.

## Suggested order of work

1. P0.1 + P0.3 + P0.2 in one small "analytics hygiene" PR (three one-liners
   plus doc edits) — do this **before** the next weekly metrics pull so the
   TV-attach and share KPIs start clean.
2. P1.1 (`game_over` event) next time anyone touches analytics — it unlocks
   the completion-rate question the current funnel can't answer.
3. P1.3 (collision-proof create) as a standalone small PR; it also unblocks
   any future code-shortening decision.
4. P1.2 + P1.6 together as the one real refactor PR (shared helpers + pure
   emission/win-taxonomy extraction), tests first.
5. P1.4 is an owner decision (domain purchase + path rename); no code should
   move until the domain question is settled.
