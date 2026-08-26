# Button design review — the `.ld-second` secondary actions (GeoParty + FlagParty)

Scope: the two secondary buttons on each game's landing page — GeoParty's
"📺 TV screen" / "❓ How to play" (`geoparty/index.html`, `.ld-second
.btn-ghost`, `css/style.css:303–324`) and FlagParty's near-identical pair
(`flag-reveal/css/style.css:677–696`). Diagnose + recommend only; no source
was edited.

## 1. Diagnosis — why they feel flat

Four compounding problems, all measurable in the current CSS:

1. **The border is literally invisible (GeoParty).** The rule is
   `border: 1px solid var(--panel-2)` on `background: var(--panel-2)` —
   the same #22222C for face and edge. The border contributes zero pixels
   of information. FlagParty is one notch better (`--line-strong`,
   8%→15% white hairline) but still lands under a 2:1 edge.

2. **The face doesn't separate from the page.** #22222C on the #0E0E12
   background is a ~1.5:1 surface contrast. Even the hover face
   (`--raised`, #2E2E3A) is only ~1.4:1 against the page. On the landing
   the buttons also sit over the tail of the hero-pano scrim, which eats
   what little separation exists. A button whose face *and* edge are both
   sub-2:1 against its surroundings reads as a dark chip, not a control —
   this is the whole "not obvious" complaint.

3. **No pressed state anywhere.** There is no `:active` rule; hover only
   nudges the face one step (#22222C → #2E2E3A). A control with no
   press feedback never quite convinces the finger it's a button.

4. **The pill shape puts them in the wrong vocabulary.** In GeoParty,
   999px radius is otherwise used only for *status* chips — the offline
   badge (`style.css:120`) and the imagery status pill (`:2187`). Every
   *action* on the landing is a rounded rect: primary 14px, base buttons
   12px, daily card 14px, choice cards 16px. Two small pills with emoji
   under a card read as filter tags / metadata, not as things you press.

Net: these aren't badly-decorated buttons; they're correctly-decorated
**chips**. The fix is to move them back into the action vocabulary.

## 2. Recommendation — one treatment: the **soft-raised rect**

**Filled, not outlined** — and here's why. An outline-only button on this
ink ramp needs a ≥3:1 border against #0E0E12, i.e. a ~#5E5E66 line, which
reads cold and skeletal — and outlined-transparent is already this design
system's *ghost* idiom, reserved by `docs/ui-ux-design-review.md` §4.3 for
destructive/exit actions (Abandon, Leave, Back). "TV screen" and "How to
play" are inviting navigational actions; they should not wear the
destructive uniform. A filled face keeps them warm and pressable, and a
bright hairline edge — not the fill — does the "obvious" work, because no
face color from the ink ramp can reach 3:1 against the page without
breaking the palette.

This stays inside §4.1/§4.3 doctrine: it is a *neutral* fill from the
existing ramp, small and below the fold — not a second accent-filled peer
of "Start a party." Hierarchy on the page remains: gold-filled primary →
large glassy secondaries (Join, Daily) → small soft-raised tertiaries
(these) → footer text links.

### Anti-slop self-audit
No gradient. No backdrop blur (the glassy translucency stays with the
bigger cards; these get a solid face). No new hue — the only color is the
game's own gold #FFCF3F, and only as a hover ember, echoing the page's one
established hover signal (`.ld-daily:hover { border-color: var(--accent) }`).
Radius, weights, and every surface come from the existing token ramp.
The one signature detail: a 1px inset top highlight — a machined edge that
catches "light" the way a real key-cap does. That's the whole trick.

### Tokens (add to **GeoParty** `:root`)

GeoParty currently has no hairline tokens; that gap already caused the
`--line` drift bug (commit d38dec3) that the css-contract fence test now
guards. Adopt FlagParty's hairline scale plus one new step, same values in
both games:

```css
/* hairlines: light-on-dark borders read as crafted edges, not boxes
   (values shared with FlagParty for family consistency) */
--line:        rgba(255, 255, 255, 0.08);
--line-strong: rgba(255, 255, 255, 0.15);
--line-bold:   rgba(255, 255, 255, 0.25); /* ~3:1 edge on --raised: pressable faces */
```

FlagParty adds only `--line-bold` (it has the first two).

### The rule (GeoParty `css/style.css`, replacing lines 310–324)

```css
.ld-second .btn-ghost {
  padding: 11px 20px;
  min-height: 44px;                /* comfortable phone target */
  display: inline-flex;            /* centers the label vertically */
  align-items: center;
  border: 1px solid var(--line-bold);
  border-radius: 12px;             /* rejoin the action-rect family (base buttons: 12px) */
  font-size: 1rem;
  font-weight: 600;
  background: var(--raised);       /* solid face, one full step above the page */
  color: var(--fg);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07); /* machined top edge */
  transition: background 120ms ease, border-color 120ms ease;
}
.ld-second .btn-ghost:hover,
.ld-second .btn-ghost:focus-visible {
  color: var(--fg);
  background: #383845;                       /* one notch above --raised */
  border-color: rgba(255, 207, 63, 0.6);     /* gold ember — same hover language as .ld-daily */
}
.ld-second .btn-ghost:active {
  transform: translateY(1px);
  background: var(--panel-2);                /* darker face = pressed in */
  box-shadow: none;
}
```

Keep `.ld-second`'s layout block (flex, gap 10px, centered) as is. Don't
suppress the UA focus ring; `:focus-visible` sharing the hover style adds
to it, not replaces it. The 1px `:active` translate is positional press
feedback, not an animation — it's fine under the site's reduced-motion
rules, and the two 120ms transitions collapse harmlessly there too.

### FlagParty mirror (`flag-reveal/css/style.css:684–696`)

Same treatment in FlagParty's own units and tokens:

```css
.ld-second .btn-ghost {
  padding: 0.65rem 1.2rem;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line-bold);
  border-radius: var(--radius-sm);  /* 11px — its action-rect step */
  font-size: 1rem;
  font-weight: 600;
  background: var(--raised);
  color: var(--fg);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
  transition: background 120ms ease, border-color 120ms ease;
}
.ld-second .btn-ghost:hover,
.ld-second .btn-ghost:focus-visible {
  background: #383845;
  border-color: rgba(255, 207, 63, 0.6);
  color: var(--fg);
}
.ld-second .btn-ghost:active {
  transform: translateY(1px);
  background: var(--panel-2);
  box-shadow: none;
}
```

## 3. The numbers (contrast, touch, consistency)

- **Label**: #F4F4F6 on `--raised` #2E2E3A = **12.2:1** (AAA); on the
  pressed `--panel-2` face = 14.3:1.
- **Component boundary**: `--line-bold` composited over `--raised` ≈
  #62626A = **~3.2:1 against the page** — meets the 3:1 non-text
  (WCAG 1.4.11) bar that the current invisible border fails by a mile.
  This border is what makes the button "obvious"; the fill alone never
  can be on this ramp.
- **Gold ember hover**: rgba(255,207,63,.6) over the face ≈ #A98D46,
  ~4.7:1 vs the page — a clearly visible state change.
- **Touch**: `min-height: 44px` retained in both games; `inline-flex`
  centering retained; the two targets keep their 10px gap.
- **Cross-game**: identical treatment, identical token values, each
  expressed in its own radius scale (12px / `--radius-sm`). GeoParty's
  css-contract token fence passes because the three hairline tokens are
  defined in `:root` in the same change — and adopting FlagParty's
  hairline names closes the exact cross-repo drift class that bit d38dec3.

## 4. Two asides for the implementer (not blockers)

- The class name `btn-ghost` now lies twice: §4.3 defines ghost as the
  destructive/exit style, and these buttons are neither ghosts nor
  destructive. A follow-up rename to `.btn-quiet` (landing HTML + this
  rule) would keep "ghost" meaning one thing. Style-only change either way.
- `.ld-cta-sub` ("Have a code? Join") could later adopt
  `border-color: var(--line-strong)` for the same crafted-edge read at its
  bigger size; out of scope here, but it's the same disease in milder form.

Untestable change note: this is pure CSS (plus `:root` token additions);
no logic, no analytics signal — the existing css-contract test is the only
automated coverage that applies, and it covers the new tokens.
