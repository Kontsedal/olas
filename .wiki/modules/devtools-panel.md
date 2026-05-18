---
name: devtools-panel
description: "@olas/devtools — in-app DevtoolsPanel subscribed to root.__debug. Renders tree, cache, mutations, fields tabs."
type: module
covers:
  - packages/devtools/src/index.ts
  - packages/devtools/src/DevtoolsPanel.tsx
  - packages/devtools/src/store.ts
  - packages/devtools/src/format.ts
  - packages/devtools/src/styles.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/devtools/tests/store.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/panel.test.tsx }
  - { type: uses, target: devtools.md }
  - { type: uses, target: react.md }
last_verified: 2026-05-18
confidence: high
---

# `@olas/devtools`

Drop-in React panel that subscribes to a root's `__debug` bus and renders four live views: controller Tree, Cache, Mutations, Fields. Phase 13 in-app variant; spec §13.

## Public surface

```ts
function DevtoolsPanel(props: {
  root: Pick<Root<unknown>, '__debug'>
  defaultTab?: 'tree' | 'cache' | 'mutations' | 'fields'
  maxEntries?: number
}): JSX.Element

class DevtoolsStore {
  tree$: Signal<ControllerNode>
  cache$: Signal<CacheEntry[]>
  mutations$: Signal<MutationEntry[]>
  fields$: Signal<FieldEntry[]>

  attach(root): () => void
  handle(event: DebugEvent): void
  clearLogs(): void
}

function insertNode(root, path, props): ControllerNode
function setNodeState(root, path, state): ControllerNode
function formatPath(path): string
function formatPayload(value, maxLen?): string
function formatTime(t: number): string
```

## Architecture

The package splits into three pieces:

1. **`store.ts`** — pure logic. A `DevtoolsStore` exposes four `Signal`s (one per view). `handle(event)` is the dispatcher; it routes a `DebugEvent` to either `tree$.set(insertNode(...))` / `tree$.set(setNodeState(...))` or one of the bounded-log pushers. Tested in isolation; no React.
2. **`DevtoolsPanel.tsx`** — React component. `useMemo(() => new DevtoolsStore(...), [maxEntries])`, then `useEffect(() => store.attach(root), [root, store])`. Tabs are local React state. Each view reads its signal via `@olas/react`'s `use()` and renders.
3. **`format.ts` / `styles.ts`** — tiny helpers. `styles.ts` is a hard-coded CSS string injected via `<style>` inside the panel — no build-time CSS extraction needed.

## Why the tree has a virtual empty root

`DevtoolsStore.tree$` starts as `{ path: [], state: 'active', children: [] }`. The first `controller:constructed` event has path `['root']`, which becomes a child of the virtual node. This keeps `insertNode` purely recursive — no special case for "the first node is the root". The panel renders `tree.children`, treating the wrapper as invisible.

## Bounded logs

`cache$` / `mutations$` / `fields$` are capped at `maxEntries` (default 100). When full, the oldest entry drops (via `appendBounded` — `slice` + `push`). Each entry has an auto-incrementing `id` for React `key`s and a `t` (ms epoch) for display.

`tree$` is NOT a log — it's the live state of the controller tree. `clearLogs()` empties the three log signals but preserves the tree.

## Post-mount observability

Spec §13 phrasing: "Without devtools, large signal graphs become opaque." This panel subscribes via `useEffect` on mount, so the *initial* `controller:constructed` for the root happens before subscription — the tree starts empty even though the root exists. Mount the panel as early as possible in the React tree to maximize what's captured.

For full history, build a `DevtoolsStore` next to `createRoot` (before any controller exists) and pass it to a custom UI later. The store and the panel are decoupled — the panel uses one internally; consumers can use the store on its own.

## DistributiveOmit

`store.ts` defines a small `DistributiveOmit<T, K>` helper because the default `Omit<UnionType, K>` collapses to the intersection of common keys — losing per-variant fields. Used in the `pushCache` / `pushMutation` parameter types so a call site can supply just one variant's payload.

## The four tabs

| Tab | Reads | Renders |
|-----|-------|---------|
| **Tree** | `store.tree$` | Recursive `<TreeNode>`; struck-through for `disposed`, orange for `suspended`. |
| **Cache** | `store.cache$` | `<ul>` of fixed-grid rows: time · kind · `formatPath(queryKey) + details`. Red for `fetch-error`. |
| **Mutations** | `store.mutations$` | Same shape: time · kind · `formatPath(path) + payload`. Red for `error`, orange for `rollback`. |
| **Fields** | `store.fields$` | Time · `valid`/`invalid` · path · field · errors. |

## What's tested

- `store.test.ts` (13 tests) — `insertNode` / `setNodeState` semantics, bounded logs, all 14 `DebugEvent` variants flowing through `handle()`, `attach()` returning unsubscribe.
- `panel.test.tsx` (6 tests) — RTL coverage: post-mount dynamic children appear in tree, cache events render after a refetch, Clear button empties the cache log, tabs switch views, suspend/resume reflected in the tree, `defaultTab` prop honored.
- Indirectly: `core/tests/devtools-events.test.ts` (8 tests) pins the runtime-emit contract.

## What's NOT included

- Signal dependency graph view (spec §13 mentions it). Would require additional plumbing inside `@olas/core/signals` to expose dependencies.
- Subscription view (spec §13 mentions). Would need `cache:subscribed` wiring + per-entry subscriber lists in the store.
- Time-travel / replay. Probably never — events are unidirectional.