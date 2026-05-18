---
name: examples
description: Four runnable example apps demonstrating Olas's API breadth (vanilla + React + SSR) and testability via `@olas/core/testing`.
type: module
covers:
  - examples/user-profile
  - examples/stock-ticker
  - examples/kanban
  - examples/reader-ssr
  - examples/_shared/aliases.ts
edges:
  - { type: documented-in, target: ../../README.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: uses, target: ../modules/query.md }
  - { type: uses, target: ../modules/forms.md }
  - { type: uses, target: ../modules/devtools-panel.md }
  - { type: uses, target: ../flows/ssr.md }
  - { type: uses, target: ../flows/mutation-concurrency.md }
last_verified: 2026-05-18
confidence: high
---

# Examples

`examples/` contains four runnable apps. The first was the original walk-through
(`user-profile`); the remaining three were added to **spread API coverage** and
make the testability claim concrete — every controller-level surface is covered
by a test using `createTestController` / `fakeField` / `fakeAsyncState` from
`@olas/core/testing`.

The intent is not novelty per-app; it's that a reader of any one app sees a
coherent program, and a reader of all four sees the whole library.

## Inventory

| Path | UI | Demonstrates |
|------|----|--------------|
| `examples/user-profile/` | React | Single query + mutation + `formFromZod` + optimistic rollback. Typecheck-only, no tests. |
| `examples/stock-ticker/` | **None — vanilla TS** | `signal` / `computed` / `effect`, `ctx.emitter` + `ctx.on`, `debounced` / `throttled`, `defineQuery` + `refetchInterval`, `usePersisted` watchlist + alerts, SVG sparklines, alert evaluation via emitter. **10 controller tests.** |
| `examples/kanban/` | React + Devtools | All three mutation concurrency modes (`parallel` / `latest-wins` / `serial`), optimistic snapshot + `snapshot.rollback()` in `onError`, `formFromZod` + `FieldArray` for card subtasks (with priority + due dates), `defineScope` + `provide` / `inject` (board + emitter), `AmbientDeps` augmentation, error toast with mutation `.lastVariables` retry, activity feed via emitter, `<DevtoolsPanel>` mounted. **9 tests.** |
| `examples/reader-ssr/` | React + SSR | `waitForIdle → dehydrate → hydrate` round-trip, paginated `defineQuery` with reactive key, `useSuspendOnHidden`, persisted bookmarks + reading progress + theme (`usePersisted` × 3), `ctx.emitter` analytics, `onError` root option + `ErrorContext`. **8 tests** including the SSR cache-hit contract. |

## Shared scaffolding

Each example's `vite.config.ts` and `vitest.config.ts` imports from
[`examples/_shared/aliases.ts`](../../examples/_shared/aliases.ts), which maps
`@olas/*` package names to source paths. Without this, examples would require
running `pnpm build` first to populate `packages/*/dist/`. Vite resolves the
aliases at module-graph build time, so dev / test / SSR all see source.

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

The SSR example overrides `build` to run both `vite build --outDir dist/client`
and `vite build --ssr src/entry-server.tsx --outDir dist/server`, and adds
`serve` (a tiny Express wrapper) and `preview` (build + serve).

## Workspace integration

- `pnpm-workspace.yaml` already globs `examples/*`, so new apps are auto-discovered.
- Root `package.json:13` runs `typecheck` across `examples/*`.
- Root `vitest.config.ts:16` only scans `packages/*/tests/`, so each example
  runs its own `pnpm --filter @olas/example-X test`.

## Findings surfaced by writing the examples

These came out of building the apps. Each is filed but the consolidated list
lives here as a reading aid:

1. **Optimistic mutation rollback is NOT automatic on regular errors.** Olas
   auto-rolls back when a run is *aborted* (latest-wins supersede, dispose),
   but for ordinary errors the user calls `snapshot.rollback()` inside
   `onError(err, vars, snapshot)`. See
   `packages/core/src/query/mutation.ts:196-208`. The `kanban` example
   demonstrates the correct shape; the existing `user-profile` README slightly
   overstates the auto-rollback behavior (a doc bug, not an impl bug).
2. **`root.dehydrate()` does NOT serialize `defineInfiniteQuery` entries.**
   Only entries from regular `defineQuery` caches are written.
   See `packages/core/src/query/client.ts:246-260`. The `reader-ssr` example
   uses a regular query keyed by cursor + a reactive key thunk to get
   SSR-friendly pagination. A future improvement to `dehydrate`/`hydrate`
   could add infinite-query support; until then, the cursor-keyed pattern
   is the recommended SSR shape.
3. **`formFromZod` does NOT promote array-level `.min(N)` rules** from the
   outer Zod schema to a `FieldArray`-level validator. Leaf fields and nested
   object schemas walk correctly. See `packages/zod/src/index.ts:131-137` —
   `ctx.fieldArray(...)` is created without `validators`. The `kanban` test
   adjusts by asserting `form.isValid === false` (driven by other rules)
   rather than asserting the specific array-level error.
4. **In the React adapter, `getByLabelText` will match BOTH the wrapping
   `<label>` AND an `aria-label` on the input** — they're distinct lookup
   mechanisms that both succeed. Use only one. The `kanban` component test
   originally had both, surfacing this.

## Running them

```bash
pnpm install

pnpm --filter @olas/example-stock-ticker dev    # http://localhost:5180
pnpm --filter @olas/example-kanban dev          # http://localhost:5181
pnpm --filter @olas/example-reader-ssr dev      # http://localhost:5182 (SPA)
pnpm --filter @olas/example-reader-ssr preview  # http://localhost:5183 (SSR)

pnpm --filter @olas/example-stock-ticker test
pnpm --filter @olas/example-kanban test
pnpm --filter @olas/example-reader-ssr test
```

All tests pass and all builds produce a green `dist/`.
