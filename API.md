# API Reference

Every public export across the Olas packages. One canonical entry per export, with signature, what-it-does, a minimal example, and the trade-offs. This is the catalog — for the friendly tour see [`README.md`](README.md), for design rationale see [`SPEC.md`](SPEC.md), for known footguns see [`.wiki/pitfalls/`](.wiki/pitfalls).

If a behavior isn't covered here and you can't find it in SPEC.md, that's a docs bug — please file it.

## Conventions used in this file

- **Signature** — copy-paste-able TypeScript signature. Generics are spelled out, optional params are marked `?`.
- **What it does** — one paragraph in plain English.
- **Example** — minimal idiomatic snippet, typechecked.
- **When to use / When not** — guidance, not rules. Used when the API has a near-neighbor it gets confused with.
- **See also** — links to spec sections, wiki pitfalls, related APIs.

`ReadSignal<T>` means a read-only signal; `Signal<T>` is read-write. Anything starting with `ctx.` is on the controller's `Ctx` object — lifetime-bound to that controller.

---

## Table of contents

- [@kontsedal/olas-core](#olascore)
  - [Signals](#signals)
  - [Time-based signals](#time-based-signals)
  - [Controllers & roots](#controllers--roots)
  - [The `Ctx` object](#the-ctx-object)
  - [Async data — queries](#async-data--queries)
  - [Async data — infinite queries](#async-data--infinite-queries)
  - [Async data — local cache](#async-data--local-cache)
  - [Mutations](#mutations)
  - [Forms — `Field`](#forms--field)
  - [Forms — `Form`](#forms--form)
  - [Forms — `FieldArray`](#forms--fieldarray)
  - [Forms — stdlib validators](#forms--stdlib-validators)
  - [Scopes](#scopes)
  - [Emitters](#emitters)
  - [SSR — `dehydrate` / `hydrate`](#ssr--dehydrate--hydrate)
  - [Errors](#errors)
  - [Devtools event bus](#devtools-event-bus)
  - [Utilities](#utilities)
- [@kontsedal/olas-core/testing](#olascoretesting)
- [@kontsedal/olas-react](#olasreact)
- [@kontsedal/olas-persist](#olaspersist)
- [@kontsedal/olas-zod](#olaszod)
- [@kontsedal/olas-devtools](#olasdevtools)

---

# @kontsedal/olas-core

## Signals

The reactive substrate. A signal is a typed cell with a value; reads inside `computed` or `effect` are auto-tracked, writes notify subscribers. Wraps `@preact/signals-core`.

### `signal<T>(initial: T): Signal<T>`

Read-write signal. `.value` reads, `.set(v)` writes, `.update(fn)` writes via a function of the current value. `.peek()` reads without registering a dependency. `.subscribe(fn)` registers a listener; returns an unsubscribe.

```ts
import { signal } from '@kontsedal/olas-core'

const count = signal(0)
console.log(count.value)         // 0
count.set(5)
count.update((n) => n + 1)       // 6
count.peek()                     // 6, no tracking
const unsub = count.subscribe((v) => console.log(v))
```

**See also:** SPEC §1, §20.1. [`.wiki/pitfalls/preact-signals-overload-return.md`](.wiki/pitfalls/preact-signals-overload-return.md) — type quirk if you import directly from `@preact/signals-core`.

### `computed<T>(fn: () => T): Computed<T>`

Derived read-only signal. Tracks every signal read inside `fn` and recomputes when any of them change. Glitch-free (a computed never reads a half-updated graph).

```ts
import { signal, computed } from '@kontsedal/olas-core'

const first = signal('Ada')
const last = signal('Lovelace')
const full = computed(() => `${first.value} ${last.value}`)
console.log(full.value)          // "Ada Lovelace"
```

**When not to use:** for *side effects* (writes, fetches, DOM). Use `effect` for those.

### `effect(fn: () => void | (() => void)): () => void`

Tracking side effect. Re-runs whenever its read signals change. `fn` may return a cleanup function that runs before the next invocation (and on disposal). The outer return value is an unsubscribe.

```ts
import { signal, effect } from '@kontsedal/olas-core'

const count = signal(0)
const stop = effect(() => {
  document.title = `Count: ${count.value}`
  return () => console.log('cleanup before next run')
})
count.set(1)                     // logs cleanup, retitles
stop()                           // tear down
```

**When to use this vs `ctx.effect(...)`:** if you're inside a controller, use `ctx.effect(...)` — it ties the effect's lifetime to the controller's. Top-level `effect(...)` is for non-controller code (or libraries).

### `batch(fn: () => void): void`

Group multiple writes so subscribers fire once. Inside `batch`, signal writes don't propagate until `fn` returns.

```ts
import { batch, signal } from '@kontsedal/olas-core'

const a = signal(1)
const b = signal(2)
batch(() => {
  a.set(10)
  b.set(20)
})                               // subscribers see (10, 20), not (10, 2) then (10, 20)
```

### `untracked<T>(fn: () => T): T`

Run `fn` without registering its signal reads as dependencies. Useful inside a `computed` / `effect` to "peek" at a value without re-running on its changes.

```ts
import { signal, computed, untracked } from '@kontsedal/olas-core'

const tracked = signal(1)
const peeked = signal(100)
const sum = computed(() => tracked.value + untracked(() => peeked.value))
// sum re-computes when `tracked` changes; not when `peeked` changes.
```

### Types: `Signal<T>`, `ReadSignal<T>`, `Computed<T>`

```ts
type ReadSignal<T> = {
  readonly value: T
  peek(): T
  subscribe(handler: (v: T) => void): () => void
}

type Signal<T> = ReadSignal<T> & {
  set(v: T): void
  update(fn: (prev: T) => T): void
}

type Computed<T> = ReadSignal<T>
```

`Signal<T>` is read-write; `ReadSignal<T>` is read-only. Functions that should accept both reads and writes use `Signal<T>`; functions that just observe use `ReadSignal<T>`. `Computed<T>` is a `ReadSignal<T>`.

---

## Time-based signals

Derived signals that delay or rate-limit a source.

### `debounced<T>(source: ReadSignal<T>, ms: number): ReadSignal<T>`

Reflects `source`, but waits `ms` after the last source change before emitting. Same value during the window; new value after. Great for "react after the user stops typing".

```ts
import { signal, debounced } from '@kontsedal/olas-core'

const term = signal('')
const dTerm = debounced(term, 300)
// dTerm.value lags term.value by up to 300ms after the last write.
```

**See also:** `debouncedValidator(...)` for async validators specifically.

### `throttled<T>(source: ReadSignal<T>, ms: number): ReadSignal<T>`

Reflects `source` at most once every `ms`. Drops intermediate values during the window.

```ts
import { signal, throttled } from '@kontsedal/olas-core'

const scrollY = signal(0)
const tScroll = throttled(scrollY, 50)
// tScroll.value updates at most every 50ms.
```

---

## Controllers & roots

### `defineController<Props, Api>(factory): ControllerDef<Props, Api>`

```ts
function defineController<Props, Api>(
  factory: (ctx: Ctx, props: Props) => Api,
): ControllerDef<Props, Api>
```

Declare a controller. The factory runs once per *instance* (one per `createRoot` or `ctx.child` call); it receives a fresh `ctx` bound to that instance's lifetime. The returned object is the controller's public API.

```ts
import { defineController, signal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return {
    count,
    increment: () => count.update((n) => n + 1),
  }
})
```

**When not to use:** if a feature is just one derived signal and no lifecycle, a plain `computed` may be enough. Reach for `defineController` when you have async, mutations, fields, or multiple methods.

**See also:** SPEC §3, §20.2.

### `createRoot<Api, TDeps>(def, options): Root<Api>`

```ts
function createRoot<Api, TDeps extends Record<string, unknown> = AmbientDeps>(
  def: ControllerDef<void, Api>,
  options: RootOptions<TDeps>,
): Root<Api>
```

Instantiate a controller as a *root*. Roots have no props (`ControllerDef<void, Api>`); all startup config goes in `deps`. The returned object is the controller's API plus the lifecycle controls — `dispose`, `suspend`, `resume`, `dehydrate`, `waitForIdle`, `__debug`.

```ts
import { createRoot } from '@kontsedal/olas-core'
import { counter } from './counter'

const root = createRoot(counter, { deps: {} })
root.increment()
root.dispose()
```

**Multiple roots are fine** — each is fully isolated (its own QueryClient, own subscriptions). Useful in tests, in micro-frontends, or when one page hosts two independent features.

**See also:** SPEC §20.8.

### Type: `RootOptions<TDeps>`

```ts
type RootOptions<TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  hydrate?: DehydratedState
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
}
```

- `deps` — required object; available everywhere as `ctx.deps`. Use it for api clients, routers, services, the current time.
- `onError` — sink for *uncaught* errors from effects, mutations, caches, emitter handlers, construction. Throws inside `onError` are swallowed.
- `hydrate` — replay a `DehydratedState` produced on the server.
- `refetchOnWindowFocus` / `refetchOnReconnect` — root-wide defaults; per-query specs can override either way.

### Type: `Root<Api>`

```ts
type Root<Api> = Api & {
  dispose(): void
  suspend(options?: { maxIdle?: number }): void
  resume(): void
  dehydrate(): DehydratedState
  waitForIdle(): Promise<void>
  readonly __debug: DebugBus
}
```

- `dispose()` — recursively dispose every child, every primitive, every effect. Idempotent.
- `suspend()` / `resume()` — temporarily pause subscriptions without disposing. `maxIdle` auto-disposes if not resumed in time.
- `dehydrate()` — serialize the cache into a `DehydratedState`.
- `waitForIdle()` — Promise that resolves when no fetches and no mutations are in flight.
- `__debug` — devtools event bus; see [Devtools event bus](#devtools-event-bus).

### Type: `ControllerDef<Props, Api>`

Opaque handle returned by `defineController`. Pass to `createRoot(...)`, `ctx.child(...)`, or `ctx.attach(...)`. Don't construct manually.

### Type: `AmbientDeps`

```ts
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: ApiClient
    router: Router
  }
}
```

App-wide module augmentation that names the keys/types in `ctx.deps`. After augmentation every `Ctx` exposes a typed `ctx.deps.api`, `ctx.deps.router`, etc. without per-controller generics.

---

## The `Ctx` object

The factory-time API for one controller instance. Every primitive created through `ctx` is owned by — and disposed with — this controller.

### `ctx.deps: TDeps`

Read-only reference to the root's `deps`. Augment the global `AmbientDeps` interface to type your services once across the app.

### `ctx.effect(fn: () => void | (() => void)): void`

Same semantics as the top-level `effect`, but the effect is disposed when the controller is. Use this inside a controller; never use top-level `effect` for controller-bound logic.

### `ctx.onDispose(fn: () => void): void`

Register a callback that runs when the controller is disposed. Use for one-off cleanup that isn't naturally an effect (e.g., disconnect a long-lived resource).

### `ctx.onSuspend(fn: () => void): void` / `ctx.onResume(fn: () => void): void`

Run when the controller is suspended / resumed. Suspension pauses subscriptions; resume restores them.

### `ctx.child<Props, Api>(def, props, options?): Api`

Construct a sub-controller. Returns the child's API directly. The child is disposed when *this* controller disposes.

```ts
const board = defineController((ctx) => {
  const editor = ctx.child(cardEditor, { cardId: 'c1' })
  return { editor }
})
```

### `ctx.attach<Props, Api>(def, props, options?): { api; dispose }`

Like `child(...)` but also returns a `dispose()` handle so you can tear the sub-tree down early — e.g., when the user closes a panel. Idempotent. The sub-tree is still disposed automatically if the parent disposes first.

```ts
const board = defineController((ctx) => {
  let openEditor: { api: EditorApi; dispose: () => void } | null = null
  return {
    openCard: (cardId: string) => {
      openEditor?.dispose()
      openEditor = ctx.attach(cardEditor, { cardId })
    },
    closeCard: () => {
      openEditor?.dispose()
      openEditor = null
    },
  }
})
```

### `ctx.field<T>(initial, validators?): Field<T>`

See [Forms — Field](#forms--field).

### `ctx.form<S>(schema, options?): Form<S>`

See [Forms — Form](#forms--form).

### `ctx.fieldArray<I>(itemFactory, options?): FieldArray<I>`

See [Forms — FieldArray](#forms--fieldarray).

### `ctx.use(query, keyOrOptions?): AsyncState<T>` / `InfiniteQuerySubscription<...>`

See [Async data — queries](#async-data--queries).

### `ctx.cache<T>(fetcher, options?): LocalCache<T>`

See [Async data — local cache](#async-data--local-cache).

### `ctx.mutation<V, R>(spec): Mutation<V, R>`

See [Mutations](#mutations).

### `ctx.emitter<T>(): Emitter<T>` / `ctx.on(emitter, handler): void`

See [Emitters](#emitters).

### `ctx.provide<T>(scope, value): void` / `ctx.inject<T>(scope): T`

See [Scopes](#scopes).

---

## Async data — queries

Shared, keyed, cacheable async data. Two controllers subscribing to the same query with the same key share one fetch and one cache entry.

### `defineQuery<Args, T>(spec: QuerySpec<Args, T>): Query<Args, T>`

Declare a query at module scope. The returned `Query` value is passed to `ctx.use(...)` in subscribers, and exposes `invalidate`, `invalidateAll`, `setData`, `prefetch` at the module level for direct cache writes (e.g., from a mutation's `onMutate`).

```ts
import { defineQuery } from '@kontsedal/olas-core'

export const userQuery = defineQuery({
  key: (id: string) => [id],
  fetcher: async ({ signal }, id) => {
    const res = await fetch(`/api/users/${id}`, { signal })
    if (!res.ok) throw new Error(res.statusText)
    return res.json() as Promise<User>
  },
  staleTime: 30_000,
})
```

**See also:** SPEC §5.

### Type: `QuerySpec<Args, T>`

```ts
type QuerySpec<Args extends unknown[], T> = {
  key: (...args: Args) => unknown[]
  fetcher: (ctx: FetchCtx, ...args: Args) => Promise<T>
  staleTime?: number          // default 0 — data is immediately stale
  gcTime?: number             // default 5 * 60_000 — drop entry N ms after last subscriber
  refetchInterval?: number    // periodic background refetch while subscribed
  refetchOnWindowFocus?: boolean   // default false (root may override)
  refetchOnReconnect?: boolean     // default false (root may override)
  keepPreviousData?: boolean
  retry?: RetryPolicy         // default 0
  retryDelay?: RetryDelay     // default 1000 ms
}

type FetchCtx = { signal: AbortSignal; deps: AmbientDeps }
```

- **`key(...args)`** — must be a *pure* function of args. Its return value is stably hashed; same hash means same cache entry.
- **`fetcher(ctx, ...args)`** — receives the abort signal + root deps as first arg, then the same positional args. Long-running fetchers must honor `signal`.

**Gotcha:** the value of `spec.key(...)` is what's hashed; the *original* `args` are what the fetcher receives. They're not the same thing — see [`.wiki/pitfalls/callargs-vs-keyargs.md`](.wiki/pitfalls/callargs-vs-keyargs.md).

### Type: `Query<Args, T>`

```ts
type Query<Args extends unknown[], T> = {
  invalidate(...args: Args): void
  invalidateAll(): void
  setData(...args: [...Args, updater: (prev: T | undefined) => T]): Snapshot
  prefetch(...args: Args): Promise<T>
}
```

- `invalidate(...args)` — mark a specific keyed entry stale + refetch if it has subscribers.
- `invalidateAll()` — same, every entry of this query.
- `setData(...args, updater)` — patch the cached data for one key. Returns a `Snapshot` for rollback. Used in mutation `onMutate` for optimistic updates.
- `prefetch(...args)` — fetch into the cache without subscribing (e.g., on hover before navigating).

### `ctx.use<Args, T>(query, key?): AsyncState<T>`

Subscribe a controller to a `Query`. The `key` thunk reads signals — re-evaluating when they change re-keys the subscription (auto-unsubscribes the old entry, acquires the new).

```ts
import { defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

export const userProfile = defineController((ctx, props: { id: string }) => {
  const user = ctx.use(userQuery, () => [props.id])
  return { user }
})
```

Forms accepted for the second argument:

- A thunk `() => Args` — reactive key.
- A full options object `UseOptions<Args>`: `{ key?: () => Args, enabled?: () => boolean }`. Use `enabled` to gate the fetch (returns `status: 'idle'` while false).

### Type: `AsyncState<T>` (`QuerySubscription<T>`)

```ts
type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

type AsyncState<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<AsyncStatus>
  isLoading: ReadSignal<boolean>          // true only on initial load (no prior data)
  isFetching: ReadSignal<boolean>         // true on any in-flight fetch (incl. refetch)
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean>

  refetch: () => Promise<T>
  reset: () => void
  firstValue: () => Promise<T>            // resolves with the first non-undefined data
}
```

Subscribers can read any of the 8 signals individually, or use `useQuery(state)` in React to batch them into one render.

### Type: `UseOptions<Args>`

```ts
type UseOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean
}
```

---

## Async data — infinite queries

Cursor / page-based pagination accumulating into `pages: TPage[]`.

### `defineInfiniteQuery<Args, PageParam, TPage, TItem?>(spec): InfiniteQuery<Args, TPage, TItem>`

```ts
import { defineInfiniteQuery } from '@kontsedal/olas-core'

export const feedQuery = defineInfiniteQuery({
  key: (channel: string) => [channel],
  fetcher: async ({ pageParam, signal }, channel) => {
    const res = await fetch(`/api/feed/${channel}?cursor=${pageParam}`, { signal })
    return res.json() as Promise<{ items: Post[]; nextCursor: string | null }>
  },
  initialPageParam: '',
  getNextPageParam: (last) => last.nextCursor,
  itemsOf: (page) => page.items,
})
```

The subscription returned by `ctx.use(feedQuery, ...)` includes `pages`, `items` (flattened), `hasNextPage`, `fetchNextPage`, etc. — full shape in SPEC §20.4.

---

## Async data — local cache

Controller-scoped cache — no sharing, dies with the controller.

### `ctx.cache<T>(fetcher, options?): LocalCache<T>`

Use when one controller wants async data that no other controller will share. The cache disposes with the controller and never lives in the global QueryClient.

```ts
const profile = defineController((ctx, props: { id: string }) => {
  const summary = ctx.cache(
    (signal) => fetch(`/api/users/${props.id}/summary`, { signal }).then((r) => r.json()),
    { key: () => [props.id], staleTime: 60_000 },
  )
  return { summary }
})
```

**When to use this vs `defineQuery`:** if no other controller will need the same data, `ctx.cache` is simpler — no module-scope query value, no `define` boilerplate. If sharing is *opportunistic* (might happen later), prefer `defineQuery` to avoid a refactor.

### Type: `LocalCache<T>`

```ts
type LocalCache<T> = AsyncState<T> & {
  invalidate(): void
  setData(updater: (prev: T | undefined) => T): Snapshot
  dispose(): void
}
```

---

## Mutations

Writes that may need optimistic updates, abort handling, and concurrency rules.

### `ctx.mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R>`

```ts
import { defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

const profile = defineController((ctx, props: { id: string }) => {
  const updateName = ctx.mutation<string, void>({
    name: 'updateName',
    mutate: async (newName, signal) => {
      const res = await fetch(`/api/users/${props.id}`, {
        method: 'PATCH', body: JSON.stringify({ name: newName }), signal,
      })
      if (!res.ok) throw new Error('save failed')
    },
    onMutate: (newName) =>
      userQuery.setData(props.id, (prev) => {
        if (!prev) throw new Error('updateName before user loaded')
        return { ...prev, name: newName }
      }),
    onError: (_err, _vars, snapshot) => snapshot?.rollback(),
  })

  return { updateName }
})
```

### Type: `MutationSpec<V, R>`

```ts
type MutationSpec<V, R> = {
  name?: string                        // cosmetic — appears in devtools
  mutate: (vars: V, signal: AbortSignal) => Promise<R>
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (err: unknown, vars: V, snapshot: Snapshot | undefined) => void
  onSettled?: (result: R | undefined, err: unknown | undefined, vars: V) => void
  concurrency?: MutationConcurrency    // default 'parallel'
  retry?: RetryPolicy
  retryDelay?: RetryDelay
}

type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'
```

- **`mutate(vars, signal)`** — the write. Honor `signal` so superseded / disposed runs can abort.
- **`onMutate(vars)`** — runs *before* `mutate`. Return a `Snapshot` from `query.setData(...)` to apply an optimistic update; the snapshot is auto-rolled-back on abort, manually rolled back via `snapshot.rollback()` on `onError`.
- **Concurrency modes:**
  - `parallel` *(default)* — runs are independent. `isPending` is true if any are in-flight.
  - `latest-wins` — a new `.run()` aborts the in-flight one.
  - `serial` — runs queue and execute one at a time.

**Gotcha:** rollback is **automatic only on abort** (latest-wins supersede, dispose). For normal `mutate` rejections, call `snapshot?.rollback()` in `onError` explicitly. See [`.wiki/pitfalls/latest-wins-rollback-order.md`](.wiki/pitfalls/latest-wins-rollback-order.md).

### Type: `Mutation<V, R>`

```ts
type Mutation<V, R> = {
  run(vars: V): Promise<R>
  reset(): void
  readonly isPending: ReadSignal<boolean>
  readonly error: ReadSignal<unknown | undefined>
  readonly lastVariables: ReadSignal<V | undefined>
  readonly lastResult: ReadSignal<R | undefined>
  // ... see spec §20.5 for the full surface
}
```

### Type: `Snapshot`

```ts
type Snapshot = {
  rollback: () => void
  finalize: () => void
}
```

Returned by `query.setData(...)` / `localCache.setData(...)`.

- `rollback()` — restore the previous data; also clears `hasPendingMutations` on the entry if no other snapshots are live.
- `finalize()` — commit the snapshot as the new truth. The mutation runner auto-calls this on success; user code rarely needs to.

Both are idempotent and mutually exclusive — whichever happens first wins, subsequent calls (including the runtime's auto-calls) no-op.

---

## Forms — `Field`

### `ctx.field<T>(initial, validators?): Field<T>`

Create a single field. The `initial` value seeds the field; `validators` is an array of `Validator<T>` functions run on every change (and on `validate()` / `revalidate()`).

```ts
import { defineController, required, minLength } from '@kontsedal/olas-core'

const form = defineController((ctx) => {
  const name = ctx.field<string>('', [required(), minLength(2)])
  return { name }
})
```

**Gotcha:** `ctx.field('')` infers `Field<''>` (literal narrowing). Annotate when you want a wider type: `ctx.field<string>('')`. See [`.wiki/pitfalls/literal-type-narrowing.md`](.wiki/pitfalls/literal-type-narrowing.md).

### Type: `Field<T>`

```ts
type Field<T> = ReadSignal<T> & {
  readonly errors: ReadSignal<string[]>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>

  set(value: T): void
  setAsInitial(value: T): void
  reset(): void
  markTouched(): void
  revalidate(): Promise<boolean>
  dispose(): void
}
```

- `set(value)` — write a new value; marks `isDirty: true` and triggers validators.
- `setAsInitial(value)` — write a new value AND re-anchor `reset()`'s target here, without marking dirty. Use for "load this value as the new baseline" — most commonly when reseating a form from server data outside the `ctx.form({initial})` path.
- `field.value` reads the current value directly (because `Field<T>` *is* a `ReadSignal<T>`). Compare with `Form` and `FieldArray`, whose `value` is a `ReadSignal<...>`. See [`.wiki/pitfalls/field-value-shape.md`](.wiki/pitfalls/field-value-shape.md).

### Type: `Validator<T>`

```ts
type Validator<T> = (value: T, signal: AbortSignal) =>
  | string | null
  | Promise<string | null>
```

Return `null` for "valid", a non-empty string for "invalid (here's the error)". Sync validators just return; async validators return a `Promise`. The `signal` aborts when the value changes mid-run.

### `debouncedValidator<T>(fn: Validator<T>, ms: number): Validator<T>`

Wrap an async validator so per-keystroke checks don't pile up. Cancels the prior run via `AbortSignal` when a new value arrives within `ms`.

```ts
import { debouncedValidator } from '@kontsedal/olas-core'

const usernameAvailable = debouncedValidator<string>(async (value, signal) => {
  const res = await fetch(`/api/check?name=${value}`, { signal })
  const taken = (await res.json()).taken as boolean
  return taken ? 'already taken' : null
}, 300)
```

---

## Forms — `Form`

### `ctx.form<S>(schema, options?): Form<S>`

Aggregate fields, sub-forms, and field-arrays into one typed object with `value`, `errors`, `isValid`, etc. The schema is a record of primitives.

```ts
import { defineController, required, email } from '@kontsedal/olas-core'

const profile = defineController((ctx) => {
  const form = ctx.form({
    name: ctx.field('', [required()]),
    email: ctx.field('', [required(), email()]),
    address: ctx.form({
      street: ctx.field(''),
      city: ctx.field(''),
    }),
  })
  return { form }
})
```

Access nested fields via `form.fields.address.fields.city`. There is no path-typed `form.fieldAt('address.city')` — the nested shape covers ~95% of cases.

### Type: `Form<S>`

```ts
type Form<S extends FormSchema> = {
  readonly fields: { [K in keyof S]: S[K] }
  readonly value: ReadSignal<FormValue<S>>
  readonly errors: ReadSignal<FormErrors<S>>
  readonly topLevelErrors: ReadSignal<string[]>
  readonly flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>

  set(partial: DeepPartial<FormValue<S>>): void
  resetWithInitial(partial: DeepPartial<FormValue<S>>): void
  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>
  dispose(): void
}
```

- `value` is a `ReadSignal<FormValue<S>>` — read via `form.value.value`. (Compare with `Field.value`, which is the value directly.)
- `set(partial)` deep-merges a partial value, batched; marks affected leaves dirty.
- `resetWithInitial(partial)` re-seats every covered leaf via `setAsInitial` — values applied, `reset()` retargeted, **no dirty bump**. Used for "load this from the server as the new baseline."
- `validate()` runs every leaf's validators and resolves with `true` iff all leaves are valid.

### Type: `FormOptions<S>`

```ts
type FormOptions<S> = {
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  validators?: FormValidator<S>[]
}
```

- `initial` — initial value object (or a thunk). If a thunk reads signals, the initial value re-applies when those signals change *and the form is not dirty* (no-clobber-while-dirty). Useful for "form-from-server" patterns.
- `validators` — top-level validators that see the whole `FormValue<S>`.

---

## Forms — `FieldArray`

### `ctx.fieldArray<I>(itemFactory, options?): FieldArray<I>`

Dynamic list of `Field<T>` or `Form<S>` items. The factory is invoked once per insertion.

```ts
import { defineController } from '@kontsedal/olas-core'

const todoList = defineController((ctx) => {
  const todos = ctx.fieldArray(
    (initial?: string) => ctx.field(initial ?? ''),
    { initial: ['buy milk', 'feed cat'] },
  )
  return { todos }
})

// later
todoList.todos.add('walk dog')
todoList.todos.remove(0)
```

### Type: `FieldArray<I>`

```ts
type FieldArray<I extends Field<any> | Form<any>> = {
  readonly items: ReadSignal<ReadonlyArray<I>>
  readonly value: ReadSignal<FieldArrayValue<I>>
  readonly errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  readonly topLevelErrors: ReadSignal<string[]>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly size: ReadSignal<number>

  add(initial?: ItemInitial<I>): void
  insert(index: number, initial?: ItemInitial<I>): void
  remove(index: number): void
  move(from: number, to: number): void
  at(index: number): I | undefined
  clear(): void
  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>
  dispose(): void
}
```

---

## Forms — stdlib validators

Pre-built `Validator<T>` factories. Each accepts an optional custom message.

```ts
import { required, minLength, maxLength, min, max, email, pattern } from '@kontsedal/olas-core'

required('Name is required')
minLength(3, 'Min 3 characters')
maxLength(80)
min(18, 'Must be 18+')
max(120)
email('Invalid email')
pattern(/^\d{5}$/, 'ZIP must be 5 digits')
```

Each returns a `Validator<T>` you pass to `ctx.field(initial, [validator, ...])`. For complex/cross-field rules, write your own or use `@kontsedal/olas-zod`.

---

## Scopes

Typed cross-tree data without prop drilling — like React context, but typed and tied to the controller tree.

### `defineScope<T>(options?): Scope<T>`

```ts
import { defineScope } from '@kontsedal/olas-core'

export const currentBoardScope = defineScope<{ id: string; title: string }>()
export const activityScope = defineScope<Emitter<string>>({ default: createEmitter() })
```

Two `defineScope` calls — even with the same type — produce *distinct* scopes (identity is per-call). Use module-level singletons.

### `ctx.provide<T>(scope, value): void`

Provide a value for a scope on this controller. Descendant controllers (via `ctx.child` / `ctx.attach`) can read it via `ctx.inject`.

### `ctx.inject<T>(scope): T`

Read the scope's value. Walks up the controller tree; throws if no provider and no default. The scope's default (passed to `defineScope`) is used when no ancestor provides one.

```ts
const board = defineController((ctx, props: { boardId: string }) => {
  ctx.provide(currentBoardScope, { id: props.boardId, title: 'Roadmap' })
  return {}
})

const card = defineController((ctx) => {
  const board = ctx.inject(currentBoardScope)
  // board.id, board.title — typed.
  return {}
})
```

**See also:** SPEC §10.3.

### Type: `Scope<T>` / `ScopeOptions<T>`

```ts
type ScopeOptions<T> = { default?: T; label?: string }
type Scope<T> = { /* internal */ }
```

---

## Emitters

Typed pub/sub for cross-controller events. The emitter itself is just a value — pass it via `ctx.deps` or `ctx.provide(scope)`.

### `createEmitter<T = void>(): Emitter<T>`

Standalone emitter. Use when you want one app-wide or share via a scope.

```ts
import { createEmitter } from '@kontsedal/olas-core'

const activity = createEmitter<{ when: number; what: string }>()
activity.on((ev) => console.log(ev))
activity.emit({ when: Date.now(), what: 'card created' })
```

### `ctx.emitter<T = void>(): Emitter<T>`

Controller-scoped emitter. Disposes with the controller.

### `ctx.on<T>(emitter, handler): void`

Subscribe with handler cleanup tied to the controller's lifetime. Prefer this over `emitter.on(...)` inside a controller.

```ts
const log = defineController((ctx) => {
  ctx.on(ctx.deps.activity, (ev) => console.log(ev))
  return {}
})
```

### Type: `Emitter<T>`

```ts
type Emitter<T> = {
  emit(value: T): void
  on(handler: (value: T) => void): () => void
  once(handler: (value: T) => void): () => void
}
```

---

## SSR — `dehydrate` / `hydrate`

### `root.dehydrate(): DehydratedState`

JSON-serializable snapshot of the root's query client. Call on the server *after* `await root.waitForIdle()`.

### `root.waitForIdle(): Promise<void>`

Resolves when no query fetches and no mutations are in flight. Used on the server to wait for the data dependencies before serializing.

### `createRoot(def, { deps, hydrate })`

Replay a `DehydratedState` on the client. Hydrated entries don't refetch on first subscribe (within their `staleTime`).

```ts
// server
const root = createRoot(app, { deps: serverDeps })
const html = renderToString(<OlasProvider root={root}><App /></OlasProvider>)
await root.waitForIdle()
const state = root.dehydrate()
// inline `state` into the HTML response

// client
const root = createRoot(app, { deps: clientDeps, hydrate: state })
```

**Limitation:** `defineInfiniteQuery` entries are *not* serialized today — regular `defineQuery` keyed by cursor works for SSR pagination.

### Types: `DehydratedState`, `DehydratedEntry`

```ts
type DehydratedEntry = { key: readonly unknown[]; data: unknown; lastUpdatedAt: number }
type DehydratedState = { version: 1; entries: DehydratedEntry[] }
```

---

## Errors

### `RootOptions.onError`

```ts
onError?: (err: unknown, context: ErrorContext) => void
```

Single sink for uncaught errors from effects, mutations, caches, emitter handlers, and construction. Throws *inside* `onError` are swallowed.

### Type: `ErrorContext`

```ts
type ErrorContext = {
  kind: 'effect' | 'mutation' | 'cache' | 'emitter' | 'construction' | string
  controllerPath: string[]    // root → leaf
  // extras vary by kind: queryKey, fieldName, etc.
}
```

### `isAbortError(err): boolean`

Returns `true` for `DOMException` with `name === 'AbortError'`. Use in `mutate` / `fetcher` catches when you want to distinguish user-aborts from real failures.

---

## Devtools event bus

### `root.__debug: DebugBus`

```ts
type DebugBus = {
  subscribe(handler: (event: DebugEvent) => void): () => void
}
```

Subscribe to a structured event stream — controller lifecycle, cache events, mutation events, field validations. Used by `@kontsedal/olas-devtools`.

**Production behaviour.** In `@kontsedal/olas-core`'s production build, the emission
sites are removed by the bundler. `subscribe` accepts and returns a no-op
unsub; no events fire. Use the devtools subscription in dev only — see
SPEC §23 *Devtools / `__debug` and production builds*.

### Type: `DebugEvent` (discriminated union)

```ts
type DebugEvent =
  | { type: 'controller:constructed' | 'controller:suspended' | 'controller:resumed' | 'controller:disposed'; path: string[]; propsSnapshot?: unknown }
  | { type: 'cache:subscribed' | 'cache:fetch-start' | 'cache:fetch-success' | 'cache:fetch-error' | 'cache:invalidated' | 'cache:gc'; queryKey: readonly unknown[]; controllerPath?: string[]; durationMs?: number; error?: unknown }
  | { type: 'mutation:run' | 'mutation:success' | 'mutation:error' | 'mutation:rollback'; controllerPath: string[]; vars?: unknown; error?: unknown }
  | { type: 'field:validated'; controllerPath: string[]; fieldName: string; valid: boolean; errors: string[] }
```

Internal events may be added — the schema is stable enough to build tooling on, but not a public API guarantee.

### Type: `DebugCacheEntry`

Returned by `root.__debug.queryEntries()` for the cache inspector. See SPEC §20.9.

---

## Utilities

### `isAbortError(err: unknown): boolean`

See [Errors](#errors).

### Re-exported types: `CtrlApi`, `CtrlProps`

Conveniences for extracting types from a `ControllerDef<Props, Api>`:

```ts
import type { CtrlApi, CtrlProps } from '@kontsedal/olas-core'

type Props = CtrlProps<typeof myController>
type Api = CtrlApi<typeof myController>
```

---

# @kontsedal/olas-core/testing

Test-only helpers. Importing from a non-test file is a smell — the `/testing` sub-path makes it grep-able.

### `createTestController<Props, Api, TDeps>(def, { deps, props, onError? }): Root<Api>`

Construct an isolated root wrapping a single controller. Returns the controller's API plus the standard `Root` lifecycle controls. Equivalent to a hand-rolled "wrap in a root" boilerplate.

```ts
import { createTestController } from '@kontsedal/olas-core/testing'

test('counter increments', () => {
  const ctrl = createTestController(counter, { deps: {}, props: undefined })
  ctrl.increment()
  expect(ctrl.count.peek()).toBe(1)
  ctrl.dispose()
})
```

### `fakeField<T>(initial, overrides?): Field<T>`

Shape-correct fake. Pass an initial value plus optional overrides for the read-only signals (`errors`, `isValid`, etc.) or methods (`set`, `revalidate`, etc.). Returns a real `Field<T>` — passes `useField(...)` and any component accepting a real field.

```ts
import { fakeField } from '@kontsedal/olas-core/testing'
import { render } from '@testing-library/react'

const name = fakeField<string>('Ada', { errors: ['too short'], touched: true })
render(<NameInput field={name} />)
```

### `fakeAsyncState<T>(overrides?): AsyncState<T>`

Same idea for `AsyncState<T>`. Pass overrides for any of the signal-backed fields plus `refetch` / `reset` / `firstValue` methods. Defaults: `status: 'idle'` unless `data` is provided (then `'success'`).

```ts
import { fakeAsyncState } from '@kontsedal/olas-core/testing'

const user = fakeAsyncState({ data: { id: '1', name: 'Ada' } })
render(<UserCard user={user} />)
```

---

# @kontsedal/olas-react

The React adapter. `~230` LOC on top of `useSyncExternalStore` — concurrent-safe, no tearing, StrictMode-safe.

### `OlasProvider({ root, children })`

```ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): JSX.Element
```

Pass the root from your app entry. Components descended from this provider can call `useRoot()`.

### `useRoot<Api = unknown>(): Api`

Resolve the provider's root api in a component. Throws if called outside a provider — surfaces the "I forgot to wrap" mistake at the first hook call.

```ts
import { useRoot } from '@kontsedal/olas-react'
import type { AppApi } from './controllers/app'

function Header() {
  const api = useRoot<AppApi>()
  // ...
}
```

### `useController<Api>(root: Root<Api>): Api`

Back-compat alias for `useRoot()`. Takes the root explicitly, so it's usable outside a provider (notably in tests).

### `use<T>(signal: ReadSignal<T>): T`

Subscribe a component to one signal. Returns the current value; re-renders on change. Built on `useSyncExternalStore`.

```ts
import { use, useRoot } from '@kontsedal/olas-react'

function Count() {
  const api = useRoot<{ count: ReadSignal<number> }>()
  return <span>{use(api.count)}</span>
}
```

### `useField<T>(field: Field<T>): { value, errors, isValid, isDirty, touched, isValidating, set, reset, markTouched, revalidate }`

Subscribe to all 5 read signals on a `Field<T>` with a single hook call. Returns the unwrapped values plus the action methods so binding to an `<input>` is one destructure.

```ts
import { useField } from '@kontsedal/olas-react'

function NameInput({ field }: { field: Field<string> }) {
  const f = useField(field)
  return (
    <label>
      <span>Name</span>
      <input value={f.value} onChange={(e) => f.set(e.target.value)} onBlur={f.markTouched} />
      {f.touched && f.errors[0] && <em>{f.errors[0]}</em>}
    </label>
  )
}
```

### `useQuery<T>(state: AsyncState<T>): { data, error, status, isLoading, isFetching, isStale, lastUpdatedAt, hasPendingMutations, refetch }`

Subscribe to all 8 read signals on an `AsyncState<T>` with a single hook call.

```ts
import { useQuery } from '@kontsedal/olas-react'

function UserCard({ user }: { user: AsyncState<User> }) {
  const u = useQuery(user)
  if (u.isLoading) return <Spinner />
  if (u.error) return <ErrorBox error={u.error} />
  return <h1>{u.data?.name}</h1>
}
```

### `<KeepAlive controller>`

```tsx
<KeepAlive controller={panel}>
  <Panel />
</KeepAlive>
```

Wrap a sub-tree to suspend the underlying controller on unmount and resume on remount (instead of disposing). Useful for routes you switch back to often.

### `useSuspendOnHidden(controller: SuspendableController): void`

Suspends the controller when `document.visibilitychange` flips to hidden; resumes on visible. Pair with `<KeepAlive>` for tab-switching workloads.

### Type: `SuspendableController`

```ts
type SuspendableController = { suspend(options?: { maxIdle?: number }): void; resume(): void }
```

Any object with `suspend` and `resume` satisfies this — a full `Root<Api>` or a smaller child returned from `ctx.attach`.

---

# @kontsedal/olas-persist

Persist state to a storage adapter (localStorage by default). Composes with any signal-shaped source — plain signals, fields, custom objects.

### `usePersisted<T>(ctx, key, source, options?): Persisted`

Wire a signal-like source to persistent storage. Reads the saved value on construction (sync for localStorage, async if the adapter returns a promise). Subsequent source writes mirror to storage. Cleanup is bound to `ctx`.

```ts
import { signal } from '@kontsedal/olas-core'
import { usePersisted } from '@kontsedal/olas-persist'

const draft = signal('')
usePersisted(ctx, 'draft', draft, { crossTab: true })
```

### Type: `PersistOptions<T>`

```ts
type PersistOptions<T> = {
  storage?: StorageAdapter        // default: localStorageAdapter
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  crossTab?: boolean              // default: false — wire window 'storage' event
}
```

### Type: `PersistableSource<T>`

```ts
type PersistableSource<T> = {
  readonly value: T
  set(value: T): void
  subscribe(handler: (value: T) => void): () => void
}
```

Structural — anything matching this shape works (a `Signal<T>`, a `Field<T>`, your own object).

### Type: `Persisted`

```ts
type Persisted = { ready: ReadSignal<boolean> }
```

`ready` flips to `true` once the initial load completes. Synchronous for localStorage; useful for async storage adapters.

### Type: `StorageAdapter`

```ts
type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  remove(key: string): void | Promise<void>
  subscribe?(key: string, handler: (raw: string | null) => void): () => void
}
```

### `localStorageAdapter: StorageAdapter`

The default. Returns `null` from `get` if `localStorage` is undefined (SSR-safe).

---

# @kontsedal/olas-zod

Bridge Zod schemas into Olas validators and forms.

### `zodValidator<T>(schema: z.ZodType<T>): Validator<T>`

Wrap a Zod schema as a synchronous `Validator<T>`. Use as a field validator.

```ts
import { z } from 'zod'
import { zodValidator } from '@kontsedal/olas-zod'

const email = ctx.field('', [zodValidator(z.string().email())])
```

### `zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>`

Same, but returns a `Promise<string | null>`. Use when the schema has async `.refine(...)` checks.

### `formFromZod<T>(ctx, schema, options?): Form<...>`

Walk a `z.object(...)` / `z.array(...)` / leaf tree and emit the matching `Form` / `FieldArray` / `Field` structure with validators auto-attached.

```ts
import { z } from 'zod'
import { formFromZod } from '@kontsedal/olas-zod'

const Schema = z.object({
  name: z.string().min(2),
  age: z.number().min(0),
  tags: z.array(z.string()),
})

const form = formFromZod(ctx, Schema)
// form.value: ReadSignal<{ name: string; age: number; tags: string[] }>
```

**Limitation:** array-level `.min(N)` rules from the outer Zod schema are *not* promoted to a `FieldArray`-level validator today. Leaf and nested-object rules work.

### Type: `ZodToLeaf<S>`

Mapped type for the Olas-form structure derived from a Zod schema. Useful for typing form-walking helpers.

---

# @kontsedal/olas-devtools

In-app debugging UI consuming `root.__debug`. Two main components, both React.

### `<DevtoolsLauncher root defaultTab? maxEntries? storageKey? urlHashKey? initial? />`

Floating, draggable, resizable host for the panel. Renders a small launcher button (always present) and, when open, a `position: fixed` window with the panel inside. Position + size + open + minimized state persist to `localStorage`.

```tsx
import { DevtoolsLauncher } from '@kontsedal/olas-devtools'

<OlasProvider root={root}>
  <App />
  {import.meta.env.DEV && <DevtoolsLauncher root={root} />}
</OlasProvider>
```

### `<DevtoolsPanel root defaultTab? maxEntries? />`

The panel itself — for embedding inside your own chrome (e.g., a fixed sidebar). The launcher uses this internally.

### Type: `DevtoolsTab`

```ts
type DevtoolsTab = 'tree' | 'cache' | 'mutations' | 'fields' | 'events'
```

### Formatters

`formatPath(path: string[]): string`, `formatPayload(value: unknown): string`, `formatTime(ms: number): string` — utilities the panel uses, exported for embedding in custom views.

---

## Where to go next

- [`README.md`](README.md) — guided tour with progressive examples.
- [`SPEC.md`](SPEC.md) — full design with rationale and edge cases.
- [`RECIPES.md`](RECIPES.md) — reusable user composables (`useDebounced`, `usePagination`, `useSubmit`, …).
- [`MIGRATING.md`](MIGRATING.md) — coming from TanStack Query or Redux Toolkit.
- [`.wiki/pitfalls/`](.wiki/pitfalls) — recorded footguns. Every cross-reference above lands here.
- [`BACKLOG.md`](BACKLOG.md) — proposed extensions, post-v1 packages, deferred ideas.
