# Session-replay masking checklist

Session replay (PostHog, behind the consent gate) masks by CSS selector. The
mask config lives in `POSTHOG_INIT_OPTIONS.session_recording` in
`js/analytics.js`:

- `maskAllInputs: true` — **every** `<input>` value is masked (team names, room
  codes, typed guesses — nothing a player types is ever recorded).
- `maskTextSelector: "[data-ph-mask]"` — any element carrying `data-ph-mask` has
  its text blanked in the replay.
- `blockSelector: "[data-ph-block]"` — fully blocked (opaque placeholder). No
  Flag Reveal surface currently needs this (there is no map/tile surface).

**Ship-blocker rule (SPEC §13, CLAUDE.md):** any screen rendering a **team name**
or a **room code** must carry `data-ph-mask`, and this checklist must be updated
in the same change. The progressive flag itself is *not* masked (it is the game;
it carries no personal data), and country names shown at reveal are not identifying.

## Consent disclosure

As of the 2026-08-24 content-strategy pass, the consent banner (`js/consent.js`)
**discloses session replay to the player** in plain language — "an anonymised
replay of the screens you see (names, codes and everything you type are blanked
out)". This wording is only accurate as long as the masking above holds: every
team-name / room-code surface carries `data-ph-mask` and `maskAllInputs: true`
blanks all typed input. If a future change adds an unmasked identifying surface,
the banner copy becomes a false claim — fix the mask, not the copy.

## Masked surfaces (verified)

### `player.html`
- `#toast` — may echo team-related copy → `data-ph-mask`.
- `#homeName` — team-name input (also covered by `maskAllInputs`) → `data-ph-mask`.
- `#resumeCode` — room code in the resume banner → `data-ph-mask`.
- `#lobbyCode` — the big room code → `data-ph-mask`.
- `#lobbyJoinQr`, `#lobbyTvQr` — QR **canvases** (join / TV-connect). A QR is a
  rendered image, not selectable text, so `maskTextSelector` does not apply and
  `data-ph-mask` is unnecessary; `captureCanvas: false` (session_recording)
  already means canvases are never captured into the replay. Left unmasked by
  design — no text leak.
- `#lobbyTeams` — team-name list → `data-ph-mask`.
- `#buzzInput` — typed country guess → `data-ph-mask` (+ `maskAllInputs`).
- `#buzzSuggest` — typeahead rows reflect the typed query → `data-ph-mask`.
- `#revealResult` — reveal outcome line; `renderRevealScreen` (flag-ui.js) writes
  a rival's team name here ("<team> got it at step N") → `data-ph-mask` (mirrors
  the TV twin, whose `#tvResult` masks the same line via a `data-ph-mask` span in
  `js/screen-flag.js`).
- `#revealBoard` — standings with team names → `data-ph-mask`.
- `#revealBeats` — wrong-ring comedy beats carry team names → `data-ph-mask`.
- `#goWinner`, `#goBoard` — winner + standings team names → `data-ph-mask`.
- `#goGuestNote` — the non-winner game-over note names the winning **team** ("👑
  {winner} can start the next game…") → `data-ph-mask`.
- `#btnShareTvLink` — the "Share the TV link" lobby button copies
  `screen.html?room=CODE` to the clipboard; the room code rides only in the URL
  written to the clipboard, never into a rendered text node, so the button's
  static label is not a masked surface. (No `data-ph-mask` needed.)

### `screen.html` (TV)
- `#tvCode` — the room code on the big screen → `data-ph-mask`.
- `#tvJoinCode` — room code echoed into the big join-QR caption → `data-ph-mask`.
- `#tvJoinQrCanvas` — the couch-join QR (canvas). Not text; `captureCanvas:
  false` covers it. No `data-ph-mask` needed.
- **TV-stability audit (F1–F5, 2026-08-24):** the TV-stability fixes introduced
  no new team-name or room-code text surface. F1's `history.replaceState(…,
  screenQuery(code, via))` writes the room code into `location` (the browser
  URL), not into a captured DOM text node — session replay records DOM, not the
  address bar, and PostHog URL scrubbing is a separate concern; no mask applies.
  F2's `resetDisplay` header ("Joining the next game…") and the F4
  not-found/closed strings written to `#sErr` are generic status copy with no
  identifiers. `#tvCode`/`#tvJoinCode` (already `data-ph-mask`ed above) remain
  the only room-code text surfaces on the TV.
- **TV layout polish (flag-dominant round + rich reveal, 2026-08-24):** the
  `data-phase` layout state machine and the reveal "results card" render the
  same masked surfaces in new positions — `#tvBoard` (standings) and `#tvBeats`
  (busts) both keep `data-ph-mask`; `#tvBeats` moved out of `<main>` into its
  own `.tv-busts` grid block but its element/id/mask are unchanged. Each wrong
  guess now renders a `.beat-flag` `<img>` of the *guessed country's* flag SVG
  (`aria-hidden`, decorative) — an image, not text, and carries no team name or
  room code, so no mask applies (same rule as the progressive flag and QR
  canvases). No new team-name or room-code text surface was introduced.

### `daily.html` (solo Daily Challenge)
- The Daily is single-device and solo — **no team names, no room codes** are
  ever rendered. The day number (`#dNum`/`#dDoneScore`), the score, the streak
  (`#dStreak`/`#dDoneStreak`) and the emoji grid (`#dDoneEmoji`) are all
  non-identifying aggregates. `#dInput` (typed country guess) is covered by
  `maskAllInputs`; `#toast` is masked for parity with the other pages.
  `#dSuggest` reflects the typed query → `data-ph-mask`.
- The progressive flag itself is the game, carries no personal data, and is not
  masked (same rule as the party pages).

### `index.html` Daily CTA
- `#ldDailyStreak` renders a scores-only streak badge (`🔥N` / `done ✓`) — no
  room code, no team name, nothing to mask.
- `#tvBoard` — standings with team names → `data-ph-mask`.
- `#tvBeats` — wrong-ring beats with team names → `data-ph-mask`.
- `#tvResult` / winner `<strong>` — team name rendered inline is wrapped in a
  `data-ph-mask` span by `js/screen-flag.js`.

### `index.html`, `howto.html`
- No team names or room codes are rendered (the join input is covered by
  `maskAllInputs`). Nothing to mask.

## When adding UI
1. Renders a team name or room code? Add `data-ph-mask` to the element.
2. Renders inline (e.g. `innerHTML` with a name)? Wrap the name in a
   `data-ph-mask` span (see `#tvResult` in `screen-flag.js`).
3. Adds a map/tile/coordinate surface? Add `data-ph-block` and list it above.
4. Update this file in the same change.
