---
'@kontsedal/olas-devtools': patch
---

Rework the panel's visual layer so every value is picked by role from a named scale.

- **Type and corners.** Nine literal font sizes, including `9.5px`, `10.5px`, `11.5px` and
  `12.5px`, become five role steps; eight corner radii become three tiers plus the pill.
- **Palette.** Solved rather than sampled: every foreground clears 4.5:1 against all four
  surfaces and the new `--olas-border-control` clears the 3:1 WCAG 1.4.11 asks of an edge that
  identifies a control. The indigo accent becomes a sea teal.
- **Chips.** A status chip painted its label in a status colour and its ground in a mix of that
  same colour, which moves the ground toward the label and spends the headroom the status tokens
  were solved to have. The chips drop the wash and take a solved edge.
- **Casing.** The tree's state chips keep their small caps and lose the letter-spacing.
- **Elevation.** The launcher and the floating window float, so each takes the shadow and drops
  its border. The launcher also loses a coloured glow and a decorative status dot that never
  changed and was `aria-hidden` beside a label already saying the same thing.
- **Theming.** The tokens are now declared on `.olas-devtools`, `.olas-devtools-launcher` and
  `.olas-devtools-floating` together. The launcher and window sit outside the panel in the DOM, so
  they inherited none of its custom properties and carried hardcoded hex instead — which is why
  the launcher stayed dark in a light app. Both now honour a host's `--olas-*` overrides.
- **Accessibility.** `JsonView` is an expand-and-collapse tree and had no `aria-` attributes at
  all; its toggles gain `aria-expanded` and the expanded ones, whose only content is a bracket,
  gain a name.
- **Fonts.** The stack leads with the system UI stack instead of Inter.

Removed tokens, none of which any rule still read: `--olas-accent-soft`, `--olas-success-soft`,
`--olas-warn-soft`, `--olas-error-soft`. Added: `--olas-border-control`, `--olas-dim`,
`--olas-accent-fg`, `--olas-font-ui`, `--olas-font-mono`, `--olas-shadow-float`, and the type,
corner and motion scales.
