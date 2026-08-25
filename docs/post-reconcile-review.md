# Post-reconcile review — v0.1.11 (main @ `3702062`)

**Reviewer:** Fable (EM/review seat) · **Date:** 2026-08-25 · **Scope:** the full
`a154adf..3702062` changeset, read against the risk that the parallel-dispatch
reconcile (three batches editing the same working directory) produced interleaved
defects. Diagnose only — no source touched.

**Gates, run fresh on main:** `npm test` → **156/156 pass**. `npm run check` →
clean. All DOM ids referenced by `flag-ui.js` / `daily-ui.js` / `screen-flag.js`
resolve in `player.html` / `daily.html` / `screen.html` (verified by extraction,
zero misses).

---

## Headline finding (P0): the reconcile dropped the ENTIRE D-A batch

The feared failure mode — torn interleaved edits inside shared files — did **not**
happen. What happened instead is cleaner and worse: **the D-A1 and D-A2 commits
were never merged into main at all.**

Evidence:

- `git log --all` shows two commits stranded on the `analytics-hygiene` branch,
  reachable from no part of main's history:
  - `2577799` — *fix(analytics): D-A1 analytics-hygiene fixes*
  - `f9de6d9` — *fix(privacy): D-A2 replay-mask gap, collision-proof room
    creation, URL tests*
- The v0.1.11 merge commit `12049de` has parents `53ee165` (the docs baseline)
  and `2cb5328` (the tip of the B/C/D chain `5981690 → b7fa8f4 → 2cb5328`).
  The A branch also forked from `53ee165` but is on neither parent line.
- The merge is byte-faithful to the B/C/D branch: `git diff 2cb5328..12049de`
  is **empty** (only the tree; `3702062` adds the version bump). So there are no
  hand-resolution artifacts — and no opportunity for A content to have ridden in.
- Symbol sweep over main confirms zero A-batch content leaked in via the shared
  working directory: no `emitsScreenJoined`, `isRoomStale`, `ROOM_TTL_MS`,
  `claimRoomCode`, or `share_party_30d` anywhere in `js/`, `tools/`, `tests/`.
  Equally, no *partial*/torn A edits exist — main is internally coherent, just
  missing the batch.

### Everything v0.1.11 was reported to contain from D-A but does NOT

| Dropped item | Where it should be | State on main |
| --- | --- | --- |
| `screen_joined` gated on `sawState`, `follow` excluded (`emitsScreenJoined`) | `js/screen-flag.js`, `js/roomcode.js` | `js/screen-flag.js:98` still fires `track("screen_joined")` inside `connect()`, **before** the room is confirmed to exist, and `followRoom()` (`js/screen-flag.js:142`) calls `connect(next, "follow")` so same-session follows still emit it |
| `team_joined.team_count` +1 (count the joiner) | `js/flag-ui.js` | `js/flag-ui.js:484` still counts the pre-claim snapshot — off by one, omits the joiner |
| `share_party` pulled + rendered in metrics | `tools/posthog_metrics.mjs`, `tools/posthog_report.mjs` | Absent — pulls are only `core_30d` / `mode_mix_30d` / `daily_30d` / `consent_30d` (`tools/posthog_metrics.mjs:155` ff). The client emits `share_party` (`js/flag-ui.js:959`) but the report never shows it |
| CLAUDE.md un-shared (Flag Party owns project `flagreveal`) | `CLAUDE.md`, `js/screen-flag.js` comment | `CLAUDE.md:78` still says "The Firebase project is shared with GeoParty (`geoparty-9ffe7`)" — **factually false**, contradicting `config.js:2-4` (own project `flagreveal`). `js/screen-flag.js:69` comment still says "the shared DB". This misleads every future agent reading the project rules |
| `#revealResult` replay mask | `player.html` | `player.html:173` has **no** `data-ph-mask`; `js/flag-ui.js:808` writes a rival **team name** into it at reveal → session-replay leak (the TV twin masks the same line, `js/screen-flag.js:285`) |
| `claimRoomCode` collision-proof creation | `js/firebase.js`, `js/flag-ui.js` | `createRoom` (`js/flag-ui.js:423,435`) and `playAgain` (`js/flag-ui.js:995,1007`) still do bare `makeRoomCode()` + `writeRoom()` — a code collision **silently overwrites a live room** |
| `isRoomStale` / `ROOM_TTL_MS`; scrubUrl/sanitize/makeRoomCode tests | `js/roomcode.js`, `tests/` | Absent (the A branch's `tests/analytics.test.js` +78 and `tests/roomcode.test.js` additions never landed) |
| `docs/analytics.md` updates for the above | `docs/analytics.md` | Absent |

### Cross-batch interaction defect (upgrades the mask gap to P0)

D-B (which DID ship) rewrote the consent banner to explicitly promise:
*"an anonymised replay of the screens you see (names, codes and everything you
type are blanked out)"* (`js/consent.js:82-87`). D-B's own checklist addition
(`docs/replay-mask-checklist.md`, "Consent disclosure" section) states that if
any unmasked identifying surface exists, "the banner copy becomes a false
claim — fix the mask, not the copy."

With D-A2's `#revealResult` mask dropped, **the shipped banner promise is false
today**: an opted-in player's replay can contain a rival's user-entered team name
rendered unmasked at every reveal won by another team. When A2 found this it was
a P1; the new banner wording it now contradicts makes it a P0 compliance/content
integrity issue. (Note: `tests/privacy.test.js` only guards `round/private/*`
reads — mask coverage has no automated check, which is why 156 green tests did
not catch this.)

---

## Verdicts on the eight review risks

1. **`js/flag-ui.js` (A2+B+C+D interleave)** — **SOUND** as merged (minus the
   missing A2 hunks above). Read end-to-end (1142 lines): no duplicate logic;
   the C extraction is fully migrated — `escapeHtml`/`toast`/`suggestFor`/`pop`
   come only from `ui-common.js`, `ringEmission`/`revealEmission` only from
   `flag-analytics.js`, `winAttemptOutcome`/`eligiblePool`/`effectiveRoundCount`
   only from `flag.js`; no orphaned old helper remains (repo-wide grep: zero
   inline `function toast/escapeHtml/pop` or `NAME_INDEX` outside `ui-common.js`).
   `doWinAttempt` (`js/flag-ui.js:341-374`) compared line-by-line against the
   pre-refactor version at `a154adf`: the §4.2 abort taxonomy is behaviorally
   identical (retry/won/lost/bust/over map 1:1; `emitRing` contested payload and
   status lines preserved — the bust status string change is D-B's intended copy
   edit). D-D wiring (`btnShareTvLink:1056`, `btnShareParty:1088`, `goGuestNote`
   in `renderGameOver:938-945`) is complete and masked where required.
2. **`js/daily-ui.js` (B+C)** — **SOUND.** Uses `toast`/`suggestFor`/`pop` from
   `ui-common.js` exclusively; only the genuinely-diverging `renderSuggest`/
   `hideSuggest` remain local (documented at `js/ui-common.js:1-6`); Daily pop
   keeps its 520→880 Hz variant via parameters (`js/daily-ui.js:205`). B copy
   ("Not {name} — keep looking 👀", done-screen titles) is coherent with
   `daily.html`.
3. **`player.html` (B+D)** — **SOUND except the dropped A2 mask.** One
   `btnPrivacy`, all ids unique, `#btnShareTvLink` (line 118) and `#goGuestNote`
   (line 196, `data-ph-mask`) match the flag-ui wiring; B copy edits coherent.
   The one defect is the missing `data-ph-mask` on `#revealResult` (line 173) —
   an A2 item, not a B/D regression.
4. **`js/screen-flag.js`** — the **A1 `screen_joined` move is NOT here** (fires
   pre-confirmation, includes `follow` — see table). The C refactor landed
   cleanly (`escapeHtml` from ui-common, `effectiveRoundCount` from flag.js).
   **Passive-TV contract holds**: the only write in the file is
   `writeScreenHeartbeat` (`js/screen-flag.js:74`); no transactions, no phase
   flips; `tests/privacy.test.js` still enforces no `private` reads.
5. **`js/consent.js`** — **CONFIRMED copy-only.** `git diff a154adf..HEAD` for
   `consent.js` touches exactly the banner-text `append()` call; accept/decline
   handlers, storage via `analytics.js` (`getConsent`/`accept`/`decline`/`init`),
   and boot flow are byte-identical. `js/analytics.js` (incl.
   `POSTHOG_INIT_OPTIONS`) has **zero diff** since a154adf.
6. **Metrics tooling** — `tools/*` have zero diff since a154adf, so the
   no-silent-sections and exit contracts are intact — but that's because the
   `share_party` addition (A1 P0.3) never landed at all.
7. **Tests** — **COHERENT with the refactor.** `tests/flag-analytics.test.js`
   (200 lines, new) covers `ringEmission` dedup-on-(roundKey, correct) and
   `revealEmission`'s ownRing/round gates; `tests/flag.test.js` +90 covers
   `eligiblePool` / `effectiveRoundCount` (incl. the "matches gameFlags' clamp"
   drift guard) and all six `winAttemptOutcome` branches. No dangling UI-side
   tests. The per-phone dedup key `roundKey:correct` is equivalent to the
   CLAUDE.md contract `(roundKey, team, correct)` since a device holds one team.
8. **Gates** — `npm test` 156/156, `npm run check` clean (run 2026-08-25 on
   `3702062`). Fragility note: mask coverage is checklist-only (no test), and
   the expected-count "156" will change when the A branch merges (it was 149
   on the branch; the union adds the A tests on top of 156).

---

## P0 / P1 / P2

**P0**
1. Merge/land the stranded `analytics-hygiene` branch (`2577799` + `f9de6d9`) —
   the whole D-A batch is missing from the release that claims it.
2. Within it, most urgent: `data-ph-mask` on `player.html` `#revealResult`
   (the shipped consent banner currently makes a false "names are blanked out"
   claim) and `claimRoomCode` (live-room overwrite on code collision destroys a
   running game).
3. `CLAUDE.md:78` shared-DB claim — false project-rules statement that steers
   every future agent (and contradicts `config.js`).

**P1**
4. `screen_joined` fires before room confirmation and on `follow`
   (`js/screen-flag.js:98`) — attach metrics overcount.
5. `share_party` absent from the metrics pull/report — the D-D "primary share
   CTA" product bet shipped with no way to read its results.

**P2**
6. `team_joined.team_count` off-by-one (`js/flag-ui.js:484`).
7. `docs/analytics.md` missing the A1 documentation updates.
8. Consider an automated mask-coverage test (privacy.test.js-style static check
   of the checklist surfaces) so a dropped mask can never ride a green build again.

### Fix-dispatch note

Do **not** re-implement — the work exists and is committed. But a plain
`git merge analytics-hygiene` will conflict: the A commits were written against
the pre-refactor tree (`53ee165`), and B/C/D since rewrote `js/flag-ui.js`,
`js/screen-flag.js`, and `player.html` around them. The A hunks are small and
well-scoped (verified: no B/C/D contamination inside either A commit), so a
short supervised merge/cherry-pick with hand-resolution in those three files —
in particular re-pointing A1's `screen_joined` change at the current
`connect()`/`sawState` structure — then re-running both gates, is the right
dispatch. Expect the test count to rise above 156; re-baseline the expected
number afterward.
