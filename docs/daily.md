# Flag Reveal — Daily Challenge (v0.2)

A solo, single-device, date-seeded run of `DAILY_ROUNDS` (5) flags — the same
five flags, in the same order, for everyone playing on a given **local** calendar
day (Wordle's rule: your "today" is your local midnight, not UTC's). One scored
run per day per device, a streak, and a shareable Wordle-style card.

## Modules

- **`js/daily.js`** — pure, tested (`tests/daily.test.js`). Date-key
  (`dailyKey` → "YYYYMMDD"), namespaced seed (`dailySeed` → `flagdaily-<key>`),
  day counter (`dailyNumber` → "Daily #N"), `daysBetweenKeys` for the streak,
  the deterministic day-flag sequence (`dailyFlags`, via `flag.js`'s
  `gameFlags`), per-round reveal seed (`dailyFlagSeed`), the run fold
  (`newDailyRun` / `recordDailyRound`, scored by `flag.js`'s `scoreRing`), the
  streak fold (`nextStreak`), and the replay lock (`loadDailyResult` /
  `loadLastResult` / `saveDailyResult` over one localStorage slot).
- **`js/share.js`** — pure, tested (`tests/share.test.js`). The Wordle grid
  (`emojiRow` / `roundEmoji`, felt-quality buckets) and `dailyShareText` /
  `partyShareText`, plus UTM tagging (`withUtm`).
- **`js/daily-ui.js`** + **`daily.html`** — the browser glue. No Firebase, no
  room, no transactions.

## Scoring & the grid

A round's quality is the reveal **step** the player named the country at
(`scoreRing(atStep)` — earlier is worth more, the same table the party game
uses). The share grid buckets that into felt-quality tiers, not score math:

- 🟩 named it fast (`atStep ≤ steps × 0.375`, i.e. ≤ step 3 of 8),
- 🟨 named it, but slower,
- 🟥 never named it (wrong or timed out).

The grid encodes **only** the bucket — never a flag ISO or a country name.

## Rules (fixed — comparable scores need identical rules)

- 5 flags, the standard 8-step reveal, the `world` (mixed) pool.
- A wrong guess is forgiving (you can keep trying) but the flag keeps
  sharpening, so it still costs points; a round times out a short grace after
  full reveal.
- One **scored** run per day per device (`flagreveal_daily_result`, one slot —
  yesterday's board is superseded). A mid-run refresh restarts the run; the
  flags are deterministic anyway. Devtools-grade honesty is not in the threat
  model.

## Streak

A completed run stores the streak it earned. Tomorrow's run reads yesterday's
board (`loadLastResult`, day-agnostic) and `nextStreak` folds it: a consecutive
day extends, a missed day resets to 1. A 🔥1 is noise and is not shown/shared.

## Analytics

`daily_started`, `daily_completed`, `share_daily` — aggregates only (day
counter, score, streak, `correct` count). See `docs/analytics.md`.
