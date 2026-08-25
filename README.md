# Flag Party

**A Jackbox-style flag-guessing party game.** A flag reveals itself tile by
tile, blurry to sharp. Be the first to name the country and you take the round.
The TV shows the flag; everyone plays on their phones.

**Play it: [flagparty.social](https://flagparty.social)**
Source: [github.com/earino-assistant/flag-reveal](https://github.com/earino-assistant/flag-reveal)

There is no app to install and no server to run. It's a pile of static files on
GitHub Pages that talk to a Firebase Realtime Database for sync — that's the
whole stack.

---

## How to play

**Party mode (a room full of people):**

1. One person opens the site on their phone and starts a game. They get a
   short room code and a QR.
2. Everyone else joins from their own phone — scan the QR or type the code.
3. Optional but nicer: put the flag on the big screen. Open **Add a TV** on any
   browser (a laptop plugged into the TV, a smart-TV browser, whatever) and
   point it at the room. The TV is a pure spectator — it shows the flag and the
   scores and never touches the game.
4. A flag starts revealing. Ring in as soon as you recognize it. Earlier
   guesses are worth more points. Guess wrong and you're locked out of the
   round — but nobody sees *what* you guessed until the reveal.

**Daily solo:** not enough people around? **Play today's Daily** — five flags,
the same five for everyone that day, one run. Good for a coffee break and a
shareable score.

---

## The two party rulesets

- **First correct wins** (default) — the first person to name the flag takes
  the round; a wrong guess locks you out until the reveal.
- **Multiple guesses** — a wrong guess doesn't end your round; keep trying
  until someone gets it or the flag fully reveals.

Both come in an easy variant (tap one of four choices once they unlock) and a
harder text-entry variant (type the country name, aliases accepted).

---

## Architecture (the short version)

Static, no build step, no framework, no bundler, no runtime dependencies. Plain
ES modules served as files.

The code is split on a hard line:

- **`js/flag.js` — the pure brain.** All the real decisions (which flag this
  round, how tiles uncover, scoring, who won, when the game ends, the
  transaction cores) live here as pure functions: no DOM, no network. This is
  the layer that's unit-tested.
- **`js/*-ui.js` and friends — the thin glue.** `flag-ui.js` (phones),
  `screen-flag.js` (the TV), `daily-ui.js` (solo), `consent.js` (analytics
  gate). These wire the pure functions to the DOM and to Firebase. They stay
  deliberately dumb.

### The crown jewel: epoch-guarded arbitration

The hard problem in a real-time buzzer game is two phones ringing in at the
"same" moment. Flag Party settles that with a first-class **contended-write
primitive**: every phase-changing write is an *epoch-guarded transaction* over
one small authoritative subtree (`rooms/{CODE}/gameState`).

There are exactly three such writes:

- `claimTeamSlot` — take a team slot without stomping someone else's.
- `resolveRound` — `roundActive → reveal`, committing a single terminal
  outcome (a win *or* a bust). Whichever outcome the server serializes first
  wins; every stale or duplicate attempt sees the settled outcome and aborts.
- `advanceRound` — `lobby/reveal → roundActive/gameOver`.

The winning step is read from the *server's* snapshot, never a phone's stale
clock, and the reveal is never applied locally before it commits (so a
half-decided round can't flash a false winner or leak a hidden guess). Nothing
else flips a phase.

### The passive-TV contract

The TV **never** runs a transaction, never flips a phase, never advances the
game. It only writes a heartbeat so the room knows a screen is attached. Every
bit of game authority lives on the phones. This keeps a flaky TV connection
from ever corrupting a game.

---

## Running it locally

It's static files — serve the folder with anything:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

(Sync needs the Firebase config in `config.js`, which ships public client keys
by design. Once a page has loaded, it degrades gracefully offline.)

### Tests and checks

```sh
npm test        # Node's built-in runner over tests/*.test.js
npm run check   # node --check on every JS module (syntax gate)
```

Every feature ships with tests: decision logic goes in `js/flag.js` and gets a
`tests/*.test.js`; the DOM/Firebase glue stays thin. CI runs both on every push.

### Deploying

GitHub Pages, via `.github/workflows/pages.yml`. A push to `main` runs the same
checks, writes a single generated `release.json`, and deploys. Green means
live — the workflow polls the deployed `release.json` and fails the run unless
it stamps that run's id and sha. There's no build artifact to commit.

---

## Privacy

Privacy is a design constraint, not a footnote:

- **Aggregate-only analytics.** Every event is validated against a hard
  allowlist (`EVENT_SCHEMA` in `js/analytics.js`); an uninstrumented event is
  silently dropped. We capture steps, scores, outcomes, difficulty — never
  country names, never team names, never anything identifying.
- **Consent-gated.** Nothing is captured, and the analytics library isn't even
  loaded, until the player opts in.
- **Session-replay masking.** Any screen that renders a player-entered team
  name or a room code is masked in replays.
- **Its own house.** Flag Party runs on its own Firebase project (`flagreveal`,
  EU region) and its own PostHog project (EU-resident) — fully isolated from
  any sibling game.

---

## A note on the "reference implementation"

Flag Party reuses the sync kernel from **GeoParty** (a sibling geography party
game) as its concurrency backbone — the room model, the passive-TV contract,
the transaction discipline. On top of that kernel Flag Party adds the piece
GeoParty lacks: the first-class contended-write arbitration primitive described
above.

The two games are deliberately kept in step so that shared machinery can be
pulled out into a small framework. That extraction is an active workstream —
which is why the design docs (`SPEC-v3.1.md`, `docs/architecture.md`) read as
normative specs rather than casual notes.

---

## License

See [LICENSE](LICENSE). Flags are vendored into `assets/flags/` (never
hot-linked); dataset and attribution live in `data/`.
