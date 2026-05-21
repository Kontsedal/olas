---
name: examples
description: Four runnable example apps demonstrating Olas's API breadth. The kanban example is the flagship and exercises essentially every public primitive across every package.
type: module
covers:
  - examples/kanban
  - examples/stock-ticker
  - examples/reader-ssr
  - examples/virtualized-table
  - examples/_shared/aliases.ts
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
last_verified: 2026-05-20
confidence: high
---

# Examples

`examples/` contains four runnable apps. The **kanban** app is the flagship —
it exercises essentially every public primitive across every package. The
remaining three are focused single-purpose demos that cover SSR, vanilla TS,
and virtualization in isolation.

## Inventory

| Path | UI | Demonstrates |
|------|----|--------------|
| `examples/kanban/` | **React (flagship)** | Multi-board project tracker. All three mutation concurrency modes (parallel move / latest-wins search / serial reorder), optimistic snapshot + auto-rollback, `formFromZod` + `FieldArray` + `debouncedValidator`, `defineScope` × 5, `ctx.emitter` + `ctx.on`, `selection<string>()`, **`entitiesPlugin`** (User + Label), **`crossTabPlugin`**, **`useRealtimePatcher`** + **`useLiveStream`** over BroadcastChannel, **`usePersisted`** × N (theme/density/sidebar/last-board), **`defineInfiniteQuery`** (archive), **`KeepAlive`** + **`useSuspendOnHidden`**, **`debounced`** + **`throttled`** + standalone **`effect()`**, root **`onError`** (`ErrorContext`) → toast bridge, `<DevtoolsLauncher>`. Feature-folder code structure; kanban-local design system in `src/ui/`. |
| `examples/stock-ticker/` | **None — vanilla TS** | `signal` / `computed` / `effect`, `ctx.emitter` + `ctx.on`, `debounced` / `throttled`, `defineQuery` + `refetchInterval`, `usePersisted` watchlist + alerts, SVG sparklines, alert evaluation via emitter. |
| `examples/reader-ssr/` | React + SSR | `waitForIdle → dehydrate → hydrate` round-trip, paginated `defineQuery` with reactive key, `useSuspendOnHidden`, persisted bookmarks + reading progress + theme (`usePersisted` × 3), `ctx.emitter` analytics, `onError` root option + `ErrorContext`. |
| `examples/virtualized-table/` | React | Virtualized list with row flash on update. |

## Shared scaffolding

Each example's `vite.config.ts` and `vitest.config.ts` imports from
[`examples/_shared/aliases.ts`](../../examples/_shared/aliases.ts), which maps
`@kontsedal/olas-*` package names (including `@kontsedal/olas-entities`) to
source paths. Without this, examples would require running `pnpm build` first
to populate `packages/*/dist/`. Vite resolves the aliases at module-graph
build time, so dev / test / SSR all see source.

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
  runs its own `pnpm --filter @kontsedal/olas-example-X test`.

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
4. Window B's `useRealtimePatcher` sees `event.by !== tabId` and emits a
   "Another tab moved a card" entry into the activity scope.

Two channels intentionally — mirrors the typical "cache transport ≠ realtime
fan-out" separation in real deployments.

## Findings surfaced by building the flagship

These came out while building the kanban app. Filed as BACKLOG items where
they imply a library change.

1. **Optimistic mutation rollback is NOT automatic on regular errors.** Olas
   auto-rolls back when a run is *aborted* (latest-wins supersede, dispose),
   but for ordinary errors the user calls `snapshot.rollback()` inside
   `onError(err, vars, snapshot)`. See `packages/core/src/query/mutation.ts:196-208`.
2. **`root.dehydrate()` does NOT serialize `defineInfiniteQuery` entries.**
   Only entries from regular `defineQuery` caches are written.
   See `packages/core/src/query/client.ts:246-260`. The kanban archive
   drawer keeps cursor-paged history per-tab; SSR is out of scope for it.
3. **`formFromZod` does NOT promote array-level `.min(N)` rules** from the
   outer Zod schema to a `FieldArray`-level validator. Leaf fields and nested
   object schemas walk correctly.
4. **`formFromZod` doesn't accept extra leaf validators.** Kanban's
   "title-is-unique" async check is hand-wired via an effect that runs the
   `debouncedValidator` and writes to a separate signal. Filed BACKLOG.
5. **`ctx.attach` returns `{ api, dispose }` only — no `suspend / resume`.**
   `<KeepAlive>` expects `{ suspend, resume }`. Children that need it expose
   their own (an `isPaused` signal toggle inside the controller). Filed
   BACKLOG.

## Running them

```bash
pnpm install

pnpm --filter @kontsedal/olas-example-kanban dev          # http://localhost:5181  (flagship)
pnpm --filter @kontsedal/olas-example-stock-ticker dev    # http://localhost:5180
pnpm --filter @kontsedal/olas-example-reader-ssr dev      # http://localhost:5182 (SPA)
pnpm --filter @kontsedal/olas-example-reader-ssr preview  # http://localhost:5183 (SSR)

pnpm --filter @kontsedal/olas-example-kanban test
pnpm --filter @kontsedal/olas-example-stock-ticker test
pnpm --filter @kontsedal/olas-example-reader-ssr test
```

The kanban example ships seven controller-level tests (mutation rollback,
serial ordering, latest-wins, preferences round-trip, cross-tab convergence,
entity propagation) — see `examples/kanban/tests/`.
