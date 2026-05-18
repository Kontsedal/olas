# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Olas is a controller-tree library for browser apps. **SPEC.md is the authoritative design document** — any ambiguity in architecture, naming, semantics, or API shape resolves against SPEC.md, not against existing code. The current implementation covers spec phases 0–9 and 11–12 (everything except the React adapter, devtools extension, and final polish). Per-section pointers in SPEC.md (e.g. "§6.1", "§5.7") are the canonical citations.

## Commands

All commands run from the repo root and operate on all workspace packages.

```bash
pnpm install                                       # link workspace + install deps
pnpm typecheck                                     # tsc --noEmit per package
pnpm lint                                          # biome check .
pnpm exec biome check --write .                    # auto-fix lint + format
pnpm test                                          # vitest run (all packages)
pnpm test:watch                                    # vitest watch
pnpm build                                         # tsup per package → dist/{mjs,cjs,d.ts}

pnpm vitest run packages/core/tests/query.test.ts  # run one test file
pnpm vitest run -t "race protection"               # run by test-name substring
```

CI runs `install → typecheck → lint → test → build`; the same five steps reproduce the gate locally.

## Workspace layout

```
packages/
  core/      # @olas/core   — everything: signals, controllers, queries, mutations, forms, SSR
  react/     # @olas/react  — empty shell (Phase 10 not implemented)
  persist/   # @olas/persist — usePersisted + localStorage adapter
  zod/       # @olas/zod    — zodValidator, formFromZod
```

Tests import workspace packages via aliases declared in `vitest.config.ts` — those point straight at each package's `src/index.ts` (and `core/src/testing.ts`), so tests run without building `dist/`. The published `dist/` is what consumers see; the alias is dev-only.

`@olas/core` also publishes a `./testing` sub-path (`createTestController`). Keep test-only helpers there — its sub-path export makes "you imported testing utilities into production code" grep-able.

## Core architecture (the big picture)

### Controller tree

`defineController((ctx, props) => api)` produces a `ControllerDef`. A root is constructed with `createRoot(def, { deps, onError?, hydrate? })`, which returns `api & { dispose, suspend, resume, dehydrate, waitForIdle, __debug }` (the root controls are attached as non-enumerable properties on the api object). Internal `createRootWithProps(def, props, options)` powers both `createRoot` (props-less) and `createTestController` (props-allowing).

Each controller is a `ControllerInstance` carrying a flat `entries: LifecycleEntry[]` list — every primitive created via `ctx` (effects, fields, forms, caches, mutations, child controllers, emitters, on-subscriptions, lifecycle hooks) appends to that list. The list drives:
- **Dispose** — iterate reverse, dispatch by `entry.kind`. Children dispose first (recursive), then primitives, then `onDispose` hooks. Idempotent.
- **Suspend** — iterate reverse: dispose user effects (storing their factory), recurse into children, fire `onSuspend` hooks.
- **Resume** — iterate forward: re-instantiate effects from stored factories, recurse into children, fire `onResume` hooks.
- **Construction rollback** — if the factory throws, the partially-built entries dispose in reverse and the error rethrows. Sibling controllers that already finished construction stay alive (spec §12.1).

Three distinct `RootShared` references — `devtools`, `onError`, `queryClient` — propagate to every descendant via the instance constructor. Children inherit deps and may shadow via `ctx.child(def, props, { deps: override })` (the spread happens only when an override exists, preserving reference equality otherwise).

### Signals

`packages/core/src/signals/` is the only place that touches `@preact/signals-core`. Everything else uses the wrapper types (`Signal`, `ReadSignal`, `Computed`). If the underlying runtime ever swaps, only this module changes. The internal `readOnly(signal)` projection hides `set`/`update` at runtime — return that from public surfaces (e.g. cache subscriptions) so callers can't mutate.

`Signal<T>` extends `ReadSignal<T>` structurally — assignable downward, never upward. `Field<T>` is `ReadSignal<T> & { ...form metadata }`, which means **`field.value` returns `T` directly** (via the ReadSignal getter), while `form.value` and `fieldArray.value` are `ReadSignal<...>` — so reading them is `form.value.value`. Form/FieldArray traversal code (`form.ts`) must handle both shapes; the field-vs-form check uses `Symbol.for('olas.form')` / `Symbol.for('olas.fieldArray')` brand markers on the impl classes.

### Query system

One `QueryClient` per root. The client holds two maps:
- `maps: Map<AnyQuery, Map<hash, ClientEntry<T>>>` — regular queries.
- `infiniteMaps: Map<AnyInfiniteQuery, Map<hash, InfiniteClientEntry>>` — infinite queries.

Queries (`defineQuery`, `defineInfiniteQuery`) are module-scoped values branded `__olas: 'query' | 'infiniteQuery'`. Each query carries a `__clients: Set<QueryClient>` so `query.invalidate()` / `invalidateAll()` / `setData()` reach every root that has bound an entry. When a root disposes it removes itself from all touched queries' sets — that's how test isolation works.

`ClientEntry` distinguishes two argument arrays that look the same but aren't:
- `callArgs` — the original args passed by the consumer; forwarded to `spec.fetcher(...args, signal)`.
- `keyArgs` — `spec.key(...callArgs)` output, hashed via `stableHash` for entry identity.

Forgetting this gave the "fetcher gets ['user', 'u1'] instead of 'u1'" bug — keep them separate.

`Entry<T>` (in `query/entry.ts`) is the underlying state machine: race-protected via a monotonic `currentFetchId`, AbortSignal plumbing, retry loop (`runWithRetry`), snapshot stack for optimistic updates (positional rollback per §6.4), staleness timer that flips `isStale` after `staleTime` (a `Date.now()`-based computed wouldn't update as time passes — must be timer-driven).

`ctx.use(queryOrInfiniteQuery, keyOrOptions?)` dispatches on the `__olas` brand and routes to `createUse` or `createInfiniteUse`. Subscriptions hold a `current$: Signal<ClientEntry | null>` and derive all AsyncState signals as computeds, so swapping the entry on key change is a single signal write that ripples through `data`, `error`, `status`, etc. `keepPreviousData` requires a separate `previousData$` because the computed needs a fallback when the new entry's data is still undefined.

### Mutations

`MutationImpl` dispatches on `concurrency`:
- `parallel` — every `run()` is independent; `isPending` is true while any inflight.
- `latest-wins` — new `run()` aborts every inflight AND **rolls back their snapshots synchronously** before invoking the new `onMutate`. This is the order from §6.1; doing it after `onMutate` causes the stacked-snapshot bug where the new optimistic update gets clobbered.
- `serial` — queue, process one at a time.

Every `executeRun` wraps the mutate promise in `raceAbort(promise, signal)` — if the user's mutate ignores its signal, we still reject with AbortError when superseded. Without this, misbehaving fetchers cause memory leaks.

Superseded runs (`isAbortError(err)` or `signal.aborted`) do **not** populate `error`, do **not** invoke `onError`, do **not** invoke `onSettled` — those are reserved for genuine failures. The supersede path rolls the snapshot back and rethrows AbortError.

Mutations increment `queryClient.mutationsInflight$` on start and decrement on settle. `root.waitForIdle()` waits on it plus per-entry `isFetching` signals.

### SSR

`root.dehydrate()` walks the QueryClient's `maps` and emits `{ key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'` only. Infinite queries and error/idle entries are intentionally skipped.

`createRoot(def, { hydrate: state })` populates a `hydratedData: Map<hash, { data, lastUpdatedAt }>` inside the QueryClient. The first `bindEntry` for a matching key consumes the hydrated row and threads `initialData` + `initialUpdatedAt` into the new `Entry`. Each hydrated row is consumed once — subsequent rebinds re-fetch normally.

### Forms

`ctx.form(schema, options?)` and `ctx.fieldArray(itemFactory, options?)` produce aggregates. Aggregate signals (`value`, `errors`, `isValid`, `isDirty`, `touched`, `isValidating`) are computeds that traverse `this.fields` (or `this.items$.value`), branching on brand markers to read the right surface per child type.

Form-level and array-level validators run in an `effect` that tracks `this.value.value` and applies the same sync-short-circuit / async-await pattern as `FieldImpl`. They populate `topLevelErrors` (separate from per-field `errors`); `flatErrors` walks the entire tree and emits `[{ path, errors }]` entries — empty path means the form-level slot.

`FieldArray.add(initial?)` passes `initial` to the user's `itemFactory`. The factory **must** use it — there's no auto-set. For Form items, the canonical pattern is `(initial) => ctx.form(schema, { initial })`.

## Working with the codebase

- **When the spec and the code disagree, the spec wins** unless a test pins the current behavior intentionally. Either fix the code or, if the spec needs updating, raise it explicitly.
- **Phase ordering matters.** SPEC.md §22 lists the dependency DAG. Phase 10 (scopes + React adapter), 13 (devtools extension), and 14 (polish/docs) are the unimplemented pieces; lots of types and structure (e.g. `Ctx`, `RootShared`) already anticipate them, so don't tear down what looks vestigial without checking.
- **Type inference quirks.** `ctx.field('')` infers `Field<''>` because of string literal narrowing. In tests that don't want that, annotate: `ctx.field<string>('')`. Same trap for `ctx.field(0)` → `Field<0>`.
- **biome v1.9.4 config** is in `biome.json`. Two rules are explicitly relaxed: `noExplicitAny` (the wrapper types need it) and `noConfusingVoidType` (matches the spec's effect signature `() => void | (() => void)`). Don't reinstate them.
- **Don't commit dist/.** `tsup` cleans on every build and `.gitignore` excludes it. The `pnpm-lock.yaml` IS committed.
- **`@preact/signals-core` is a peer dep on @olas/core**, declared both in `peerDependencies` and `devDependencies` so the workspace dev environment resolves it. Consumers must install it themselves; the library does not bundle it.
