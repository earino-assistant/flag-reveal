# Flag Party — Content Strategy Review (v1)

Reviewer: Fable (review seat) · Date: 2026-08-24 · **DIAGNOSE ONLY — no source
edits, no copy changed.** Method and bar: the GeoParty content-strategy work
(`/opt/data/geoparty/docs/content-strategy-plan.md`,
`…/content-strategy-complete-audit.md`) applied to Flag Party.

Sources read in full: `index.html`, `player.html`, `screen.html`, `daily.html`,
`howto.html`, and every JS module that renders or builds a user-facing string
(`flag-ui.js`, `screen-flag.js`, `daily-ui.js`, `consent.js`, `share.js`,
`share-ui.js`), plus `analytics.js` (schema + sanitizer), `reveal-render.js`
(alt/aria only), `docs/replay-mask-checklist.md`, `docs/analytics.md`, and the
tests that lock any share/toast string (`tests/share.test.js`).

**~180 user-facing strings inventoried** (index ≈20 · player.html ≈45 ·
flag-ui.js ≈30 · screen.html + screen-flag.js ≈25 · daily.html + daily-ui.js
≈32 · howto ≈17 · consent ≈7 · share ≈5). `flag.js`, `daily.js`,
`firebase.js`, `roomcode.js`, `qr.js`, `flags-data.js`, `config.js` contain no
user-facing strings (verified by sweep); `reveal-render.js` deliberately renders
`alt=""` + `aria-hidden` (the answer is announced separately) — correct.

---

## 0. Executive summary

Flag Party shipped *after* the GeoParty audit and it shows — most of GeoParty's
hard-won fixes are already applied here:

- **The share verb is "Share"** ("Share result 📋" on both done screens) — the
  Natha lesson is pre-applied. No share-CTA P0 exists.
- The error family mostly follows the GeoParty model ("Room is full…",
  "Enter a 6-letter room code.", "Room not found — check the code." on the TV).
- "← Home", the single-name ownership line, "Sharing is on/off.", the
  matched consent aria-label, "Flag Party — TV", the CODE placeholder — all
  GeoParty P2s, already right.
- The Daily emoji grid ships **with a legend** ("🟩 named early · 🟨 named late
  · 🟥 missed") — better than GeoParty's own grid.

What remains is one **owner-level consent-wording flag (P0)**, **nine P1
consistency/guidance fixes** (the create-a-game funnel uses three names; two
game-over surfaces send players to the wrong phone; "Typeahead" and "app"
leak into user copy), and a **P2 polish batch (~13 line edits)**.

**The privacy boundary on the share payload PASSES** (§4). The one privacy
finding is a *disclosure* gap in the consent banner, not a data leak.

---

## 1. Axis verdicts

### 1.1 Share CTA — PASS, polish only
Both done screens lead with the share verb: `player.html:193` and
`daily.html:97` say **"Share result 📋"**. The daily share is the primary
button; the toast confirms "Result copied 📋". The loop verb chain is
Share → copied — two verbs, both conventional, no "verdict"/"challenge"
opacity. P2 polish: "Share **your** result" (GeoParty's model label), and a
toast that names the next act ("paste it in the chat").

Two non-copy observations for the owner (not string edits):
- On the party game-over, the share button is `btn-ghost` (visually
  subordinate) while "New game" sits in the primary action bar. If the
  share-to-group-chat loop is the growth engine, the hierarchy is inverted.
- There is **no "Share the TV link"** affordance. The lobby TV card
  (`player.html:115-117`) tells the user to "open the game" on the TV but
  never states a URL, and a real TV can't scan the QR. GeoParty solved this
  with a share-the-TV-link button. Product gap, recorded.

### 1.2 Jargon / internal names leaking
Real leaks (fix): **"Typeahead"** and **"Input"** as host-setting labels,
**"the mixed pool"**, **"Update your app"** (there is no app — the landing
promises "No app, no accounts"), **`screen.html`** as a literal filename in
howto copy, one **"busted"** in a live status line, and **"step N"** cited in
every result line although no step counter is ever shown during play.
Judged fine (affordance, not purity): **"ring in"** — it's the game's
signature buzzer verb, taught by the TV prompt ("Ring in on your phone!") and
howto; "guess" handles the plain-word duty. Both keep their roles.

### 1.3 One vocabulary per concept
- **Create-a-game has three names in one funnel** (the biggest finding):
  landing "Start a party" → player home "Start a new room →" → panel button
  "Create room". A first-timer who tapped "Start a party" must recognise two
  renames to finish the act. (GeoParty P1-D, replayed.)
- **The crown means two things**: 👑 marks the *host* in the lobby
  (`flag-ui.js:668`) and the *winner* at game over (`flag-ui.js:980`,
  `screen-flag.js:357`). GeoParty P1-C ruled: the crown means winning, the
  host gets " · host".
- **"No such room."** (phone, `flag-ui.js:572`) vs **"Room not found — check
  the code."** (TV, `screen-flag.js:107`) — same failure, two phrasings, and
  the phone's version gives no next step.
- Minor drift: "Your team name" vs "(4 players max)" vs "N players in." —
  team/player used interchangeably; "Round N" (party) vs "Flag N" (daily) is
  deliberate and fine.

### 1.4 Share-payload privacy boundary — PASS ✅
Verified end-to-end, no ship-blocker:
- `dailyShareText` (share.js:76-81): day number, streak, score, emoji tiers,
  UTM link. The emoji row encodes felt-quality only — never an ISO, never a
  country name.
- `partyShareText` (share.js:39-43): points + the winning **user-entered**
  team name, shared *by the user into their own chat* — documented as
  deliberate flair (share.js:30-34), never a country name.
- Analytics on share (`share_daily`/`share_party`): aggregate-only props
  through the `EVENT_SCHEMA` allowlist; `sanitizeProps` iterates the
  allowlist (unknown keys can't survive) and `BANNED_KEY_RE`
  (analytics.js:187-188) refuses name/room/code/iso/guess-shaped keys as
  defense in depth. UTM params name a source and campaign, never a person.
- Session-replay masking: every team-name/room-code surface in the two new
  pages carries `data-ph-mask` per `docs/replay-mask-checklist.md`; typed
  guesses are covered by `maskAllInputs` + masked suggest lists; the reveal
  "beats" (which name the wrongly-guessed country) are masked wholesale.

**The one privacy finding is P0-1 below**: the consent banner never mentions
session replay, while replay is configured and a masking checklist is
actively maintained. That is a disclosure gap, not a leak — but consent copy
is held to the "additionally honest and specific" register, and GeoParty's
banner explicitly disclosed its replay. Owner sign-off required either way
(disclose it, or confirm replay is off at the PostHog project level and
record that here).

### 1.5 Tone / compassion — strong, three soft spots
The kind-and-guiding register is mostly there: "Not France — keep looking 👀"
(the best line in the product), "So close — someone rang first! 😤",
"Paused — take your time. Tap Next round when ready.", "Fresh five tomorrow —
or start a party with friends." Soft spots: the **guest's game-over is a
dead end** (no hint that the winner hosts next, and the "New game" button
silently exits the follow-the-winner loop — P1-4); "No such room." is curt;
"Daily done!" is flat for the signature solo win (GeoParty P2-2, replayed).

---

## 2. P0 — owner sign-off required (consent wording)

| # | current (file:line) | proposed | why | testability |
|---|---|---|---|---|
| P0-1 | Consent banner body (consent.js:81-85): "When rounds are rung, busted or won, plus the difficulty and mode — so we can see whether players actually race each other. Never your guesses, the countries, your team names, or the room code. EU-hosted, change anytime." | "**Which rounds were won, missed or timed out, plus the difficulty and mode — and an anonymised replay of the screens you see (names, codes and everything you type are blanked out) — so we can see whether players actually race each other.** Never your guesses, the countries, your team names, or the room code. EU-hosted, change anytime." | Two defects in the product's most accountability-bound string: (1) **session replay is configured** (`POSTHOG_INIT_OPTIONS.session_recording`, analytics.js:59-68) and a masking checklist is maintained, yet the banner discloses only "play stats" — a user who accepts has not been told about replay. GeoParty's banner disclosed its replay explicitly. (2) "rung, busted" is internal vocabulary in a consent surface ("busted" is taught nowhere the user has been; rounds aren't "rung", players ring in). The masking claims in the proposal are **verified accurate** (maskAllInputs, data-ph-mask on names/codes/suggest). **If replay is in fact disabled at the PostHog project level, the alternative fix is: keep the stats-only banner, and record the replay-off decision in docs/replay-mask-checklist.md.** Owner decides which. | Pure copy in DOM glue — untestable. **Owner sign-off mandatory** (consent gating is inviolable per CLAUDE.md; wording is the owner's promise). |

---

## 3. P1 — consistency + guidance (nine fixes)

| # | current (file:line) | proposed | surface/moment | why |
|---|---|---|---|---|
| P1-1 | "Start a new room →" (player.html:38) and "Create room" (player.html:66) | "**Start a party →**" and "**Start the party**" | The create funnel, straight after the landing's "Start a party" CTA | One act, three names. "Room" is the implementation noun (GeoParty P1-D: the landing verb is canonical; the commit button repeats it). |
| P1-2 | "Update your app to join this game." (flag-ui.js:501) | "**This room runs a newer version — refresh this page, then join again.**" | Version-mismatch join error | There is no app — the landing's first promise is "No app, no accounts". The current copy contradicts the brand and names no achievable action; a refresh is the actual fix. |
| P1-3 | "Start a new game on the host's phone." (screen-flag.js:251) | "**👑 The winner's phone starts the next game.**" | TV game-over note, the whole room reading it | Only the *winner's* phone shows "Play again (same crew)" (flag-ui.js:983 gates on `iWon`). If the host lost, the TV points everyone at a phone with no button. howto.html:32 teaches "The winner hosts the next game" — the TV should say the same thing. |
| P1-4 | "New game" (player.html:196), and no guest guidance at game over | Relabel "**Leave**" (matches the lobby exit); *recommended addition (small UI change, owner call):* a guest-only note "**👑 {winner} can start the next game — stay here to follow along.**" | Phone game-over, non-winners | For a guest, "New game" reads as "another round with the crew" but does the opposite: it clears the session and leaves (flag-ui.js:1126-1129), breaking the auto-follow into the winner's next room. The winner's button already names the real act; the guest's button should name *its* real act. The note fixes the dead-end tone gap (§1.5). |
| P1-5 | Label "Input"; options "Typeahead (type the country)" / "Choice (tap 1 of 4 — for kids)" (player.html:47-50) | Label "**How players answer**"; options "**Type the country**" / "**Tap 1 of 4 — easier, great for kids**" | Host create panel | "Typeahead" and "Input" are engineering vocabulary; "Typeahead"/"Choice" are the internal `inputMode` enum values spoken aloud. The parenthetical was already carrying the real meaning — promote it. |
| P1-6 | "Optionally put a TV on the big screen at `screen.html` (or tap *Add a TV*)." (howto.html:20-21) | "**Optionally add a TV: open the game in the TV's browser and tap *Add a TV*.**" | How-to step 1 | "Put a TV on the big screen" is garbled (the TV *is* the big screen), and `screen.html` is a raw filename in user copy — the only jargon of its kind in the product. "Add a TV" is already the canonical feature name everywhere else (index footer, lobby card). |
| P1-7 | Host crown suffix " 👑" (flag-ui.js:668) | "** · host**" | Lobby roster | The crown marks the host here and the *winner* at game over (flag-ui.js:980, screen-flag.js:357). GeoParty P1-C: 👑 means winning, nothing else. Winner crowns all stay. |
| P1-8 | "No such room." (flag-ui.js:572) | "**Room not found — check the code.**" | Phone join error | The TV already uses the model string (screen-flag.js:107). One failure, one phrasing, and the phone's gains a next step. |
| P1-9 | "Next round" on the final round's reveal (flag-ui.js:891, 899, 1159) | "**See final scores**" (and "See final scores · Ns" for the countdown form) when `round.number` ≥ the effective round count | Owner's primary button on the last reveal | The label promises a round that doesn't exist; the tap ends the game. Controls carry the verb of what tapping does. The daily already does this right ("See your result", daily-ui.js:297) — match it. |

---

## 4. P2 — polish batch (~13 line edits, batch per file)

| # | current (file:line) | proposed | why |
|---|---|---|---|
| 1 | "Round busted before it landed." (flag-ui.js:409) | "Time ran out just before your ring landed." | The only in-game "busted"; the word is taught in howto only (where it's inline-glossed and fine). The reveal already says "Nobody got it! 🙈" instead. |
| 2 | "at step ${n}" family (flag-ui.js:853-854, 965; screen-flag.js:281, 382; daily-ui.js:290) | "at step ${n} **of 8**" (use `cfg.steps`) | No step counter is ever shown during play, so the number has no scale. "3 of 8" makes earliness legible for free; keeps the brag vocabulary. |
| 3 | "five flags, one for each of today's countries" (index.html:24-25) | "five flags, the same for everyone today" | "Today's countries" is circular (which countries? today's). daily.html:32 already has the right line — reuse it. |
| 4 | "first correct ring wins" (index.html:7, 12) | "first correct guess wins" | Noun "ring" is untaught at the front door; player.html:7's meta already avoids it ("first correct wins"). Verb "ring in" keeps its role everywhere else. |
| 5 | "World — the mixed pool" (player.html:44) | "World — the full mix" | "Pool" is sampler vocabulary (GeoParty's "Location pool exhausted!" lesson). |
| 6 | "Reconnecting…" (screen.html:13) | "Reconnecting — hang tight…" | player.html:13 already reassures; same pill, same words. |
| 7 | "Result copied 📋" (share.js:85) | "Result copied — paste it in the chat 📋" | Confirms the copy *and* names the growth loop's last step. **Test-locked:** tests/share.test.js:104-105 asserts `/copied/i` — still passes, sync-check anyway. |
| 8 | "Share result 📋" (player.html:193; daily.html:97) | "Share your result 📋" | GeoParty's model label; warmer, same verb, zero relearning. |
| 9 | "Daily done!" / "You've done today's ✓" (daily-ui.js:324; daily.html:87) | "Daily #${n} — you did it! 🎉" / "You've played today's Daily ✓" | The signature solo win deserves a celebration, not a status (GeoParty P2-2); "today's" currently dangles without its noun. |
| 10 | "(4 players max)" (flag-ui.js:532) vs "Your team name" (player.html:23) vs "N player(s) in." (screen-flag.js:235) | Pick one word — recommend "**team**": "(4 teams max)", "N teams in." | One concept, one name. "Team" matches the input label users meet first (and GeoParty's model string). Judgment call — "player" everywhere is also defensible; pick and apply. |
| 11 | "or scan onto a spare phone" (player.html:117) | "or scan the QR with a spare phone or tablet" | "Scan onto" is compressed to the point of oddness; names the device wording GeoParty settled on. |
| 12 | "nobody sees what you rang until the reveal" (howto.html:28) | "nobody sees your guess until the reveal" | "What you rang" stretches the idiom past its grammar. |
| 13 | "Couldn't start." (flag-ui.js:1095) | "Couldn't start — try again." | Errors end with a next step (model family rule). |

---

## 5. What NOT to touch (anti-churn)

- **"Share result 📋" verb + placement of the daily primary** — the GeoParty
  P0 lesson, already applied. Only the P2-8 possessive polish.
- **"Ring in"** as the buzzer verb — signature mechanic, taught by the TV
  ("Ring in on your phone!") and howto; "guess" covers the plain word. Keep
  both in their current roles.
- **The error family**: "Enter a 6-letter room code.", "Room is full…",
  "Couldn't create the room. Check your connection.", "The room was closed.",
  "Room not found — check the code." — model copy (P1-8 just extends it to
  the one outlier).
- **"Not ${name} — keep looking 👀"** (daily-ui.js:270) — the best line in
  the product. Also: "So close — someone rang first! 😤", "👀 Look at the
  flag first!", "Tap the country!", "✋ Pause timer", "Paused — take your
  time…", the emoji-grid legend, "Fresh five tomorrow — or start a party".
- **"Flag N" (daily) vs "Round N" (party)** — deliberate; a solo run counts
  flags, a party counts rounds. Keep distinct.
- **Share cards** ("Beat me:", "beat us:", the 🚩/🔥 flair) — correct
  speaker, correct register, test-locked. Keep.
- **Ceremony register**: "👑 You win — N pts!", "Game over!", the crown at
  wins (P1-7 removes only the *host* crown), the celebration takeover.
- **Code identifiers**: `bust`, `typeahead`, `atStep`, `roundKey`, `tN`,
  `EVENT_SCHEMA` names — never rename; P1-5/P2-1 just stop them being
  *spoken*.

## 6. Testability + instrumentation (per repo rules)

- Every P1/P2 item except P2-7 is a **pure copy edit** in static HTML or DOM
  glue — untestable by design; state that in the change summary.
  P2-7 touches `shareToastText()` (pure, tested): the existing
  `/copied/i` assertion (tests/share.test.js:104-105) survives, but sync-check
  in the same change. P2-2's "of 8" lands in template literals in glue —
  no formatter, no test.
- **No new analytics events are needed, and none should be added.** Share
  conversion is already measured (`share_daily`/`share_party` with `method`);
  relabel effects are a PostHog query, not a schema change. P0-1 is wording
  only — it must not touch flow, buttons, storage keys, or
  `POSTHOG_INIT_OPTIONS`.
- P0-1 (consent body) additionally requires **owner sign-off** and, if the
  replay-off route is chosen, a matching note in
  `docs/replay-mask-checklist.md`.

## 7. Recorded product gaps (not copy defects)

1. **No TV-link share.** The lobby TV card never states the site URL and a TV
   can't scan the QR; GeoParty's "Share the TV link" button is the missing
   affordance (§1.1).
2. **Growth CTA hierarchy** on the party game-over: the share button is
   ghost-styled below the primary action bar (§1.1).
3. **Guest game-over guidance** — the copy half of the fix is P1-4; the
   guest-note half is a small UI addition.
4. The consent banner links no full privacy policy (GeoParty linked its
   GitHub policy). Owner call whether a policy doc exists to link.
