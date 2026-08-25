# UI / design audit — polish pass (2026-08-25)

Diagnose-only audit of the Flag Party front-end (HTML + `css/style.css`),
prompted by the owner's note that the game is "missing some polish (like fonts
and things)" and specifically that **the "Start a party" section drops down
weirdly on the setup screen**. Compared throughout against the sibling's design
language in `/opt/data/geoparty/css/style.css`. No source was changed; this
document is the deliverable.

Contrast ratios below were computed (WCAG 2.x relative luminance) from the
tokens in `css/style.css:8-46`.

---

## Root cause: the "Start a party" drop-down

**Symptom.** Tap "Start a party" on the landing page → you land on
`player.html?create=1` → the page paints as the *join* screen (team name, room
code, Join) → a beat later the whole "Start a party" settings card pops in
below the ghost button, shoving the resume banner and footer down. On party
Wi-Fi the beat can be over a second. It reads as a glitch, not a transition.

**Mechanism.** Three stacked causes:

1. **The reveal waits on the Firebase CDN.** The panel is un-hidden inside
   `wire()` (`js/flag-ui.js:1212-1214`), which only runs after the module graph
   of `js/flag-ui.js` resolves — and that graph statically imports
   `js/firebase.js`, which imports two SDK modules from
   `https://www.gstatic.com/firebasejs/...` (`js/firebase.js:18-28`). Module
   scripts are deferred past first paint *and* blocked on those network
   fetches, so the join-only layout is guaranteed to paint first and the
   create card is guaranteed to appear late. The delay is the network's mood.
2. **The toggle is an instant accordion.** `#btnShowCreate` toggles `.hidden`
   (`js/flag-ui.js:1150-1152`), which is `display:none !important`
   (`css/style.css:132`) — a hard ~420px layout jump with no easing, no
   scroll-into-view, no focus move. The button label ("Start a party →",
   `player.html:38`) promises navigation but behaves as a collapse: tapping it
   again while open (including right after arriving via `?create=1`) folds the
   form away and the label never changes state.
3. **Create is subordinate to Join in the IA.** The create form is a
   disclosure *inside* the join screen (`player.html:40-73`), below the name
   field, the code field, and a primary Join button. A user who explicitly
   chose "Start a party" on the landing page still gets a join-first page with
   their actual task tucked under a ghost button.

**Recommended fix (in order of preference).**

- **Promote create to its own phase screen** (`#p-create`, sibling of
  `#p-home`), with a "← Back" ghost control, shown directly when
  `?create=1`. Route it from a tiny inline classic `<script>` before the
  stylesheet-blocked paint (read `location.search`, flip a class on `<body>`)
  so the correct screen is the *first* paint, independent of Firebase latency.
  `wire()` keeps only the event listeners.
- Minimal alternative: keep the disclosure but (a) un-hide via that same
  pre-paint inline script instead of `wire()`; (b) when open, hide the join
  group and swap the toggle label to a proper state ("Hide setup"); (c)
  `scrollIntoView` + focus the first select on manual open.
- Cosmetic-only (not sufficient alone): animate the disclosure with a
  `grid-template-rows: 0fr → 1fr` wrapper transition; this smooths the manual
  toggle but does nothing about the late `?create=1` pop-in, which is the part
  the owner is seeing.

**Risk:** low — pure DOM/CSS routing on one page; no `gameState`, no
transactions, no analytics schema involvement. Needs a quick pass over
`data-ph-mask` (none of the create fields carry names/codes) and a smoke test
of `?create=1`, `?room=CODE`, and the resume banner ordering.

---

## P0 — the "fonts and things"

### P0.1 The display font never loads — the brand face is a silent fallback

`--font-display` names **"Space Grotesk"** first (`css/style.css:35-36`) but
the repo has **no `@font-face` and no font asset** — the header comment
(`css/style.css:4-6`, 33-34) says "no web fonts" by design. GeoParty, whose
palette this game deliberately shares, *vendors* the face:
`/opt/data/geoparty/assets/SpaceGrotesk-Variable.woff2` + OFL license, declared
at `/opt/data/geoparty/css/style.css:5-11` with `font-display: swap`.

Consequence: every heading, the room code, scores, the TV answer line — all of
`--font-display` — renders in a *different* per-OS face (SF Pro on iOS, Segoe
UI on Windows, Roboto on Android). In a party room the phones and the TV are
different OSes, so the same game shows different typography on screens sitting
next to each other. This is almost certainly the "fonts" gap the owner is
sensing: the design was specced around Space Grotesk and nobody's device has
it.

**Fix:** copy `SpaceGrotesk-Variable.woff2` + `SpaceGrotesk-OFL.txt` from
GeoParty into `assets/`, add the same `@font-face`. A vendored font is a
static file — it satisfies "no CDN, works offline once cached" exactly like
the vendored flag SVGs do; the comment's real intent (no *hot-linked* fonts)
is preserved. ~100 KB, one request, `font-display: swap`.

**Risk:** a brief fallback-face flash on first uncached load (swap); metrics
differ slightly from current fallbacks, so eyeball the room-code block and TV
answer sizes after.

### P0.2 `font-weight: 800` exceeds the face's range

Space Grotesk variable spans **300–700** (see GeoParty's declaration,
`/opt/data/geoparty/css/style.css:8`). Flag Party asks for **800** all over the
display styles (`css/style.css:69, 111, 237, 559, 681, 685, 1013, 1071…`). If
P0.1 lands as-is, every one of those synthesizes faux-bold — smeared strokes,
exactly the "almost right" look polish passes exist to kill. Even today it
makes fallback faces render heavier than GeoParty's 700.

**Fix:** land together with P0.1 — change display-face weights 800 → 700 (or
declare the face `300 800` only if a genuine 800 cut is shipped, which the
variable file doesn't have).

### P0.3 The favicon doesn't exist

All five pages link `assets/icon.svg`
(`index.html:9`, `player.html:9`, `screen.html:9`, `daily.html:9`,
`howto.html:9`) — **the file is absent** (`assets/` contains only `flags/` and
`howto/`). Every tab shows the browser default globe and every page load 404s.

**Fix:** ship a small SVG (the 🚩-on-dark mark the theme-color implies). Quick
win; also unblocks a real `og:image` later (P2.8).

---

## P1 — visible seams

### P1.1 Anchors dressed as buttons lose the button base styles

Radius, padding, and min-height live on the `button` element selector
(`css/style.css:86-98`); `.btn-primary`/`.btn-ghost` only add colors
(`css/style.css:108-119`). Any `<a>` wearing those classes silently drops the
base:

- `index.html:32` — the landing's **primary CTA** "Start a party" is an `<a
  class="btn-primary ld-cta-main">`: **square corners** (`.ld-cta-main` adds
  padding but no radius) beside the rounded "Have a code? Join" `<button>`
  directly under it.
- `howto.html:35` — "Back to the party" `<a class="btn-primary">`: **no
  padding at all**; the yellow fill hugs the text like a highlighter stroke.
- `daily.html:38` — "← Home" `<a class="btn-ghost">` inside the fixed action
  bar: no padding/min-height, so its text top-aligns against the 44px+ "Play
  today's Daily" button next to it.

**Fix:** one line — extend the base rule to `button, .btn-primary, .btn-ghost
{ ... }` (plus `display:inline-flex; align-items:center;
justify-content:center; text-decoration:none` for the anchor case), or
introduce a `.btn` base class on those three anchors. Quick win; re-check
real buttons for no-op double application (harmless) and the howto link's new
size.

### P1.2 Create-panel internal spacing and the runt button

Within `#createPanel` (`player.html:40-73`):

- **Zero gap above the card.** `#btnShowCreate` has no bottom margin and
  `.card`/`.settings-group` margins are bottom-only (`css/style.css:166,
  202-208`), so the card butts against the toggle button.
- **"Start the party" is a shrink-to-fit runt.** Five full-width selects
  (`input, select { width: 100% }`, `css/style.css:175-184`), then a
  default-width `.btn-primary` with **no top margin**, touching the last
  select. The commit action of the whole flow is the smallest thing on the
  card.

**Fix:** `#createPanel .btn-primary { width: 100%; margin-top: 0.9rem; }` and
a `margin-top` on the panel (or a gap on a wrapping flex column). Pairs
naturally with the P0 dropdown rework.

### P1.3 How-to page: the step screenshots exist but aren't used

`assets/howto/` ships three vendored step images (`howto-open.jpg`,
`howto-ring.jpg`, `howto-reveal.jpg`) — nothing references them (grep:
zero hits). `howto.html:17-33` is a bare `<ol>`. GeoParty's stated pattern is
"three steps, pictures over paragraphs"
(`/opt/data/geoparty/css/style.css:259`). The polish was half-shipped: assets
vendored, page never updated.

**Fix:** embed the three images into the matching `<li>`s with a small
`.howto-shot` style (rounded, hairline border, like `.recap-flag`). Low risk;
alt text required.

---

## P2 — consistency and finish

### P2.1 `--faint` fails AA where it's used as text

`--faint` (#7c7c8a) on `--panel` (#17171e) = **4.34:1**, under the 4.5:1 AA
threshold for normal-size text. It's used for input placeholders
(`css/style.css:185`) and `.daily-card-label` at 0.72rem
(`css/style.css:1060-1067`) — tiny text is where the margin matters most. On
`--bg` it's 4.68:1, barely over. Everything else checks out well: `--muted` on
panel 8.3:1, accent-ink on accent 12.2:1, good/bad/accent-2 on bg 7–11:1.

**Fix:** nudge `--faint` to ≈ #8b8b99 (≥4.5:1 on panel). One-token change.

### P2.2 The toast pops instead of fading

`toast()` toggles `.hidden` with a 2.6s timer (`js/ui-common.js:25-31`); the
`.toast` style has no opacity transition (`css/style.css:580-585`). GeoParty's
toast fades over 0.3s via a `.show` class and caps width at `min(92vw, 420px)`
(`/opt/data/geoparty/css/style.css:124-146`); Flag Party's stretches to 90vw
on a desktop TV browser. **Fix:** port the `.show`/opacity pattern + width
cap. Respect `prefers-reduced-motion` (collapse to instant).

### P2.3 Literal `······` placeholders instead of skeletons

`player.html:97` (`#lobbyCode`), `screen.html:44,53` (`#tvCode`,
`#tvJoinCode`) render dot strings until JS fills them. GeoParty explicitly
fixed this ("P1.7: a placeholder that reads as loading, not as a real empty
value") with a pulsing `.skeleton` class
(`/opt/data/geoparty/css/style.css:73-86`). On slow loads the TV shows a giant
gold "······" that reads as content. **Fix:** port `.skeleton` (it already
handles reduced motion), add/remove it in the render paths.

### P2.4 No vertical centering on tablet/desktop

`.phase-screen` is just `min-height:100vh` (`css/style.css:150`) with a
560px column pinned top-left of the viewport — visible in
`review-shots/lobby-fresh.png` (content hugs the top, void below). GeoParty
centers its setup/intro screens at ≥768px ("P1.3: void fill",
`/opt/data/geoparty/css/style.css:102-106`). **Fix:** same media query for
`#p-home`, `#d-intro`, `#d-done`. (The landing already has `padding-top:11vh`;
see also P2.7.)

### P2.5 Five competing "microlabel" styles

`.eyebrow` (`css/style.css:134`), `.section-label` (:249), `.join-qr-cap`
(:969), `.daily-card-label` (:1060), `.side-title` (:690) are the same
uppercase-tracked label with drifting values: letter-spacing 0.12 vs 0.14em,
size 0.72 vs 0.85rem, color `--muted` vs `--faint`. **Fix:** one `.microlabel`
base + modifiers; pure refactor, no visual change except the drift it erases.

### P2.6 Stylesheet hygiene: duplicate `.beat`, px-vs-rem drift

`.beat` is declared twice (`css/style.css:572` and :781 — the second silently
converts the first to flex); `.ld-footer`/`.ld-daily` use GeoParty's px scale
(8px/10px/12px/13px/16px, :610-617, :1022-1036) inside an otherwise rem-based
file. Cosmetic-only consolidation.

### P2.7 Landing footer floats mid-screen on tall phones

`.landing-hero` is `padding-top:11vh` in a normally-flowing page
(`css/style.css:603`); the footer sits wherever content ends, with dead space
below on tall viewports. GeoParty's landing is a `min-height:100svh` flex
column so the hero fills and the footer sits at the bottom
(`/opt/data/geoparty/css/style.css:171-195`). **Fix:** flex column +
`margin-top:auto` on the footer block.

### P2.8 No `og:image`

`index.html:10-12` and `daily.html:10-12` set og:type/title/description but no
image — shared links get a bare text card. Needs an actual share graphic
(**design decision**: a flag-mosaic banner would sell the game in one glance).
Depends on P0.3's mark.

---

## Summary for the owner

**Top fixes, in order:**

1. **The dropdown (his bug):** the create panel is revealed by JS that waits
   on the Firebase CDN import, so `player.html?create=1` always paints as the
   join screen first and the form pops in late. Promote "Start a party" to its
   own screen routed by a tiny pre-paint inline script (or at minimum un-hide
   it pre-paint) — the fix is routing, not animation.
2. **The fonts (his hunch is right):** Space Grotesk is named in the CSS but
   never shipped, so every device renders a different fallback. Vendor
   GeoParty's woff2 (+ OFL) and drop the 800 weights to the face's real 700
   max.
3. **Missing favicon** (`assets/icon.svg` is referenced everywhere, exists
   nowhere) — quick win.
4. **Anchor "buttons"** lose radius/padding: the landing's primary CTA has
   square corners, howto's back link is an unpadded yellow smear — one
   selector change.
5. **Create-panel spacing:** full-width the "Start the party" button, add
   breathing room — fold into fix #1.

Quick wins: #3, #4, `--faint` contrast bump (P2.1), toast fade (P2.2).
Design decisions needed: og:image / icon artwork (P0.3, P2.8), whether the
how-to page gets the already-vendored step screenshots (P1.3), and whether
create becomes its own screen (recommended) or stays a disclosure.
