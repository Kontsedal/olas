---
name: ui-rules
description: The ten rules every Olas interface follows, the scales they are picked from, the marks that make a screen read as generated, and which of the ten are checked by anything.
type: decision
covers:
  - examples/_shared/ui/tokens.css
  - examples/kanban/src/ui
  - examples/stock-ticker/src/styles.css
  - examples/reader-ssr/src/styles.css
  - examples/virtualized-table/src/styles.css
  - packages/devtools/src/styles.ts
edges:
  - { type: documented-in, target: ../../CLAUDE.md }
  - { type: related, target: prose-rules.md }
  - { type: uses, target: ../modules/examples.md }
  - { type: uses, target: ../modules/devtools-panel.md }
last_verified: 2026-09-20
confidence: medium
---

# Interface rules

Olas ships four example apps and one published UI package. The examples are how most people meet
this library, and the devtools panel is the only interface a consumer sees without cloning
anything. This page is what they all follow.

`prose-rules.md` does this job for the writing. This is the same idea for the screen.

## Why there is a page at all

Before this pass, the five surfaces had been styled one at a time. Counted, not remembered:

| What | Where it stood |
|---|---|
| Font sizes in kanban | **15 distinct literals**, `0.55rem` to `1.0625rem`. Two came from a token. |
| Font sizes in devtools | **9**, including `9.5px`, `10.5px`, `11.5px` and `12.5px` |
| Corner radii in devtools | **8** — 3, 4, 6, 8, 10px, `999px`, `50%`, `0` |
| Accent hue | violet-indigo in **three of four examples and devtools** |
| `prefers-reduced-motion` | **1 file**, against 8 keyframes in kanban and 1 in virtualized-table |
| Border and shadow on one element | 4 places |

Each of those numbers was picked by eye, so each was right for one configuration and arbitrary
everywhere else. That is the failure this page exists to name.

## The ten rules

### 1. One fact, one mark

A fact gets one visual carrier. A second is redundancy and a third is decoration. Point at
anything on screen and count its carriers; more than one needs a reason a reader could state.

The devtools launcher carried a green dot beside a label reading "Olas devtools". The dot was
`aria-hidden`, it never changed, and the label already said it. It is gone rather than restyled.
The selected tab had three carriers: the label brightening, the accent underline, and a filled
count badge, and the badge was the one that failed contrast.

The counter-example is the test. A column's identity dot stays, because it IS the identity and
nothing else carries it.

### 2. Colour is the last tool

Two halves: what colour is allowed to mean, and what to reach for first.

**The accent marks state.** `--color-accent` means one of two things: *this is what you chose*,
or *this is what happens next*. The submit button's fill, the selected tab's underline, the
active filter's wash. Not a hover, not a heading, not a logo glow. A hover is a change the user
caused, so it moves a neutral; it is not a state, so it does not spend the accent.

That rule removed the accent from four hovers across three apps, and moved a row's `medium`
priority off the accent and onto `--color-info`, because a priority is a severity and the accent
is not part of a severity ramp.

**Hierarchy is weight and position. Dimming is last and it has a floor.** A dimmer colour is the
cheapest way to make something look secondary, and it is the one with no headroom.
`--color-fg-dim` sits at 4.58:1 against the darkest surface it can land on, which is all of it.
The sidebar's section header separates itself with weight, not by fading.

**A tint of the text's own hue is not a background, it is a contrast reduction.** This one cost
the most sites. A chip painted its label in a status colour and its ground in a mix of that same
colour, which moves the ground toward the label every time. The status tokens are solved to clear
4.5:1 with nothing to spare, so the tint spends exactly the headroom they have. Worse, the kanban
label pills did it at a hue taken from the API, so no ratio could be stated for them at all.

Seven chips lost their wash. They take an edge in `--color-border-control`, which is solved per
theme. **Before tinting a surface with the colour standing on it, ask what is left between them.**

### 3. Every value comes from a named scale, picked by role

The scales live in [`examples/_shared/ui/tokens.css`](../../examples/_shared/ui/tokens.css), and
`packages/devtools/src/styles.ts` carries the same ones by value because a published package
ships no stylesheet a host could import.

| Scale | Steps |
|---|---|
| type | `mark` 10 · `chrome` 11 · `meta` 12 · `body` 13 · `title` 15 · `display` 20 |
| corners | `surface` 8 · `control` 6 · `mark` 4 · `pill` |
| control height | `sm` 24 · `md` 28 · `lg` 36 |
| space | 2 · 4 · 6 · 8 · 12 · 16 · 24 · 32 |
| motion | `fast` 120ms · `base` 180ms, one curve |

Pick by what the thing IS. If no role fits, the scale is missing a step, and adding it there is
the change, rather than a literal at the call site.

**Prose never drops below `meta`.** Help text, empty states and field labels are read rather than
scanned. `mark` and `chrome` are for a chip or a count.

### 4. A control beside a control shares its box

Height, corner and border token. All three. Measure the element that draws the border, not the
thing inside it.

Kanban's search field, its buttons, its inputs and its selects now take the same ladder step, the
same `--radius-control` and the same `--color-border-control`, so a row of four cannot drift.

### 5. Three corners, and each one names a layer

`surface` is a card, a panel, a dialog, a popover. `control` is a field, a button, a tab. `mark`
is a chip, a badge, a tag. Then the pill.

**A surface inside a surface takes the next tier down, and a surface beside one takes the same.**
So the question is not only what the element is. It is what it sits beside. The devtools panel
docked inside the floating window gives up its corner entirely, because the window draws it now.

A control wearing the surface corner reads as a card someone can click. A control wearing the
mark corner reads as an afterthought beside the field it belongs to.

### 6. An edge or an elevation, never both

A hairline paired with a wide diffuse shadow is one of the most reliable marks of an interface
no one decided about. Commit to one.

Only the things that float take `--shadow-float`, and they drop their border to earn it: the
dialog, the toast, the devtools window and launcher, a card under the cursor. Everything else
takes the border. There is one shadow token, so there is no ladder of elevations to guess a
step on.

### 7. Nothing appears or moves until it has earned it

Motion confirms a change the user caused. Colour and opacity transitions; no entrance
choreography, no scroll reveals, no stagger, and no `transition: all`, which animates properties
no author chose, layout ones included.

Anything that loops or enters carries its own `prefers-reduced-motion` answer, written per
animation rather than as a blanket override, so the element still appears and only the movement
stops.

What that removed: a pulsing coloured halo, a gradient shimmer sweeping across every loading
block, a card that lifted 4px and grew a shadow on hover, and two slide-ins nothing used.

### 8. Case follows what the text IS

Three rows, and the third is the one that bites.

| The text is… | Treatment |
|---|---|
| a heading **above a group** | `uppercase`, **no** tracking |
| a label naming **one value** | Capitalized, no transform |
| data, an identifier, anything the user typed | **no transform at all** |

A `text-transform` cannot tell a label from a value. Kanban shouted its column titles in caps,
and a column title is a name the user typed.

`uppercase` paired with `letter-spacing`, used as the default for every small label, is the
cliché. Six sites across four surfaces kept the case and lost the tracking.

### 9. Density is the point

These are data surfaces. The rhythm is 4-8px, not the 16-24px a brochure wants. A generated
dashboard feels like a toy mostly because it is spaced like a landing page, and a dense
instrument reads at a 4 to 8px corner rather than a 16px one.

Prose is the exception, and rule 3 gives it a floor.

### 10. "It looks off" is not a finding

Measure before changing, or the fix lands on the wrong number and becomes a second defect.

This pass is the argument for the rule. The palette was not sampled. It was solved, with a
script converting oklch to sRGB to relative luminance, asserting 4.5:1 for every foreground on
every surface and 3:1 for every control boundary, in both themes. Five things came back different
from what they looked like:

- Solving each foreground straight *to* the floor put two of the three tiers 0.04 apart in
  lightness. Three tiers of which two are indistinguishable is worse than two tiers.
- `--color-border-strong` measured **1.7 to 2.0:1** against the surfaces it edged, against the
  3:1 WCAG 1.4.11 asks of an edge that is what identifies a control. That is why
  `--color-border-control` exists as a separate, solved token, and why `--color-border` stays a
  quiet divider where a low-contrast hairline is the intent.
- Four accent and status values were authored outside the sRGB gamut, so the browser would have
  clipped them and the rendered colour would not have been the authored one.
- A fixed lightness and chroma across arbitrary hues **failed at hue 192 and fell out of gamut
  across a third of the circle**.
- The sparkline in stock-ticker stroked `var(--green)` and `var(--red)`, which were declared
  nowhere in the repo.

None of those five is visible by looking.

## Identity colour, which is the subtle one

Categorical colour is not banned. It is right when it separates one person, label or column from
another — that is a different job from marking state, and it has its own scale.

Three things make it work here.

**The datum picks a slot, not a colour.** The API stores an OKLCh hue per user, label and column.
A hue is a reasonable thing for data to carry, and it is not a colour anyone checked. So
[`identity.ts`](../../examples/kanban/src/ui/identity.ts) maps it to the nearest of eight slots at
the render boundary, which is where a value from outside becomes a value from the scale. The API
is untouched.

**Identity colours are non-text marks and nothing else** — a dot, a strip, an avatar ring. This is
not fussiness, it is what lets the palette stay chromatic: requiring a white initial to clear
4.5:1 on top of an identity ground forces every hue dark, and the solver drove chroma down to
0.06, which is nearly grey. As a 3:1 mark instead, the family carries 0.099. So an avatar rings
itself and sets its initials in `--color-fg` on the surface underneath.

**It is not the alarm ramp.** Cycling severity tokens as a qualitative palette puts rows in red
and amber that mean nothing, using the same tokens real trouble uses. A severity ramp is not a
qualitative palette, and a positional assignment makes a hue mean nothing across two views.

## What reads as generated

A short list, and it is not a blocklist. Avoiding all of it produces an interface defined by what
it refused. The core idea is the opposite: pick one strong opinion and commit to it, rather than
shipping several conflicting safe defaults.

- A violet or indigo accent, and gradient fills used as decoration.
- A kit with its tokens left untouched. Five edited tokens is most of the distance.
- Cards inside cards inside cards, each with its own padding and shadow.
- A coloured left rule down the edge of every card.
- A hairline border and a wide diffuse shadow on the same element.
- `uppercase tracking-wider` as the default for every small label.
- Landing-page spacing on a data surface, and a 16px corner on a dense instrument.
- Everything fading in from below at once; a card lifting on hover.
- Emoji standing in for an icon system.
- A `<div onClick>` where a `<button>` belongs, and an unlabelled control. A generated control is
  assembled from what a control looks like rather than from what a control IS.

**The list decays, and that is the important part.** A pattern that looked original two years ago
is a cliché now, because the striking page gets attention, the attention lands in the next
training set, and the next model treats it as normal. Re-verify an entry before citing it.

The deeper form: a screen can carry none of these marks and still read as generated, through its
uniformity and the absence of any decision that cost something.

## What each app commits to

One shared vocabulary, so the suite reads as a system. One opinion each, so it does not read as a
skin.

| Surface | Accent | Why |
|---|---|---|
| `packages/devtools` | sea teal, hue 196 | it ships as a package, so it *is* the brand |
| `examples/kanban` | sea teal | the flagship carries the brand |
| `examples/virtualized-table` | sea teal | it hosts the devtools panel, and a second hue would show as a seam |
| `examples/stock-ticker` | gold, hue 88 | a ticker's colour budget is spent on the price ramp, so the accent lives outside it |
| `examples/reader-ssr` | warm red, hue 17 | a serif reading column — the one app that already had an opinion |

*Olas* means waves, which is where the teal comes from.

**Stock-ticker's accent retired a token, and that is the shape of the decision rather than a side
effect.** Gold at hue 88 is where `--color-warning` lived, and that app had exactly one warning:
the toast an alert fires. An alert firing is the app's headline event, so it takes the accent and
the warning token is gone. One token, one meaning — two tokens at one hue meaning different
things is the drift.

The type families are the system stack everywhere. An example app should not ship a webfont to
make a point about state management, and the identity here comes from the scale and the density
rather than from the typeface.

## What is checked

**Nothing. All ten rules are judgement, checked in review.**

That is the honest state and the page earns its keep by saying so rather than implying a gate that
does not exist. `pnpm wiki:lint` and `pnpm prose:lint` cover this page as a document; neither
looks at a stylesheet. `pnpm test` covers the devtools panel's structure, which is how the
`aria-expanded` additions to `JsonView` are held, and nothing else here.

Two consequences worth stating.

**The palette is the part that is verified, and the verification is not in the repo.** The solver
ran once, in a scratch directory, and its output is the values in `tokens.css` and `styles.ts`.
Re-deriving it means writing it again. The ratios quoted on this page are what it reported on
2026-09-20.

**A gate that reads source text misses a rule the moment its expression changes shape.** If one is
ever written here, the thing to ask is which spelling of the same decision it will not see: a
colour in an inline `style` rather than a class, spaced caps in a `.css` file rather than a
`className`, a size inside a template literal.

## Using this page in a review

Six questions, in this order.

1. What fact is each new mark carrying, and is anything carrying one twice?
2. Does any colour here mean something other than "chosen" or "what happens next"?
3. Did every number come from a named step, or did one come from the eye?
4. Does each control match the control beside it in height, corner and edge?
5. What does this look like narrow, and in the other theme?
6. Which of the above did you MEASURE, and which did you look at?
