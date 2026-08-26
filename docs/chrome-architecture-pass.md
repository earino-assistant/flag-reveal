# Chrome architecture pass — `.ld-second` / footer across FlagParty & GeoParty

**Scope:** the home-page secondary-actions row (`.ld-second`) and slimmed
footer shipped in flag-reveal `ff65b00`/`237b94a` and geoparty
`7b45795`/`3261ee6`. Diagnose + advise only; no source edits in this pass.

**Date:** 2026-08-26 · **Seat:** planning/review (Fable)

---

## 0. TL;DR

1. **Live bug in GeoParty:** `css/style.css:313` borders `.ld-second
   .btn-ghost` with `var(--line)` — **`--line` is defined nowhere in
   GeoParty**. The declaration is invalid at computed-value time, so
   `border-style` collapses to `none`: the buttons render borderless in
   production right now. The remembered "`--line-strong` undefined" issue was
   really this one, and swapping the name didn't fix it — `--line` is a
   *FlagParty* token (flag-reveal `css/style.css:41`) that GeoParty never had.
2. The two placements are less divergent than they look — both rows terminate
   the action stack. Keep the placements; converge the CSS and name the rule.
3. Touch targets: FlagParty is genuinely correct; GeoParty is tappable but
   fragile (44px comes from flex-item blockification, not the element) and
   the label rides high in the box.
4. Both repos put raw emoji in the accessible names, against their own
   `aria-hidden` art-span convention.
5. The pre-deploy gate already exists (both repos run `npm test` in
   `pages.yml`); the gap is coverage. Two cheap tests close the whole class:
   port GeoParty's `html-contract.test.js` to FlagParty, and add a ~15-line
   "every `var(--x)` is defined" test to both.

---

## 1. Is the chrome layout coherent? — Yes, once you name the rule

Surface reading: FlagParty's row sits above the footer; GeoParty's sits under
the Daily card inside the header. That looks like divergence. It isn't:

- FlagParty order: Daily → CTA panel → **ld-second** → footer.
- GeoParty order: CTA panel → panels → Daily → **ld-second** → steps strip → footer.

In **both** games `.ld-second` is the last element of the *decision stack* —
the block of things a player can act on — and the footer is ambient chrome
(Feedback · Privacy · GitHub · ownership). GeoParty merely has a content
section (`.ld-steps`) between the stack and the footer; FlagParty doesn't.
Forcing identical DOM position would mean either pushing GeoParty's row below
its steps strip (worse: actions after decoration) or deleting the strip.

**Position: keep both placements, codify the invariant.** The convergence
target for `party-kernel` is not "same position in the page" but the rule:

> `.ld-second` terminates the action stack (immediately after the last play
> lane); `.ld-footer` is ambient and holds no play actions.

Add that line to the chrome doctrine section of `CONTRACTS.md` when the
extraction (docs/framework-extraction-plan.md) lands. What *should* converge
now is the CSS block itself — the two `.ld-second` rules are 90% identical
and drifted only in units (rem vs px) and in the token bug above.

## 2. Touch / mobile correctness

**FlagParty — correct by construction.** The base rule
(`css/style.css:102`) covers `button, .btn-primary, .btn-ghost` with
`display:inline-flex; align-items:center; min-height:44px`, explicitly so
anchors wearing button classes get button metrics. The `.ld-second` override
keeps all of it. Real ≥44px targets, labels vertically centered. ✔

**GeoParty — tappable, but by accident.** Its base `button` rule doesn't
cover anchors, and base `.btn-ghost` sets no display or min-height. The
`.ld-second .btn-ghost { min-height:44px }` only works because the parent is
`display:flex`, which blockifies the anchor children. Two consequences:

- The 44px evaporates if this markup is ever reused outside a flex row
  (inline elements ignore `min-height`). Nothing marks that dependency.
- Nothing centers the label: content (~38px of padding+text) sits at the top
  of the 44px box, so the label rides ~3px high.

**Fix (one line):** add `display:inline-flex; align-items:center;
justify-content:center;` to GeoParty's `.ld-second .btn-ghost` — or better,
adopt FlagParty's base-rule pattern (`button, .btn-primary, .btn-ghost`) so
every future anchor-as-button is correct for free. The footer links
(`.link-btn`, plain `<a>`s) are sub-44px in both repos; acceptable for
tertiary chrome, but don't promote play actions into the footer (see §1 rule).

## 3. Sustainability — this is token drift, and it's cheap to fence

The live bug is exactly the failure mode the extraction plan predicts: the
chrome was hand-copied between repos, and the pasted block used the *source*
repo's token vocabulary (`--line`/`--line-strong` exist only in FlagParty).
CSS custom properties fail **silently** — no console error, no test, just a
missing border. Until `css/tokens.css` is extracted (it's already on the
kernel list in `framework-extraction-plan.md` §1.1), every hand-copy re-rolls
these dice.

Cheap moves now, in order of value per effort:

1. **CSS-token contract test in both repos (~15 lines, catches the live
   bug).** Same pure-string style as GeoParty's contract harness:

   ```js
   // tests/css-contract.test.js
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";
   test("every var(--x) used in css/ is defined somewhere in the repo's CSS", () => {
     const css = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
     const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
     const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
     const missing = [...used].filter((v) => !defined.has(v));
     assert.deepEqual(missing, [], `undefined CSS custom properties: ${missing.join(", ")}`);
   });
   ```

   (Extend the glob if either repo ever grows a second stylesheet. Both
   repos' `pages.yml` already run `npm test`, so this becomes a deploy gate
   the moment it exists.)

2. **Port GeoParty's `tests/html-contract.test.js` to FlagParty.** FlagParty
   has no HTML↔JS contract test at all; GeoParty's test B ("every
   `$()`/`getElementById` id exists in its page") is precisely the
   dropped-`#ldHowto` class. The extraction plan already lists this harness
   as kernel material — porting it now is pre-payment, not throwaway.

3. **Freeze the token vocabulary for copied chrome.** Until `tokens.css` is
   shared, any CSS block copied between repos may only use tokens defined in
   *both* `:root`s (`--bg --panel --panel-2 --raised --fg --muted --accent
   --disabled-fg` + team colors). The test in (1) enforces the destination
   side mechanically; the rule makes intent explicit for agents.

Don't do more than this now — extracting `tokens.css` properly is Phase-work
in the extraction plan, and duplicating it early creates a third copy.

## 4. What this change broke or left fragile

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | **Bug (live)** | geoparty `css/style.css:313` | `var(--line)` undefined in GeoParty → `border: 1px solid var(--line)` invalid at computed-value time → **no border renders**. Fix: use `var(--panel-2)` (GeoParty's established border token, cf. base `.btn-ghost` at :1984) or define `--line` in `:root`. |
| 2 | Fragile | geoparty `.ld-second .btn-ghost` | 44px target depends on parent flex blockification; label not vertically centered (§2). |
| 3 | A11y | both `index.html` | Raw emoji in button labels (`📺 Add a TV`, `❓ How to play`) enter the accessible name — screen readers announce "television Add a TV". Both files elsewhere wrap decorative emoji as `<span class="art" aria-hidden="true">…</span>` (FlagParty's Daily 🚩, GeoParty's chooser 📱📺). Wrap all four glyphs the same way. |
| 4 | Analytics drift | geoparty `landing-ui.js:152` | `howto_opened {source:"footer"}` — the link left the footer two commits ago; the source label now lies, and longitudinal funnel reads will silently blend placements. Rename the source value (e.g. `"landing"`) or note the discontinuity in `docs/analytics.md`. |
| 5 | Missing signal | flag-reveal `index.html:55-58` | FlagParty's new How to play / Add a TV buttons have no ids and no `track()` — FlagParty loses the top-of-onboarding-funnel event GeoParty considers §6-critical. If wanted, add an event via `EVENT_SCHEMA` (allowlist first, per CLAUDE.md). |
| 6 | Nit | both | `.ld-second` styling drift: units (rem vs px), FlagParty lacks the `:focus-visible` state GeoParty added (harmless — FlagParty has a global focus ring at `css/style.css:92`; GeoParty has none and relies on the UA default, which the background-change rule partially obscures). Converge when the block is next touched. |

Verified fixed / non-issues: `#ldHowto` is present in GeoParty's committed
`index.html:84` and wired in `landing-ui.js` (test B would now hold it);
FlagParty's tokens are all defined; nothing else on these two pages
references the moved links; replay-mask surface unchanged (no team name /
room code renders in the touched chrome).

## 5. The planning habit — make the existing gate see chrome

The instinct "add a review ceremony" is half wrong here. Both repos already
have a hard pre-deploy gate — `pages.yml` runs `npm test` before publish —
and GeoParty's contract harness already catches the dropped-id class. The
two escapes happened because (a) FlagParty never got the harness, and (b) no
test class existed for CSS tokens. **The cheap fix is coverage, not
ceremony.** Concretely, for a solo CTO + agents:

1. **Extend the gate** — land §3 items 1–2 (css-contract in both,
   html-contract ported to FlagParty). After that, both escapes in this
   incident are mechanically impossible to deploy.
2. **A 60-second chrome checklist**, run as the last step of any chrome
   change, per repo touched (paste it into the agent prompt or run it
   yourself):
   - [ ] `npm test` in **every** repo touched (not just the one you started in)
   - [ ] every id referenced by that page's controller still in the HTML
   - [ ] every `var(--x)` in pasted/edited CSS defined in *this* repo
   - [ ] emoji/decoration wrapped `aria-hidden`; label text stands alone
   - [ ] targets ≥44px from the element's own rules, labels centered
   - [ ] analytics: moved link ⇒ does any event's `source`/label still tell
         the truth? `docs/analytics.md` updated?
   - [ ] team name / room code rendered? ⇒ `data-ph-mask` +
         `docs/replay-mask-checklist.md`
3. **One cross-repo rule:** a change described as "same on both games" gets
   one diff-only review pass per repo *against the checklist* before deploy
   — an agent seat, ten minutes, no meeting. The failure mode this pass
   found (fix applied to the shared idea, not to each repo's reality) is
   exactly what a per-repo pass catches.

When `party-kernel` lands, items 1–2 become the kernel's `contract/*` suite
and this document collapses into `CONTRACTS.md`'s chrome section.
