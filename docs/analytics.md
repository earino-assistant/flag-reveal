# Flag Reveal — analytics

Two product events, aggregates only. The schema in `js/analytics.js`
(`EVENT_SCHEMA`) is a **hard allowlist**: an event that isn't listed is dropped,
and any property not in that event's allowlist — or matching the banned-key
sweep (`/lat|lng|lon|coord|name|email|device|user|iso|country|room|code|guess$|answer/i`)
— is stripped before send. Everything rides behind the consent gate in
`js/consent.js`: nothing is captured, and PostHog is never even loaded, before an
explicit opt-in (SPEC §12/§13, CLAUDE.md).

**Never captured:** country names, ISO codes as free strings, wrong-ring `wrongIso`,
team names, room codes, or anything a player types. **Permitted:** slot ids
(`tN`) — CLAUDE.md explicitly allows these — and non-identifying aggregates.

## `flag_ring` — one per ring, emitted by the ringing phone

The headline experiment signal: *are correct rings actually colliding?*

| prop | type | notes |
|---|---|---|
| `mode` | string | `tv` (a live TV heartbeat) or `phone` |
| `team` | string | the ringing phone's slot id (`tN`) — **distinguishes players** (v3.1) |
| `atStep` | int | wrong ring → the phone's *displayed* step; winning ring → settled `outcome.atStep`; losing-correct ring → the phone's *displayed* step at commit |
| `correct` | bool | did the committed ISO equal the answer |
| `points` | int | 0 for wrong or losing-correct rings |
| `contested` | bool | a *correct* ring whose `resolveRound(win)` lost the race to a rival win (§4.2 case d) |
| `difficulty` | string | `easy` \| `world` \| `expert` |
| `inputMode` | string | `typeahead` \| `choice` |
| `guessMode` | string | `single` (First correct wins — a wrong ring locks the team out) \| `multi` (Multiple guesses — a wrong ring is recorded but the team keeps guessing) |
| `roundKey` | string | truncated `hash(gameSeed, round.number)` — `gameSeed` is random, so this is **not** identifying and never derived from the room code |

## `flag_round` — one per round at reveal, emitted by the committing phone

Emitted by **the phone whose `resolveRound` transaction committed**. Emission is
**at-most-once**, not exactly-once: exactly one transaction *commits* per
round-ending event, but the committing phone can crash between commit and emit
and lose the event. An occasional missing `flag_round` (never a duplicate) is
expected.

| prop | type | notes |
|---|---|---|
| `mode` | string | `tv` \| `phone` |
| `outcome` | string | `won` \| `busted` |
| `winningStep` | int | the winning `atStep`; **absent** on a bust (`null` is dropped by the sanitizer) |
| `ringCount` | int | best-effort local count (results with `correct` or `rangOut`); the **canonical** count is reconstructed downstream (below) |
| `difficulty` | string | enables "bust rate by difficulty tier" |
| `inputMode` | string | typeahead vs. choice — likely the strongest explanatory variable |
| `guessMode` | string | `single` \| `multi` — separates lockout vs. multiple-guesses rounds (bust rate, winning-step, ring counts by mode) |
| `roundNumber` | int | |
| `roundKey` | string | join key with `flag_ring` |

## Reconstructing `ringCount` downstream (v3.1)

`ringCount` is **not** a reliable property of `flag_round` — losing correct
claimants abort their transaction and are stored nowhere. Reconstruct it as the
count of distinct `flag_ring` events sharing a `roundKey`, **de-duplicated on
`(roundKey, team, correct)`**:

- absorbs PostHog delivery duplication (a phone's re-delivered ring is one tuple);
- preserves *distinct players* (two `correct:true` rings from `t1` and `t2` in one
  round are two tuples → the collision is visible);
- `atStep` is deliberately **not** in the dedup key: a player rings at most once
  per correctness class per round, and including a client-side step re-estimate
  would spuriously split one ring into two.

## KPIs

- **Contested-ring rate:** share of rounds with ≥2 `correct:true` `flag_ring`
  tuples — the experiment's success condition (are players racing?).
- **Bust rate by difficulty:** `flag_round.outcome === "busted"` grouped by
  `difficulty`.
- **Winning step distribution:** `flag_round.winningStep` — is the progressive
  reveal tuned so wins land mid-reveal, not at step 1 or only at step 8?
- **Input mode effect:** contested-ring rate and winning step split by `inputMode`.
- **Guess mode effect:** bust rate, winning step, and rings-per-round split by
  `guessMode` — does "Multiple guesses" cut busts / shift wins later, and does it
  raise the wrong-ring count per round (players taking more shots)?

## Daily Challenge + share events (v0.2)

All aggregate-only, schema-gated identically. The emoji grid, the flag ISO, and
country names are **never** sent — only the day counter (a public "Daily #N",
not a date-of-play) and the score/streak.

| event | props | notes |
|---|---|---|
| `daily_started` | `dayNumber:int` | a solo Daily run began |
| `daily_completed` | `dayNumber:int`, `score:int`, `correct:int`, `streak:int` | run finished; `correct` = flags named of `DAILY_ROUNDS` |
| `share_daily` | `dayNumber:int`, `score:int`, `rounds:int`, `streak:int`, `method:string` | Daily result copied/shared; `method` ∈ `share` \| `copy` |
| `share_party` | `mode:string`, `points:int`, `method:string` | game-over result copied/shared |

`screen_joined.via` gains a third value: `qr` (the TV was reached by scanning
the lobby's TV-connect QR), alongside `typed` and `link`.

`screen_joined` is emitted **only after the code resolves to a real room** (the
`sawState`/F4 gate), so a mistyped TV code never lands an attach. When a TV
auto-follows a finished room's `nextRoom` pointer into the next game it
re-connects with `via="follow"` — that is the **same physical TV session
continuing**, not a new attach, so `follow` is deliberately **NOT** emitted as a
`screen_joined`. `via` is therefore always one of `typed | link | qr` in
PostHog; `follow` exists only in the client re-connect path.

## Other events

`front_door_join`, `front_door_create`, `team_joined`, `screen_joined`,
`next_game`, `consent_given`, `consent_denied` — routing/funnel aggregates, all
schema-gated identically.

## Metrics tooling (the weekly "State of Flag Reveal" pull)

Two Node-built-in scripts (no npm deps) mirror GeoParty's proven pattern. They
target **PostHog project 256584** (Flag Reveal, EU instance
`https://eu.i.posthog.com`) — NOT GeoParty's 252836.

- **`tools/posthog_metrics.mjs`** — pulls the KPIs below over fixed 14d/30d
  windows into a single JSON bag. The `POSTHOG_PERSONAL_API_KEY` is read from
  the environment only (never committed, never printed). Windows are anchored
  to `--asof` (default today UTC) as literal `toDate('…')` bounds, never
  `now()`, so a re-run reproduces the same numbers. Per-query 30s timeout + one
  5xx/timeout retry. **Exit contract:** exit 0 only if every query succeeded;
  any error → exit 1 with `bag.ok=false` + `bag.errors=[failed keys]`.
- **`tools/posthog_report.mjs`** — pure `buildDigest(metrics, prev)` renders a
  deterministic markdown digest with week-over-week deltas. No-silent-sections
  policy: every section renders real numbers, `none in window`, or
  `⚠ NO DATA (query failed)` — a blank section can never masquerade as a
  healthy zero.
- **`tests/posthog-report.test.js`** — covers the pure `buildDigest` + the
  window builder with no network (all-error bag → markers not zeros; null
  exception stack doesn't crash; delta math incl. missing/unreliable baseline).

Usage:

```
POSTHOG_PERSONAL_API_KEY=... node tools/posthog_metrics.mjs \
  --asof 2026-08-24 --out /opt/data/flag-reveal-metrics/flag-metrics-2026-08-24.json
node tools/posthog_report.mjs flag-metrics-2026-08-24.json flag-metrics-last-week.json
```

The metrics JSON is written to a dated history under
`/opt/data/flag-reveal-metrics/` on the persistent volume and is **NEVER**
committed (this is a public Pages repo). The report's `prev` baseline is the
newest earlier dated file, rotated only after a fully-ok run.

### KPIs pulled

| key | window | question |
|---|---|---|
| `core_30d` | 30d | rooms created (`front_door_create`), teams joined, rounds (`flag_round`), rings (`flag_ring`), distinct players |
| `mode_mix_30d` | 30d | created vs rounds vs rings by `mode` |
| `funnel_14d` | 14d | party funnel: `front_door_join` → `team_joined` → `flag_round` → `next_game` |
| `ring_health_14d` | 14d | the core mechanic: `flag_ring` correct vs wrong, avg/median `atStep`, contested count |
| `round_outcome_14d` | 14d | `flag_round` won vs busted, avg `winningStep` |
| `daily_30d` | 30d | `daily_started` → `daily_completed` → `share_daily` |
| `share_party_30d` | 30d | `share_party` count — the flagship-mode virality signal |
| `tv_attach_14d` | 14d | `screen_joined` by `via` (typed \| link \| qr) |
| `exceptions_14d` | 14d | `$exception` by `$exception_functions` + `$exception_handled` |
| `consent_30d` | 30d | `consent_given` vs `consent_denied` |
