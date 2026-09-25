---
name: selection
description: createSelection, the multi-select state behind bulk actions — the selected set, the shift-click anchor and range, and one cached isSelected signal per id.
type: module
covers:
  - packages/core/src/selection.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/selection.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/coverage-core-timing-selection.test.ts }
  - { type: uses, target: signals.md }
last_verified: 2026-09-25
confidence: medium
---

# `selection.ts`

`createSelection<T>(options?)` returns a `Selection<T>` (`selection.ts:45`). It is a plain function that takes no `ctx`: the selection lives in the controller's closure and dies with it. Spec §16.5, "Multi-select for large lists".

## State

- `ids`, a signal of a `ReadonlySet<string>`, published as `selectedIds` through `readOnly`, so a cast finds no `set`.
- `anchor`, the id a shift-click ranges from. It is a plain variable, not a signal.
- `preShiftSelection`, the set as it stood before the first shift-click of a run. Each shift-click in the run computes its range against it, so a second shift-click can shrink the range. Every non-shift click and every programmatic call ends the run.
- `selectedById`, one `computed` per id behind `isSelected(id)` (`selection.ts:70`). It holds each computed through a `WeakRef`, and a `FinalizationRegistry` drops the map slot once the computed is collected. A row keeps one signal across renders, and a 50k-row table scrolled end to end does not pin 50k computeds.

## The anchor

The anchor is the row last clicked, as in a file manager. A plain click and `select(id)` move it to `id`. `toggle(id)` and a meta-click move it to `id` on add and leave it on remove (`selection.ts:104`). So a meta-click that deselects the anchor keeps it as the anchor, and the next shift-click ranges from that row. `deselect(id)` of the anchor clears it (`selection.ts:90`), so the next shift-click selects only the row clicked. `clear()` clears it, and `selectAll(ids)` sets it to the last id. A 1.0 review noted that the two paths disagree. They stay apart on purpose: the meta-click follows "last clicked", and a programmatic `deselect` has no click to follow. Pinned by `selection.test.ts`, "meta-click sets anchor on add, leaves it on remove" and "deselect() of the anchor clears it, while a meta-click off the anchor keeps it".

## Shift-click with a `Map`

`handleClick(id, mods, ordered)` takes the row ids in order, or a `Map` from id to its display index (`selection.ts:133`). The `Map` makes the two index lookups O(1). The range is every id whose index value lies between the two ends (`selection.ts:160-178`), which takes one pass over the `Map`.

Until 1.0 the range came from the `Map`'s insertion order: the code collected the keys at insertion positions `lo` to `hi`. A `Map` filled in id order but valued by display order therefore selected the wrong rows. With display order `c, a, b, d`, a click on `c` and a shift-click on `a` selected `c, a, b` where `c, a` was right. Pinned by "shift-click ranges by the Map's index values, not its insertion order". An id that is missing from `ordered`, at either end, falls back to a plain select of `id`.
