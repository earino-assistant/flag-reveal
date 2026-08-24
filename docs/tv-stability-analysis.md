# TV stability analysis — porting GeoParty's screen polish to Flag Party

**Status:** diagnosis + fix spec only. No source changes. 2026-08-24.
**Scope:** the two owner-reported TV bugs; side-by-side read of
`/opt/data/geoparty/js/screen-ui.js` (reference, works) vs
`js/screen-flag.js` (regressed), plus the phone glue (`js/flag-ui.js`) and
`js/firebase.js` where the evidence required it.

---

## TL;DR

- **Bug 2 (TV lost the game after sleep/refresh) — root cause CONFIRMED,
  one-line class of fix.** Flag Party's TV never writes `?room=CODE` back into
  the URL. GeoParty does (`history.replaceState`, screen-ui.js:148-151), so a
  reload rejoins; Flag Party reloads to a bare `screen.html` and lands on the
  join screen. TV/embedded browsers routinely discard-and-reload the page on
  sleep/wake, so "wake" ≡ "reload". Compounding it: the phone shows the room
  code **only in the lobby** (`player.html:92` `#lobbyCode`, set at
  flag-ui.js:628) — mid-game there is no code anywhere to re-enter, exactly as
  the owner reported.

- **Bug 1 (two players after following `nextRoom`) — the suspected stale-DOM
  carryover is REFUTED as the steady-state cause; the confirmed mechanism is
  in the data the TV faithfully renders.** `renderBoard` rebuilds the board
  from scratch on every snapshot (`ul.innerHTML = ""`, screen-flag.js:194) and
  the lobby branch clears every mutable region (screen-flag.js:117-132), so a
  *persistent* two-player display means **two team slots actually exist in the
  new room's `gameState/teams`**. They exist because `playAgain`
  (flag-ui.js:1003-1028) seeds the next room with
  `carryStandings(teams, winner)` — which carries **every** slot from the
  finished game, `deviceId` and all (flag.js:541-556). Any player whose phone
  isn't open on the game-over screen at that moment never follows the pointer,
  and their carried slot becomes a **ghost player** the TV dutifully shows
  ("2 players in.", two board rows) even though only the host is present.
  GeoParty never manifests this: its next-game room is seeded from the host's
  curated team list (couch: `collectTeams()` from the setup panel,
  host-ui.js:451) or from exactly the two live h2h phones — a followed GeoParty
  lobby can only ever show players who are actually accounted for.

- There are additionally **six real TV-path stability gaps vs GeoParty**
  (missing `followedCodes` cycle guard — which SPEC-v3.1 line 1530 mandates
  "verbatim" — no `gameOver` gate on the follow, no room-not-found/room-closed
  handling, heartbeat started before the room is confirmed to exist,
  heartbeat writes without `.catch`, `.info/connected` listener stacking).
  One of them (no not-found handling) produces the *transient/frozen* variant
  of Bug 1: if the followed room is missing or slow, `render(null)` early-
  returns (screen-flag.js:102-105) and the **old room's full game-over DOM —
  board included — stays frozen on screen** under a "Waiting for the room…"
  header. That is the only surviving form of the stale-DOM theory.

All fixes below stay in the TV renderer path and preserve the passive-TV
contract (the TV still writes only `screenHeartbeat`; two of the fixes
actually *reduce* its writes). The one exception is flagged explicitly: if the
owner's repro is the ghost-slot mechanism, a complete fix for Bug 1 needs a
product decision on the phone/carry side, which is outside the TV path.

---

## Bug 2 — TV lost the game after sleep/refresh

### Root cause (confirmed)

Flag Party `screen-flag.js` contains no `history.replaceState` at all. The URL
is only ever *read*, once, at boot (`wire()`, screen-flag.js:256-260). So:

- A code **typed** on the TV (`btnSConnect`, screen-flag.js:244-251) leaves the
  URL as bare `screen.html`. Reload → join screen. Room gone.
- A TV that arrived via `?room=A` link/QR keeps `?room=A` forever, even after
  following `nextRoom` to B and C. Reload rejoins **A** and must re-walk the
  pointer chain — which works only while every intermediate room still exists
  (nothing deletes Flag Party rooms today, but that's an accident of the
  missing janitor, not a guarantee; GeoParty's janitor shares this same
  database and deletes its own rooms).

GeoParty's proven mechanism (screen-ui.js:146-151), run on the **first
non-null snapshot** of every joined room — initial join *and* every follow:

```js
const keepVia = TV_VIAS.includes(joinVia) ? `&via=${joinVia}` : "";
try {
  history.replaceState(null, "", `?room=${code}${keepVia}`);
} catch { /* file:// */ }
```

and symmetric cleanup on leave (screen-ui.js:200:
`history.replaceState(null, "", location.pathname)`).

Sleep/wake specifics: when the wake does *not* reload the page, the Firebase
SDK reconnects and `onValue` re-delivers on its own — Flag Party already
survives that case. The lost-room failure is precisely the discard-and-reload
path, which the URL fix covers. (Bonus: with the URL correct, a reload after
the host has moved on lands on the *old* room and the follow chain walks the
TV forward to the current game — the two fixes compose.)

### The phone half of the report

"The phone no longer showed the code" is accurate and phone-side: the room
code is rendered only by `renderLobby` (flag-ui.js:628 → `#lobbyCode`);
`p-round`, `p-reveal` and `p-gameover` screens in `player.html` have no code
element. Recommended (optional, small, outside the TV path): a persistent
room-code chip on the in-game phone screens, `data-ph-mask`ed. Listed as F7.

---

## Bug 1 — two players after the TV follows `nextRoom`

### What was suspected, and what the code actually shows

**Suspicion 1 — stale DOM lingers because `followRoom` skips GeoParty's full
teardown.** Partially true as a *hygiene* gap, refuted as the steady-state
cause. Evidence:

- Flag Party `followRoom` (screen-flag.js:79-91) indeed only stops the
  heartbeat, unsubscribes, and reconnects — none of GeoParty's state resets
  (screen-ui.js:170-184: `latestState`, `revealShownForRound`,
  `twistCardShownFor`, `shownRoundNumber`, `resetTvRecap()`).
- **But** Flag Party's TV holds *no* equivalent per-round latches: `render()`
  is a pure function of the latest snapshot, `renderBoard` starts with
  `ul.innerHTML = ""` (screen-flag.js:194), `renderBeats` likewise
  (screen-flag.js:210), and the lobby branch explicitly clears `tvAnswer`,
  `tvResult`, `tvComingUp`, `tvBeats`, `tvReveal` (screen-flag.js:123-127).
  Once the new room's first snapshot arrives, nothing from the old room can
  survive. A duplicated player row cannot be produced from this DOM path —
  `renderBoard` maps `Object.keys(teams)`, and keys are unique.
- The teardown gap therefore only matters in the **window before the new
  room's first snapshot** (old game-over DOM visible for the round-trip — a
  cosmetic flash), and in the **failure case** below.

**The failure case that keeps stale players on screen indefinitely:** if the
followed room doesn't exist (bad pointer, deleted room) or the snapshot is
slow, `render(null)` sets the header to "Waiting for the room…" and returns
(screen-flag.js:102-105) — **without clearing anything**. The old room's
board (with its players), the old result line, and the old lobby QR (pointing
at the dead room!) all stay up, forever. GeoParty instead has a full
not-found/closed protocol (screen-ui.js:132-137: null before first state →
"Room not found"; null after → `leaveRoom("The room was closed.")` which
resets everything and returns to entry). Flag Party has no equivalent at all.
If the owner's TV header read "Waiting for the room…" during the repro, this
is the bug they saw.

**Suspicion 2 — missing `followedCodes` cycle guard.** Confirmed missing, and
SPEC-v3.1 line 1530 requires the "`nextRoom` + `followedCodes` chain —
verbatim". Flag Party's guard is only `next !== code`
(screen-flag.js:97-101), and it also drops GeoParty's `phase === "gameOver"`
precondition (screen-ui.js:156-162). With fresh random 6-letter codes a true
A→B→A cycle is ~1/24⁶ per game, so this is not the probable cause of the
field report — but it's a mandated safety net and cheap to port. It cannot
produce a *double-render* though: `connect()` always tears down the previous
subscription before creating the next (screen-flag.js:47-54), and Firebase
`onValue`/unsubscribe pairs detach correctly, so two rooms never render
interleaved.

### The confirmed mechanism that matches the report exactly

If the TV showed a live lobby ("Lobby — join on your phone" header,
"2 players in."), the two players were **real data in the new room**:

1. Winner taps Play again → `playAgain` (flag-ui.js:1003-1028) writes the new
   room with `gameState.teams = carryStandings(teams, winner).teams` —
   **every slot from the finished game**, names, `deviceId`s, totals zeroed
   (flag.js:541-556). This is by design (SPEC-v3.1 ~line 1356).
2. Phones still sitting on the old room's game-over screen auto-follow
   (`location.href = "player.html?room=" + nextRoom`, flag-ui.js:578-579) and
   re-attach to their carried slot by `deviceId` (`tryClaim` resume,
   flag-ui.js:507-514). The `deviceId` is persisted (roomcode.js:24-40), so
   the same phone never double-claims — I verified there is no same-device
   duplicate-slot path.
3. A phone that already closed/navigated away **never follows**, but its slot
   was still carried. Nothing ever expires or removes a team slot (there is no
   leave-team write and no presence on slots). The new lobby therefore
   contains a **ghost player** — a slot with nobody behind it — and the TV
   renders slots as players (`n = Object.keys(teams).length`,
   screen-flag.js:128-131, plus a board row each).

So: previous game had two slots (host + a guest, or a leftover second-browser
test slot), guest's phone wasn't open at game over → next room shows **two
players when only the host is there**. Repeats every game in the chain.

**Why GeoParty "works perfectly":** its couch next-game room is seeded from
`collectTeams()` — the team list the host just confirmed in the setup panel
(host-ui.js:451) — teams there are host-entered labels, not device claims; and
its h2h carry is exactly the two phones that *are* the game, which re-enter
directly (`enterRoom(code, myTeam)`, player-ui.js:2222). Neither mode can
seed a followed lobby with an unaccounted-for player.

### Verifying which variant the owner hit (5-minute repro check)

During a repro, read `rooms/{NEWCODE}/gameState/teams` (or just look at the TV
header):

- Header "Lobby — …" + 2 rows + 2 slots in the DB → **ghost-slot mechanism**
  (needs F6, a product decision).
- Header "Waiting for the room…" + old board still up → **missing
  not-found/teardown handling** (fixed by F2 + F4, pure TV).
Both fixes should land regardless.

---

## Full GeoParty-vs-Flag-Party TV divergence table

| # | GeoParty (screen-ui.js) | Flag Party (screen-flag.js) | Consequence |
|---|---|---|---|
| 1 | `history.replaceState("?room=CODE&via=…")` on first snapshot of every room (146-151); cleared on leave (200) | absent | **Bug 2**: reload/wake loses the room; after a follow, URL points at a stale room |
| 2 | `followedCodes` Set breaks pointer cycles (114, 159), reset on manual entry (1034) | guard is only `next !== code` (98) | SPEC-v3.1:1530 non-compliance; theoretical follow loop |
| 3 | follow gated on `phase === "gameOver"` (156) | no phase check (97) | follows a pointer in any phase (today pointers only exist in gameOver rooms, but the invariant is unenforced) |
| 4 | null-state protocol: "Room not found" before first state, `leaveRoom("The room was closed.")` after (132-137) | `render(null)` → header text only, everything else frozen (102-105) | **Bug 1 (frozen variant)**: dead/missing room leaves old players + dead QR on screen forever; no way back to join screen without a reload |
| 5 | heartbeat starts only after the first non-null snapshot (`sawState` → `startHeartbeat()`, 138-140) | `connect()` starts beating immediately (66-68) | TV writes `rooms/{CODE}/screenHeartbeat` for **nonexistent/mistyped rooms**, creating phantom room nodes in the shared DB |
| 6 | heartbeat write has `.catch(() => {})` (216) | bare `writeScreenHeartbeat(code)` (66) | unhandled promise rejection every 4s while offline (console noise; can leak into error capture) |
| 7 | `onConnectionChange` registered once at boot (1043) | registered inside `connect()` (70) — one more listener per follow/reconnect | listener stacking; cosmetic today (idempotent toggle) but a leak |
| 8 | full state reset on follow/leave (170-205) | stop heartbeat + unsub only (79-91) | old-room DOM visible until first new snapshot (flash); combined with #4, indefinitely |
| 9 | escape hatch back to entry (`btnNewEntry` → `leaveRoom()`, 1041) | none | a TV can never leave a room without a reload |
| 10 | beat every 10s | every 4s (68) | 2.5× write volume; phone's liveness window is 10s (flag-ui.js:78) so 4s may be intentional — confirm before changing |

(#10 is the only one I'd leave alone without an owner ping; the phone's
`screenLive` threshold of 10s means moving the TV to 10s beats would flap.)

---

## Fix spec

All in `js/screen-flag.js` unless noted. The TV remains write-only-heartbeat
throughout; F4/F5 *reduce* its writes. Room code stays `data-ph-mask`ed
everywhere it renders (no new unmasked surfaces are introduced;
`docs/replay-mask-checklist.md` must be updated in the same change to record
the audit).

### F1 — URL persistence (fixes Bug 2)

- New pure helper in `js/roomcode.js` (unit-testable, no DOM):
  `screenQuery(code, via)` → `"?room=CODE"` plus `"&via=qr"|"&via=link"` only
  when `via` is one of the propagatable tags (mirror GeoParty's `TV_VIAS`;
  `"typed"` and `"follow"` are *not* propagated — a refreshed follow should
  re-attribute as `link`-style rejoin exactly as GeoParty does).
- In `connect()`: on the **first non-null snapshot** (see F4's `sawState`),
  `try { history.replaceState(null, "", screenQuery(code, via)); } catch {}`
  (the try/catch is for `file://`, matching GeoParty).
- On returning to the join screen (F4's leave path):
  `try { history.replaceState(null, "", location.pathname); } catch {}`.
- Acceptance: type a code on the TV → reload → TV rejoins the same room with
  no input; follow A→B → reload → TV rejoins **B** (not A).

### F2 — explicit teardown + DOM reset in `followRoom()` (Bug 1 hygiene)

Before `connect(next, "follow")`: clear `tvBoard`, `tvBeats`, `tvReveal`,
`tvResult`, `tvComingUp`, `tvNote`, hide `tvAnswer` and `tvJoinQr`, and set
`tvHeader` to something honest ("Joining the next game…"). This is GeoParty's
`resetTvRecap`/latch-reset discipline translated to Flag Party's (smaller)
state surface — it removes the stale flash and guarantees that even a
slow/failed follow shows a blank room, never the previous game's players.

### F3 — `followedCodes` + gameOver gate (SPEC compliance, cycle safety)

- New pure helper, suggested home `js/flag.js` (tested):
  `shouldFollowRoom(room, currentCode, followedCodes)` → next code or `null`.
  Rules: room exists, `room.gameState.phase === "gameOver"`,
  `isValidRoomCode(room.nextRoom)`, `nextRoom !== currentCode`,
  `!followedCodes.has(nextRoom)`.
- `screen-flag.js` keeps a module-level `let followedCodes = new Set()`,
  adds every code in `connect()`, resets to a fresh Set on manual entry
  (`btnSConnect`) and on URL boot — exactly GeoParty's lifecycle
  (screen-ui.js:114, 129, 1034).
- `render()`'s follow guard becomes a call to the helper.

### F4 — room-not-found / room-closed protocol (fixes the frozen variant)

Port GeoParty's `sawState` pattern into `connect()`:

- Track `sawState` per subscription. On a null snapshot: if `!sawState`,
  show the join screen with "Room not found — check the code." (and clear the
  F2 regions); if `sawState`, leave to the join screen with "The room was
  closed." Leaving = stop heartbeat, unsubscribe, clear DOM (F2), clear URL
  (F1), reset `followedCodes`.
- **Start the heartbeat only once `sawState` flips true.** This both matches
  GeoParty (screen-ui.js:138-140) and stops the TV from materializing
  `rooms/{WRONGCODE}/screenHeartbeat` phantom nodes in the shared
  `geoparty-9ffe7` database — today a mistyped code on the TV writes into a
  room that doesn't exist, every 4 seconds, forever.

### F5 — small hardening (one-liners)

- `writeScreenHeartbeat(code).catch(() => {})` in the beat closure.
- Move `onConnectionChange(...)` out of `connect()` to module boot (called
  once), like GeoParty screen-ui.js:1043.
- Keep the 4s cadence (see divergence #10 — the phone's `screenLive` window
  is 10s; do not "fix" this to GeoParty's 10s without changing the phone).

### F6 — ghost carried slots (DECISION NEEDED — outside the TV path)

If (as argued above) the repro is the data mechanism, no TV-side change can
fully fix Bug 1: the TV is correctly rendering slots that really exist.
Options, in increasing effort:

1. **Carry only the winner's slot** into the next room; everyone else
   re-claims via the existing auto-follow + `tryClaim` (which already resumes
   by `deviceId` in <1s for any phone still open). Cheapest; changes only
   `playAgain`'s use of `carryStandings` (or adds a `cfg` knob to
   `carryStandings` — pure, unit-testable). Cost: a player who rejoins later
   loses their slot color/name ordering; "season" total-carry mode (spec §7)
   needs the winner-only carry to still carry *totals* for returning devices —
   design that before implementing.
2. **Carry all slots but mark them pending** (`pending: true` on carried
   slots; cleared by the owning device's resume write). TV renders pending
   slots greyed as "rejoining…" and excludes them from the "N players in."
   count. Truthful UX, keeps colors/totals, but adds a new non-transactional
   teams write — must be specced against the arbitration rules (it is a
   lobby-only write, no phase change, so it stays a bare `update()`; still,
   it touches `gameState.teams` and needs a careful read of SPEC §2/§4).
3. Accept the behavior and only render names (no count) in the lobby. Not
   recommended — the owner has already flagged it as wrong.

Recommendation: option 1, gated on the owner confirming the repro shows two
slots in the DB. Note SPEC-v3.1 (~line 1356) currently *specifies* the
full-carry, so whichever option lands must amend the spec, not silently
diverge from it.

### F7 — persistent room code on the phone (optional polish, phone path)

A small masked chip (`data-ph-mask`) with the room code on `p-round`,
`p-reveal`, `p-gameover` in `player.html`, so a recovered TV can always be
re-pointed. Directly addresses the second half of the owner's Bug 2 report.

---

## Test plan

Pure logic (Node test runner, `tests/*.test.js`, runs in `npm test`):

- `shouldFollowRoom` (new): follows only on gameOver + valid + unvisited;
  ignores `nextRoom === current`; ignores invalid codes; **cycle test**: with
  `followedCodes = {A, B}` and B→A, returns null; phase gate test (pointer
  present but phase `lobby`/`roundActive` → null); null/absent room → null.
- `screenQuery` (new): code only; code+`qr`; code+`link`; `typed`/`follow`/
  garbage via → no via param; output always starts `?room=`.
- If F6 option 1: `carryStandings` winner-only mode — carries winner slot
  (deviceId preserved, total zeroed), drops others; season/carry interaction.
- `npm run check` (every JS file `node --check`) stays green.

UI-glue, not unit-testable (manual script — document in the PR):

1. Type a code on the TV → reload the tab → rejoins the same room.
2. Play a game to gameOver → Play again on the phone → TV lands in the new
   lobby showing exactly the players whose phones followed; reload the TV →
   it rejoins the **new** room.
3. Type a nonsense code → "Room not found", no `screenHeartbeat` node appears
   under that code in the DB (verify in the Firebase console).
4. Kill the room out from under a connected TV (console delete) → TV returns
   to the join screen with "The room was closed."
5. Replay-mask spot check: session replay shows masked room code on join
   screen, header, and QR caption (update `docs/replay-mask-checklist.md`).

Constraint check for the implementer: none of F1-F5 adds a TV write besides
the existing heartbeat (F4 defers it, F5 catches it); no transaction, no
phase flip, no `advanceRound`/`resolveRound` reference enters
`screen-flag.js`; `js/flag.js` gains only pure functions; the arbitration
primitive is untouched.

---

## Risk notes for the implementer

- **F4's "room was closed" path fires on transient nulls only if Firebase
  actually reports the room as absent** — `onValue` does not deliver null on
  disconnects (the connection pill covers that case), so the GeoParty pattern is
  safe to copy as-is; don't add debouncing speculatively.
- **F1 must write the URL only after `sawState`** (GeoParty's ordering).
  Writing it eagerly in `connect()` would pin a mistyped code into the URL
  and re-fail on every reload.
- **F6 option 1 changes game-visible behavior** (guests re-claim rather than
  resume) — needs the owner's sign-off and a spec amendment; do not bundle it
  with the mechanical F1-F5 PR.
- The `via` attribution on `screen_joined` must keep its current values
  (`typed`/`link`/`qr`/`follow`); F1's propagation rules affect only the URL,
  not the event. `EVENT_SCHEMA` needs no change (and `screen_joined` must
  stay aggregate-only — GeoParty's variant sends `room`, Flag Party's
  allowlist correctly does not; don't "port" that).
