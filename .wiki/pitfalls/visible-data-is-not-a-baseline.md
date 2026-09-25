---
name: visible-data-is-not-a-baseline
description: Under live optimistic layers, the data on screen holds the guesses; a write that sets a baseline from it, or a commit that leaves the baselines below it alone, makes a rollback restore a wrong value.
type: pitfall
covers:
  - packages/core/src/query/entry.ts:924-1122
  - packages/core/src/query/infinite.ts:974-1163
edges:
  - { type: tested-by, target: ../../packages/core/tests/optimistic-layers.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/property/entry.property.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/property/infinite.property.test.ts }
  - { type: related, target: ../entities/entry.md }
  - { type: related, target: ../decisions/canonical-vs-optimistic-writes.md }
  - { type: related, target: ../modules/entities.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-25
confidence: medium
---

# The data on screen is not a baseline

An optimistic layer stores a **baseline**: the value a rollback restores (SPEC §6.4). While layers are live, `data` is the baseline with every live guess applied on top. Any code that changes a baseline has to keep that split. Three engine bugs broke it, all found by review on 2026-09-25.

## Setting a baseline from the visible data

A canonical `write` rebased the live layers by setting each baseline to the value it wrote (`sn.prev = next`). `next` was `updater(data)`, and `data` held the guesses.

The reproduction: a post reads `{ likes: 0, liked: false, title: 'a' }`. A mutation's `onMutate` adds a like with `setData`. A server push patches the title with `write(p => ({ ...p, title: 'b' }))`. The mutation fails, and the rollback restores the rebased baseline, which is `{ likes: 1, liked: true, title: 'b' }`. The failed like is now permanent.

A patch has to be applied to each baseline on its own. `Entry.setData(updater, { track: false })` re-runs the updater on every live baseline through `rebaseOnto` (`entry.ts:1041-1057`). A whole value, which is what `replace` writes, still becomes every baseline, because its updater ignores `prev`. The two are told apart by the `whole` flag the replace paths pass.

## A commit that the lower baselines never see

`finalize()` dropped the committed layer from the stack and did nothing else. Layers still live below it captured their baselines before it applied, so their baselines lacked the committed change.

The reproduction: toggles A and B run in parallel on one list. B succeeds and finalizes. A fails, is now the top layer, and restores its baseline, `{ a: false, b: false }`. B's committed change is lost.

`finalize` now re-runs the committed layer's updater on each baseline below it (`entry.ts:1009-1033`). The layers above need nothing, because their baselines were captured after it applied.

## A layer removed from the middle

A rollback of a layer that was not the top threaded its baseline onto the layer above and left everything else alone. The layers above it still held its delta in their baselines, and so did the data on screen.

The reproduction, found while wiring the plugins onto the fixes above: `{ a: false, b: false }`, layer A sets `a`, layer B sets `b`. A fails and rolls back, and the screen still reads `{ a: true, b: true }`. B succeeds, and its settle reports that value as `'commit'`, so the persister stores A's failed guess and cross-tab relays it.

A rollback below the top now replays the layers above it over the baseline it restored (`replayFrom`, `entry.ts:1072-1096`). The rules below apply to the replay as they do to a commit.

## Re-running an updater can apply it twice

A re-run is exact only when the baseline is known to lack the change. A fetch or a hydrated row that lands while a layer is live replaces every baseline with server truth, and that read may already hold the layer's change. Re-running a toggle or an increment there would apply it a second time. So a commit skips the fold when a server read landed after its layer was pushed: `record.epoch !== serverEpoch`.

A plain value, an updater with no parameters such as `() => data`, can hold the removed layer's change it captured from the screen, and a replay cannot take it out. The replay keeps the value and the entry reconciles. An updater can also throw on a baseline it was not written for, such as the `undefined` under a guess made before the first load. The engine then keeps that baseline, marks the entry stale and refetches once the last layer settles (`reconcileLater`, `entry.ts:1103-1106`). Either value it could restore would be known to be wrong.

## The same split outside the engine

A plugin meets the rule as well, since every write event's `data` is the data on screen. Three plugins broke it, found by the third 1.0 review:

- The query-cache persister stored `data`, so a `write` made under a guess stored the guess. It now stores the event's `server`, the data beneath the guesses (`../modules/persist.md`).
- Entities backpropagated a whole value built from its store, which shows the guess, so core set every baseline to it. It now writes a patch of each query's own copy, which core re-runs on each baseline (`../modules/entities.md`).
- Cross-tab applied a peer's guess as a canonical write in the receiving tab. It now shows it through `host.queries.setData`, as a layer the peer's rollback or commit settles (`../modules/cross-tab.md`).

## How to check a change here

The property models in `packages/core/tests/property/` drive whole-value and patch writes, commits and server reads in random order, and check every rollback against a model of these rules. Each rule was broken on purpose when the fix landed, and a model failed each time (`../decisions/engine-assurance.md`).
