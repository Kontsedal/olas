# Recipes

Copy-paste patterns for things that aren't framework primitives but show up in every non-trivial Olas app. These are **user composables** — functions you write once, drop into a project, and tweak. Olas core stays small; these grow with your needs.

Spec §16.5 documents the same patterns in narrative form. This file is the "ready to paste" version.

---

## `useDebounced` — debounce a write

When the user types into a search box, you want to query after they stop typing, not on every keystroke. `debounced` (from `@kontsedal/olas-core`) is a pure derived signal — no controller needed:

```ts
import { defineController, signal, debounced } from '@kontsedal/olas-core'

const searchController = defineController((ctx) => {
  const term = signal('')
  const debouncedTerm = debounced(term, 300)

  // a query keyed by the debounced value
  const results = ctx.use(searchQuery, () => [debouncedTerm.value])

  return { term, results }
})
```

`debounced(source, ms)` returns a `ReadSignal<T>` that reflects `source` but waits `ms` after the last write before emitting. Compose with `ctx.use` directly — the query re-keys on debounced changes, not raw ones.

For "debounce a validator," use `debouncedValidator(fn, ms)` from `@kontsedal/olas-core` instead — it wraps a `Validator<T>` so per-keystroke async checks don't pile up.

---

## `usePagination` — page state with sane defaults

The page-number + next/prev triad:

```ts
import type { Ctx } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'

function usePagination(_ctx: Ctx, opts: { pageSize: number; initialPage?: number } = { pageSize: 20 }) {
  const page = signal(opts.initialPage ?? 1)
  const pageSize = signal(opts.pageSize)

  return {
    page,
    pageSize,
    next: () => page.update((p) => p + 1),
    prev: () => page.update((p) => Math.max(1, p - 1)),
    setPage: (n: number) => page.set(Math.max(1, n)),
    reset: () => page.set(1),
  }
}

// usage
const listController = defineController((ctx) => {
  const pagination = usePagination(ctx, { pageSize: 25 })
  const items = ctx.use(itemsQuery, () => [pagination.page.value, pagination.pageSize.value])
  return { ...pagination, items }
})
```

`_ctx` is unused here, but pinning the convention (`ctx` first) makes it obvious which composables are lifecycle-bound (when they grow to need it).

---

## `useSubmit` — validate then mutate

```ts
import type { Ctx, Form, Mutation, ReadSignal } from '@kontsedal/olas-core'

function useSubmit<T, R>(
  ctx: Ctx,
  form: Form<any> & { value: ReadSignal<T> },
  mutate: (data: T, signal: AbortSignal) => Promise<R>,
): Mutation<void, R> {
  return ctx.mutation({
    mutate: async (_: void, signal) => {
      form.markAllTouched()
      const valid = await form.validate()
      if (!valid) throw new Error('Form invalid')
      return mutate(form.value.value as T, signal)
    },
    onSuccess: () => form.reset(),
  })
}

// usage
const profileController = defineController((ctx) => {
  const form = ctx.form({ name: ctx.field('') })
  const save = useSubmit(ctx, form, (data, signal) => ctx.deps.api.saveProfile(data, { signal }))
  return { form, save }
})
```

`save.run()` triggers validate-then-mutate. `save.isPending` / `save.error` are signals you can bind in the UI.

---

## `useInlineEdit` — click-to-edit a cell

```ts
import type { Ctx } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'

function useInlineEdit<T>(
  ctx: Ctx,
  current: () => T,
  save: (value: T, signal: AbortSignal) => Promise<void>,
) {
  const isEditing = signal(false)
  const draft = signal<T | undefined>(undefined)

  const start = () => {
    draft.set(current())
    isEditing.set(true)
  }
  const cancel = () => {
    draft.set(undefined)
    isEditing.set(false)
  }
  const commit = ctx.mutation({
    mutate: (_: void, signal) => save(draft.peek() as T, signal),
    onSuccess: () => {
      draft.set(undefined)
      isEditing.set(false)
    },
  })

  return { isEditing, draft, start, cancel, commit }
}
```

`current` is a thunk so the edit-start reads the latest server value, not a stale snapshot.

---

## `useTail` — bounded live stream with backpressure

For WebSocket / SSE streams firing 10–1000 events/sec, rendered live:

```ts
import type { Ctx } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'

function useTail<T>(
  ctx: Ctx,
  subscribe: (push: (item: T) => void) => () => void,
  options: { capacity: number; flushMs?: number } = { capacity: 10_000, flushMs: 16 },
) {
  const buffer = signal<T[]>([])
  const isPaused = signal(false)
  let pending: T[] = []
  let flushTimer: number | null = null

  ctx.effect(() => {
    if (isPaused.value) return
    const unsub = subscribe((item) => {
      pending.push(item)
      if (flushTimer == null) {
        flushTimer = window.setTimeout(() => {
          const next = [...buffer.peek(), ...pending]
          if (next.length > options.capacity) next.splice(0, next.length - options.capacity)
          buffer.set(next)
          pending = []
          flushTimer = null
        }, options.flushMs ?? 16)
      }
    })
    return () => {
      unsub()
      if (flushTimer != null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }
  })

  return {
    items: buffer,
    isPaused,
    pause: () => isPaused.set(true),
    resume: () => isPaused.set(false),
  }
}
```

`flushMs` coalesces N events into one UI update — prevents 1000 renders/sec. `capacity` caps memory; oldest entries drop.

---

## `useRealtimePatcher` — WebSocket events → cache mutations

```ts
import type { Ctx } from '@kontsedal/olas-core'

function useRealtimePatcher<TEvent extends { type: string }>(
  ctx: Ctx,
  channel: string,
  handlers: Partial<Record<TEvent['type'], (ev: TEvent) => void>>,
) {
  ctx.effect(() => {
    const sub = ctx.deps.realtime.subscribe(channel, (ev: TEvent) => {
      handlers[ev.type as TEvent['type']]?.(ev)
    })
    return () => sub.unsubscribe()
  })
}

// usage
useRealtimePatcher<FeedEvent>(ctx, 'feed-events', {
  'like-added': (ev) => newsfeedQuery.setData('top-stories', (pages) => /* patch */),
  'comment-added': (ev) => commentsQuery.setData(ev.postId, (prev) => [...(prev ?? []), ev.comment]),
  'post-deleted': () => newsfeedQuery.invalidateAll(),
})
```

Requires a `realtime` service in deps with `subscribe(channel, handler)`. The framework primitive is `ctx.effect` + `setData`; this just wraps the dispatching boilerplate.

---

## Persisted mutations — survive reloads with `@kontsedal/olas-mutation-queue`

When a mutation hits the network and the user reloads (or the browser crashes) mid-request, you typically want the mutation to run again on the next page load — not silently drop. `@kontsedal/olas-mutation-queue` ships a `QueryClientPlugin` that writes pending mutations to a `StorageAdapter` and replays them on `init`.

```ts
// orders.ts — module scope. `defineMutation` registers `mutate` against
// `mutationId` so the queue plugin can find it on replay, BEFORE
// controllers reconstruct.
import { defineMutation } from '@kontsedal/olas-core'

export const createOrder = defineMutation({
  mutationId: 'order/create',
  mutate: async (vars: { sku: string; idempotencyKey: string }, signal) =>
    api.createOrder(vars, { signal }),
})
```

```ts
// app entry
import { localStorageAdapter } from '@kontsedal/olas-persist'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'

const root = createRoot(appController, {
  deps,
  plugins: [
    mutationQueuePlugin({
      adapter: localStorageAdapter,        // or indexedDbAdapter() for large payloads
      keyPrefix: 'my-app/mutations/v1',    // namespace
      maxAttempts: 5,                      // bound replays per entry
      onReplayError: (err, entry) => {
        // Telemetry / user-facing toast on lost mutations.
        Sentry.captureException(err, { extra: entry })
      },
    }),
  ],
})
```

```tsx
// inside a controller
const checkoutController = defineController((ctx) => {
  const place = ctx.mutation({
    ...createOrder,
    onSuccess: () => toast('Order placed'),
    onError: () => toast('We had trouble; we will retry automatically.'),
  })
  return { place }
})
```

**Idempotency** is the consumer's responsibility. Include a stable `idempotencyKey` in your variables (UUID generated at the call site, stored alongside the mutation entry) and have your server dedupe by it. The queue gives **at-least-once-until-success**; without an idempotency key, a reload mid-network-call can result in a double charge.

**`mutate` MUST NOT close over controller state.** On replay there is no controller — the queue calls the registered `mutate(vars, signal)` directly. Module-level `api` clients, environment-derived URLs, and the like are fine; anything that lives on the controller (a `ctx.deps` reference, a per-controller `signal`) is not.

**Adapter capability.** Replay requires an adapter that implements `keys()`. The built-in `localStorageAdapter` and `indexedDbAdapter()` both do. Custom adapters that only implement `get`/`set`/`delete` work for **enqueue** but **not replay** — the plugin warns and disables the replay path.

---

## Router integration

Use `@kontsedal/olas-router` — a generic adapter that exposes
`RouteParamsScope` / `RouteSearchScope` / `RoutePathnameScope` and a
`Bridge` component that pushes the router's state into those scopes.
Works with any client-side router (TanStack Router, React Router v6, or
your own). **Next.js is not supported** — see `BACKLOG.md` for the
philosophy reasoning.

### Setup

```tsx
import { createRouterAdapter, RouteParamsScope } from '@kontsedal/olas-router'

const adapter = createRouterAdapter()

const root = createRoot(appController, {
  deps,
  scopes: adapter.scopes, // seeds the three route scopes on the root
})
```

### Bridging — TanStack Router

```tsx
import { useLocation, useParams, useSearch } from '@tanstack/react-router'

function App() {
  const params = useParams({ strict: false })
  const search = useSearch({ strict: false })
  const location = useLocation()
  return (
    <OlasProvider root={root}>
      <adapter.Bridge params={params} search={search} pathname={location.pathname}>
        <YourRoutes />
      </adapter.Bridge>
    </OlasProvider>
  )
}
```

### Bridging — React Router v6

```tsx
import { useLocation, useParams, useSearchParams } from 'react-router-dom'

function App() {
  const params = useParams() as Record<string, string>
  const [sp] = useSearchParams()
  const { pathname } = useLocation()
  const search = Object.fromEntries(sp.entries())
  return (
    <OlasProvider root={root}>
      <adapter.Bridge params={params} search={search} pathname={pathname}>
        <YourRoutes />
      </adapter.Bridge>
    </OlasProvider>
  )
}
```

The `Bridge` shallow-equals the incoming `params` / `search` records, so
fresh-object-every-render (the typical router pattern) doesn't churn
downstream consumers.

### Consume in any controller

```ts
import { RouteParamsScope } from '@kontsedal/olas-router'

const profileController = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const user = ctx.use(userQuery, () => [params.value.userId])
  return { user }
})
```

`ctx.use`'s key thunk reads `params.value` — route changes auto-rekey
the subscription. No effects, no manual subscriptions.

### Pattern B — controller-per-route via `ctx.session`

For "the whole controller tree under a route changes when the user navigates," lean on `ctx.session`. The session swaps the child controller atomically when its key changes — old subscriptions tear down, new ones boot.

```ts
const appController = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  // `userId` keys the session — change it, and the page controller is
  // disposed-and-rebuilt with the new prop.
  const page = ctx.session(profilePageController, () => ({
    userId: params.value.userId,
  }))
  return { page }
})
```

`ctx.session(def, propsFn)` accepts a thunk that reads signals; when the props object changes by identity, the child is torn down and rebuilt — matches the typical route-change semantics. For routes whose key derives from path *and* search params, the thunk reads both and the session reacts to either changing.

### Pattern C — pre-fetching on route enter

Use the router's loader / `beforeLoad` hook to call `query.prefetch(...)` — the data lands in the cache before the component mounts, so `ctx.use` returns it synchronously. (See "structural sharing" in §6 of `SPEC.md` for the ref-stability guarantees this gives you.)

```tsx
// TanStack Router route definition
const userRoute = createRoute({
  path: '/users/$userId',
  loader: ({ params }) => userQuery.prefetch(params.userId),
})
```

Combined with `useQuery(sub, { suspense: true })`, the suspense fallback is skipped because data is already in cache by the time React reads it.

---

## When to lift to a package

If a composable ends up:

- Used in ≥3 unrelated controllers in your codebase, or
- Has its own meaningful tests, or
- Encapsulates non-trivial async/timing logic that would be easy to get wrong,

…then it belongs in its own file (or a shared internal `composables/` directory). Resist publishing to npm unless someone else asks — composables are easy to copy, and divergence is fine.
