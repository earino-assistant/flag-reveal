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

## Masked surfaces (verified)

### `player.html`
- `#toast` — may echo team-related copy → `data-ph-mask`.
- `#homeName` — team-name input (also covered by `maskAllInputs`) → `data-ph-mask`.
- `#resumeCode` — room code in the resume banner → `data-ph-mask`.
- `#lobbyCode` — the big room code → `data-ph-mask`.
- `#lobbyTvCode` — room code shown as the hero of the "Play on the TV" callout → `data-ph-mask`.
- `#lobbyJoinQr`, `#lobbyTvQr` — QR **canvases** (join / TV-connect). A QR is a
  rendered image, not selectable text, so `maskTextSelector` does not apply and
  `data-ph-mask` is unnecessary; `captureCanvas: false` (session_recording)
  already means canvases are never captured into the replay. Left unmasked by
  design — no text leak.
- `#lobbyTeams` — team-name list → `data-ph-mask`.
- `#buzzInput` — typed country guess → `data-ph-mask` (+ `maskAllInputs`).
- `#buzzSuggest` — typeahead rows reflect the typed query → `data-ph-mask`.
- `#revealBoard` — standings with team names → `data-ph-mask`.
- `#revealBeats` — wrong-ring comedy beats carry team names → `data-ph-mask`.
- `#goWinner`, `#goBoard` — winner + standings team names → `data-ph-mask`.

### `screen.html` (TV)
- `#tvCode` — the room code on the big screen → `data-ph-mask`.
- `#tvJoinQrCanvas` — the couch-join QR (canvas). Not text; `captureCanvas:
  false` covers it. No `data-ph-mask` needed.

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
