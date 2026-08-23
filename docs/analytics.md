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

## Other events

`front_door_join`, `front_door_create`, `team_joined`, `screen_joined`,
`next_game`, `consent_given`, `consent_denied` — routing/funnel aggregates, all
schema-gated identically.
