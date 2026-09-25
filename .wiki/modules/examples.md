---
name: examples
description: Five runnable example apps demonstrating Olas's API breadth, in React, Vue and vanilla TS. The kanban example is the flagship and exercises essentially every public primitive across every package.
type: module
covers:
  - examples/kanban
  - examples/stock-ticker
  - examples/reader-ssr
  - examples/virtualized-table
  - examples/vue-tasks
  - examples/_shared/aliases.ts
  - biome.json
edges:
  - { type: documented-in, target: ../../README.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: uses, target: ../modules/query.md }
  - { type: uses, target: ../modules/forms.md }
  - { type: uses, target: ../modules/devtools-panel.md }
  - { type: uses, target: ../modules/entities.md }
  - { type: uses, target: ../modules/realtime.md }
  - { type: uses, target: ../modules/cross-tab.md }
  - { type: uses, target: ../modules/persist.md }
  - { type: uses, target: ../flows/ssr.md }
  - { type: uses, target: ../flows/mutation-concurrency.md }
last_verified: 2026-09-25
confidence: high
---

# Examples

`examples/` contains five runnable apps. The **kanban** app is the flagship —
it exercises nearly every public primitive across every package. The
remaining four are focused single-purpose demos that cover SSR, vanilla TS,
virtualization and the Vue adapter in isolation.

## Inventory

| Path | UI | Demonstrates |
|------|----|--------------|
| `examples/kanban/` | **React (flagship)** | Multi-board project tracker. All three mutation concurrency modes (parallel move / latest-wins search / serial reorder), optimistic snapshot + auto-rollback, `createZodForm` + `FieldArray` + `debouncedValidator`, `defineScope` × 5, `ctx.emitter` + `ctx.on`, `selection<string>()`, **`entitiesPlugin`** (User + Label), **`crossTabPlugin`**, **`createRealtimePatcher`** + **`createLiveStream`** over BroadcastChannel, **`createPersisted`** × N (theme/density/sidebar/last-board), **`defineInfiniteQuery`** (archive), **`SuspendOnUnmount`** + **`useSuspendOnHidden`**, **`debounced`** + **`throttled`** + standalone **`effect()`**, root **`onError`** (`ErrorContext`) → toast bridge, `<DevtoolsLauncher>`. Feature-folder code structure; design system in `src/ui/` over the shared scales in `examples/_shared/ui/tokens.css`. |
| `examples/stock-ticker/` | **None — vanilla TS** | `signal` / `computed` / `effect`, `ctx.emitter` + `ctx.on`, `debounced` / `throttled`, `defineQuery` + `refetchInterval`, `createPersisted` watchlist + alerts, SVG sparklines, alert evaluation via emitter. |
| `examples/reader-ssr/` | React + SSR | `waitForIdle → dehydrate → hydrate` round-trip, paginated `defineQuery` with reactive key, `useSuspendOnHidden`, persisted bookmarks + reading progress + theme (`createPersisted` × 3) behind a `useHydrated` gate, `ctx.attach` for the per-article composer, `ctx.emitter` analytics, `onError` root option + `ErrorContext`. |
| `examples/virtualized-table/` | React | 50k rows as a `Map<id, Signal<Issue>>` under one controller (spec §11.1), so a row write re-renders one row. A `parallel` per-row mutation whose `onMutate` snapshot rolls the row back on failure, `createSelection` ranges and a bulk apply that runs one mutation per row, a title filter, and a row flash on update. `tests/controller.test.ts` drives `tableController` in Node. |
| `examples/vue-tasks/` | **Vue 3** | A task list whose state is one controller: `defineQuery` through `deps.api`, an optimistic toggle (`cancel` → `setData` → returned snapshot, rolled back on failure), a canonical `write` for the added task, `createForm` + `required` / `maxLength` bound with `v-model` through `useField`, and a `Register`-typed `useRoot()`. SFCs with scoped styles on the shared tokens. `typecheck` is `vue-tsc --noEmit`, not `tsc`. |

## Shared scaffolding

Each example's `vite.config.ts` and `vitest.config.ts` imports from
[`examples/_shared/aliases.ts`](../../examples/_shared/aliases.ts), which maps
`@kontsedal/olas-*` package names (including `@kontsedal/olas-entities`) to
source paths. Without this, examples would require running `pnpm build` first
to populate `packages/*/dist/`. Vite resolves the aliases at module-graph
build time, so dev, test and SSR all see source. The configs import
`../_shared/aliases.ts` with its extension, because Vite 8.3 warns about an
extensionless relative import that its future native config loader cannot load
(`../decisions/toolchain.md`).

Every example uses the same scripts:

```jsonc
"scripts": {
  "dev":       "vite",
  "build":     "vite build",
  "preview":   "vite preview",
  "typecheck": "tsc --noEmit",
  "test":      "vitest run"
}
```

## Workspace integration

- `pnpm-workspace.yaml` already globs `examples/*`, so new apps are auto-discovered.
- Root `package.json` runs `typecheck` across `examples/*`.
- Root `vitest.config.ts` only scans `packages/*/tests/`, so each example
  runs its own `pnpm --filter @kontsedal/olas-example-X test`. CI runs all
  five with `pnpm --filter "./examples/*" test`.
- Every example has a `tests/` suite and a `vitest.config.ts`. None passes
  `--passWithNoTests`, so an example that loses its tests fails CI. The
  virtualized-table suite was the last to land (2026-09-25); the root README's
  "every example ships a `tests/` suite" rests on it.

## Lint: three React rules on for the examples only

`biome.json` turns `noArrayIndexKey`, `useExhaustiveDependencies` and
`useHookAtTopLevel` on as errors for `examples/**`, through an override. They
stay off for `packages/**`. The examples are the code people copy, and the 0.9
review found a hook-order bug and an index key on a deletable list there, both
of which these rules catch.

- The later override for `**/*.vue` and `**/*.svelte` turns `useHookAtTopLevel` off
  again. Biome parses `<script setup>` as module scope, so every composable
  call at its top reads as a hook outside a component. That top level IS the
  setup function, so all twelve findings in `vue-tasks` were false positives.
- One suppression: the kanban board skeleton keys four fixed placeholders by
  index (`examples/kanban/src/features/board/Board.tsx:139-141`). The list is a
  constant `Array.from({ length: 4 })`, so the position is the identity.
- Enabling the three repo-wide would flag 25 diagnostics in `packages/` (counted
  2026-09-25). `useExhaustiveDependencies` has 21 of them, at six hook sites.
  Each site is a deliberate trigger dependency: the devtools panel keys effects
  on `paused` and on `focus?.nonce`, and one memo mints a revision token. The
  devtools `Omnibox` memo takes a `rev` token, and `packages/react/src/context.ts`
  lists `root` so a new root re-installs the streaming intake. `useHookAtTopLevel`
  has 3, all Vue composables inside a `defineComponent` `setup()` in
  `packages/vue/tests`. `noArrayIndexKey` has 1, the devtools `JsonView` array
  rows, where the index is the element's path.

## Kanban flagship — code shape

Feature folders, each a vertical slice:

```
examples/kanban/src/
├── main.tsx                     # mount + dispose hook
├── root.ts                      # createRoot + plugins + onError bridge
├── app.controller.ts            # top-level orchestrator
├── App.tsx                      # 3-pane shell
├── styles.css                   # imports tokens + features
├── scopes.ts                    # every scope in one place
├── api/                         # fake API, BroadcastChannel realtime, Zod + AmbientDeps
├── entities/                    # defineEntity<User>, <Label>
├── features/                    # boards, board, card-detail, search, filters,
│                                # comments, activity, notifications, archive, preferences
└── ui/                          # tokens.css, motion.css, primitives.css + 14 React primitives
```

The kanban app's "feature → primitive" map lives in `examples/kanban/README.md`.

## How the cross-tab + realtime demo wires together

`@kontsedal/olas-realtime` expects a consumer-supplied `RealtimeService`. The
kanban demo provides one backed by `BroadcastChannel`. Two browser windows
share the channel; one acts as the remote actor:

1. Window A moves a card → optimistic snapshot patches A's cache, mutation
   resolves against A's in-memory fake API.
2. `crossTabPlugin` replays the cache write on window B over the cache
   channel (`olas-kanban-cache`) → B's UI updates without a refetch.
3. Window A's board controller `publish`es a `card.moved` event over the
   realtime channel (`olas-kanban-realtime`).
4. Window B's `createRealtimePatcher` sees `event.by !== tabId` and emits a
   "Another tab moved a card" entry into the activity scope.

Two channels intentionally — mirrors the typical "cache transport ≠ realtime
fan-out" separation in real deployments.

## Findings surfaced by building the flagship

These came out while building the kanban app. Filed as BACKLOG items where
they imply a library change.

1. **Optimistic rollback on an ordinary error.** Resolved: a failed run rolls
   its snapshot back after the user's `onError(err, vars, snapshot)` returns
   (`packages/core/src/query/mutation.ts:675-679`). The snapshot is
   single-consume, so an `onError` that already rolled back makes the
   automatic call a no-op. The kanban column-reorder `onError` rolls back
   explicitly on purpose, to show both styles
   (`examples/kanban/src/features/board/board.controller.ts:331-334`).
2. **Infinite queries in `root.dehydrate()`.** Resolved in 1.0 (W10): an
   infinite entry dehydrates with its pages in `data` and its `pageParams`
   (`packages/core/src/query/client.ts:1436-1448`). The kanban archive drawer
   keeps cursor-paged history per tab and does not use SSR.
3. **Array-level `.min(N)` rules in a `createZodForm` schema.** Resolved in
   1.0: an array rule lands in that `FieldArray`'s `topLevelErrors`, and a root
   `.refine(fn, { path })` lands on the field its path names. See
   `modules/zod.md`. The kanban card schema has rules on its leaves alone, so
   it gets no whole-schema validator.
4. **`createZodForm` accepts extra leaf validators** via
   `createZodForm(ctx, schema, { extraValidators: { 'title': uniqueAsync } })`
   — keyed by dotted path. Resolved against the kanban "title-is-unique"
   need.
5. **`ctx.attach` returns `{ api, dispose, suspend, resume }`** — the
   `suspend and resume` pair cascades through the attached sub-tree's
   lifecycle entries, so `<SuspendOnUnmount controller={...}>` consumes it
   directly. Resolved. The kanban card-detail controller is still a
   `ctx.child` with a hand-rolled `suspend`/`resume` that only flips
   `isPaused`. Its effects keep running while it reads as suspended.

## Card-detail panel: the suspend state on screen

`CardDetail.tsx` keeps the panel head mounted while a card is open and puts the
details in a `<SuspendOnUnmount controller={app.cardDetail}>`. The head's
collapse button unmounts the details, which calls `suspend()`, and the state
tag beside the card id turns from Live (`--color-success`) to Suspended
(neutral). Expanding calls `resume()`. The form's draft survives the round
trip, because the controller is not disposed. Closing the card unmounts the
wrapper too, so `isPaused` is true whenever no panel shows.

Before 2026-09-25 the wrapper sat around the whole panel. The panel only
rendered while resumed, so nothing could show the Suspended state and
no code read `isPaused`. `examples/kanban/tests/card-detail.test.tsx` renders
the panel and checks the tag and the signal together.

## Running them

```bash
pnpm install

pnpm --filter @kontsedal/olas-example-kanban dev          # http://localhost:5181  (flagship)
pnpm --filter @kontsedal/olas-example-stock-ticker dev    # http://localhost:5180
pnpm --filter @kontsedal/olas-example-reader-ssr dev      # http://localhost:5182 (SPA)
pnpm --filter @kontsedal/olas-example-reader-ssr preview  # http://localhost:5183 (SSR)

pnpm --filter "./examples/*" test                        # all five suites
pnpm --filter @kontsedal/olas-example-kanban test         # or one of them
```

The kanban suite has 12 tests in 7 files (mutation rollback, serial ordering,
latest-wins, preferences round-trip, cross-tab convergence, entity
propagation, tracing, subtask keys, the card-detail suspend state), all in
`examples/kanban/tests/`. The virtualized-table suite has 13 controller tests
and no DOM.
