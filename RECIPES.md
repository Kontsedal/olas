# Recipes

Copy-paste patterns for things that aren't framework primitives but show up in every non-trivial Olas app. These are **user composables** — functions you write once, drop into a project, and tweak. Olas core stays small; these grow with your needs.

Each composable takes `ctx` first and is named `create*`, like core's own `createField` and `createQuery`. A `use*` name reads as a React hook, and the `olas/no-react-hooks-in-controllers` lint rule reports one called inside a controller.

Spec §16.5 documents the same patterns in narrative form. This file is the "ready to paste" version.

---

## The deps these recipes assume

Services reach controllers, `mutate` functions and fetchers through `deps`, so tests and replays can supply their own. The recipes below read `deps.api` and `deps.realtime`, typed once through `AmbientDeps` as API.md shows:

```ts
// deps.ts — declare the services once, and every `ctx.deps` is typed
import type { RealtimeService } from '@kontsedal/olas-realtime'

type Options = { signal: AbortSignal }

export type Api = {
  saveProfile(data: { name: string }, options: Options): Promise<void>
  toggleTodo(todoId: string, options: Options): Promise<void>
  createOrder(order: { sku: string; idempotencyKey: string }, options: Options): Promise<void>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
    realtime: RealtimeService
  }
}
```

A controller reads `ctx.deps.api`. A `mutate` function reads `deps` from its second argument, `(vars, { signal, deps })`, and a fetcher from its first, `({ signal, deps }, ...args)`.

---

## `debounced` — debounce a query key

When the user types into a search box, you want to query after they stop typing, not on every keystroke. `debounced` from `@kontsedal/olas-core` gives a signal that lags its source:

<!-- snippet-prelude
import type { Query } from '@kontsedal/olas-core'
declare const searchQuery: Query<[term: string], string[]>
-->
```ts
import { createQuery, debounced, defineController, signal } from '@kontsedal/olas-core'

const searchController = defineController((ctx) => {
  const term = signal('')
  const debouncedTerm = debounced(term, 300)
  ctx.onDispose(() => debouncedTerm.dispose())

  // a query keyed by the debounced value
  const results = createQuery(ctx, searchQuery, () => [debouncedTerm.value])

  return { term, results }
})
```

`debounced(source, ms)` returns a `ReadSignal<T>` that reflects `source` but waits `ms` after the last write before emitting. Compose with `createQuery` directly — the query re-keys on debounced changes, not raw ones. The debounced signal runs its own effect, and `dispose()` in `ctx.onDispose` stops it with the controller.

For "debounce a validator," use `debouncedValidator(fn, ms)` from `@kontsedal/olas-core` instead — it wraps a `Validator<T>` so per-keystroke async checks don't pile up.

---

## `createPagination` — page state with sane defaults

The page-number + next/prev triad:

<!-- snippet-prelude
import type { Query } from '@kontsedal/olas-core'
declare const itemsQuery: Query<[page: number, pageSize: number], string[]>
-->
```ts
import type { Ctx } from '@kontsedal/olas-core'
import { createQuery, defineController, signal } from '@kontsedal/olas-core'

function createPagination(
  _ctx: Ctx,
  opts: { pageSize: number; initialPage?: number } = { pageSize: 20 },
) {
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
  const pagination = createPagination(ctx, { pageSize: 25 })
  const items = createQuery(ctx, itemsQuery, () => [
    pagination.page.value,
    pagination.pageSize.value,
  ])
  return { ...pagination, items }
})
```

`_ctx` is unused here. Pinning the convention of `ctx` first makes it obvious which composables are lifecycle-bound once they grow to need it.

---

## `createSubmit` — validate then mutate

```ts
import type { Ctx, Form, FormSchema, FormValue, Mutation } from '@kontsedal/olas-core'
import { createField, createForm, createMutation, defineController } from '@kontsedal/olas-core'

function createSubmit<S extends FormSchema, R>(
  ctx: Ctx,
  form: Form<S>,
  save: (data: FormValue<S>, signal: AbortSignal) => Promise<R>,
): Mutation<void, R> {
  return createMutation(ctx, {
    mutate: async (_: void, { signal }) => {
      form.markAllTouched()
      const valid = await form.validate()
      if (!valid) throw new Error('Form invalid')
      return save(form.value, signal)
    },
    onSuccess: () => form.reset(),
  })
}

// usage
const profileController = defineController((ctx) => {
  const form = createForm(ctx, { name: createField<string>(ctx, '') })
  const save = createSubmit(ctx, form, (data, signal) => ctx.deps.api.saveProfile(data, { signal }))
  return { form, save }
})
```

`save.run()` triggers validate-then-mutate. `save.isPending` and `save.error` are signals you can bind in the UI. A form that needs no `Mutation` can call `form.submit(handler)` instead: it validates first, tracks `isSubmitting` and resolves a `SubmitResult`.

---

## `createInlineEdit` — click-to-edit a cell

```ts
import type { Ctx } from '@kontsedal/olas-core'
import { createMutation, signal } from '@kontsedal/olas-core'

function createInlineEdit<T>(
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
  const commit = createMutation(ctx, {
    mutate: (_: void, { signal }) => save(draft.peek() as T, signal),
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

## `createTail` — bounded live stream with backpressure

For WebSocket and SSE streams firing 10–1000 events/sec, rendered live:

```ts
import type { Ctx } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'

function createTail<T>(
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

`@kontsedal/olas-realtime` ships the same buffer as `createLiveStream(ctx, channel, { capacity, flushMs })`, over the `RealtimeService` in `deps`. `createTail` takes any `subscribe` function instead.

---

## `createRealtimePatcher` — WebSocket events → cache writes

`@kontsedal/olas-realtime` ships this composable. It subscribes to a channel on `deps.realtime` for the controller's lifetime and hands each event to the handler named by its `type`:

<!-- snippet-prelude
import type { Query } from '@kontsedal/olas-core'
type Post = { id: string; likes: number }
type PostComment = { id: string; text: string }
declare const newsfeedQuery: Query<[feed: string], Post[]>
declare const commentsQuery: Query<[postId: string], PostComment[]>
-->
```ts
import { bindQuery, defineController } from '@kontsedal/olas-core'
import { createRealtimePatcher } from '@kontsedal/olas-realtime'

type FeedEvent =
  | { type: 'like-added'; postId: string }
  | { type: 'comment-added'; postId: string; comment: PostComment }
  | { type: 'post-deleted'; postId: string }

const feedController = defineController((ctx) => {
  const newsfeed = bindQuery(ctx, newsfeedQuery)
  const comments = bindQuery(ctx, commentsQuery)

  createRealtimePatcher<FeedEvent>(ctx, 'feed-events', {
    'like-added': (ev) => {
      // `write` creates an absent entry, so skip a feed this tab never loaded.
      if (newsfeed.peek('top-stories') === undefined) return
      newsfeed.write('top-stories', (posts = []) =>
        posts.map((p) => (p.id === ev.postId ? { ...p, likes: p.likes + 1 } : p)),
      )
    },
    // Each handler receives its own variant of `FeedEvent`, so `ev.comment` needs no check.
    'comment-added': (ev) => comments.write(ev.postId, (prev) => [...(prev ?? []), ev.comment]),
    'post-deleted': () => newsfeed.invalidateAll(),
  })

  return {}
})
```

Two things are load-bearing here. **`bindQuery`** scopes every operation to this root — a server handling concurrent requests has one root per request, and an unbound `newsfeedQuery.write(...)` would refuse to guess which one (§21.5). **`write`, not `setData`** — a realtime event is server truth that already happened, so there is nothing to roll back. `setData` opens an optimistic snapshot that someone must settle; calling it fire-and-forget leaks one live snapshot per event and wedges `hasPendingMutations` true forever. `setData` is for the optimistic half of a mutation; `write` is for data that is already true.

The `RealtimeService` is the app's own transport: anything with `subscribe(channel, handler)` that returns `{ unsubscribe }`. The framework primitive is `ctx.effect` + `write`; the composable wraps the dispatching boilerplate.

---

## Optimistic update — cancel, patch, return the snapshot

An optimistic update shows the result before the server confirms it, and undoes it if the server refuses. Three steps in `onMutate` make it hold:

<!-- snippet-prelude
import type { Query } from '@kontsedal/olas-core'
type Todo = { id: string; title: string; done: boolean }
declare const todosQuery: Query<[listId: string], Todo[]>
-->
```ts
import { bindQuery, createMutation, defineController } from '@kontsedal/olas-core'

const todoListController = defineController((ctx, props: { listId: string }) => {
  const todos = bindQuery(ctx, todosQuery)

  const toggle = createMutation(ctx, {
    id: 'todos/toggle',
    onMutate: (todoId: string) => {
      // 1. Cancel first: a fetch in flight would land over the guess.
      todos.cancel(props.listId)
      // 2. Patch, and 3. return the snapshot so the runner can settle it.
      return todos.setData(props.listId, (prev = []) =>
        prev.map((t) => (t.id === todoId ? { ...t, done: !t.done } : t)),
      )
    },
    mutate: (todoId, { signal, deps }) => deps.api.toggleTodo(todoId, { signal }),
    // Reconcile the guess with the server's record either way.
    onSettled: () => todos.invalidate(props.listId),
  })

  return { toggle }
})
```

The runner commits the snapshot when `mutate` succeeds and rolls it back when it fails (§6.4). Skipping the `cancel` is a bug even when nothing invalidates the query. A stale entry also refetches when a subscriber acquires it and after `resume()`, and that response lands over the patch.

Two rules in `@kontsedal/olas-eslint-plugin` check the shape. [`olas/optimistic-returns-snapshot`](packages/eslint-plugin/docs/optimistic-returns-snapshot.md) reports a `setData` snapshot that nothing settles. [`olas/cancel-before-optimistic`](packages/eslint-plugin/docs/cancel-before-optimistic.md) reports an optimistic `setData` in `onMutate` with no `cancel` before it.

---

## Persisted mutations — survive reloads with `@kontsedal/olas-mutation-queue`

A mutation can hit the network while the user reloads, or while the browser crashes, mid-request. You usually want it to run again on the next page load rather than drop silently. `@kontsedal/olas-mutation-queue` ships `mutationQueuePlugin`. It writes each run of a mutation marked `meta: { persist: true }` to a `StorageAdapter` before the request goes out, and replays pending runs when the root starts and when the browser reconnects.

```ts file=orders.ts
// orders.ts — module scope. `defineMutation` registers `mutate` under `id`,
// so the queue plugin can find it on replay, before any controller exists.
import { defineMutation } from '@kontsedal/olas-core'

export const createOrder = defineMutation({
  id: 'order/create',
  mutate: (vars: { sku: string; idempotencyKey: string }, { signal, deps }) =>
    deps.api.createOrder(vars, { signal }),
  meta: { persist: true },
})
```

```ts
// app entry
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'
import { appController } from './app'
import { deps } from './deps'
import { captureException } from './telemetry'

const root = createRoot(appController, {
  queries: queryEngine(),
  deps,
  plugins: [
    mutationQueuePlugin({
      storage: localStorageAdapter(), // or indexedDbAdapter() for large payloads
      keyPrefix: 'my-app/mutations/v1', // namespace
      maxAttempts: 5, // bound replays per entry
      onReplayError: (err, entry) => {
        // Telemetry or a user-facing toast on a lost mutation.
        captureException(err, { extra: entry })
      },
    }),
  ],
})
```

```ts
// inside a controller
import { createMutation, defineController } from '@kontsedal/olas-core'
import { createOrder } from './orders'
import { toast } from './toast'

const checkoutController = defineController((ctx) => {
  const place = createMutation(ctx, createOrder, {
    onSuccess: () => toast('Order placed'),
    onError: () => toast('We had trouble; we will retry automatically.'),
  })
  return { place }
})
```

**Idempotency** is the consumer's responsibility. Include a stable `idempotencyKey` in your variables (UUID generated at the call site, stored alongside the mutation entry) and have your server dedupe by it. The queue gives **at-least-once-until-success**; without an idempotency key, a reload mid-network-call can result in a double charge.

**`mutate` MUST NOT close over controller state.** On replay there is no controller. The queue runs the registered definition through the core runner, so its `retry` applies and `mutate` receives the root's `deps` in `{ signal, deps }`. Reach services through that `deps`, as `createOrder` does. Module-level constants such as environment-derived URLs are fine too. Anything that lives on a controller, such as a signal or a field, is not.

**Only opted-in mutations replay.** The queue checks the registered definition's `meta.persist` before it replays an entry, so stored data cannot run a mutation that did not opt in. `ctx.inject(MutationQueue).replayNow()` replays the pending entries on demand.

**Adapter capability.** Replay requires an adapter that implements `keys()`. The built-in `localStorageAdapter()` and `indexedDbAdapter()` both do. Custom adapters that implement only `get`, `set` and `delete` work for **enqueue** but **not replay** — the plugin warns and disables the replay path.

---

## Router integration

Use `@kontsedal/olas-router`. `createRouterAdapter()` returns `{ plugin, Bridge }`.
The plugin provides `RouteParamsScope`, `RouteSearchScope` and
`RoutePathnameScope`, and the `Bridge` component pushes the router's state
into those scopes. Works with any client-side router (TanStack Router, React Router v6, or
your own). **Next.js is not supported** — see `BACKLOG.md` for the
philosophy reasoning.

### Setup

```ts file=root.ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { createRouterAdapter } from '@kontsedal/olas-router'
import { appController } from './app'
import { deps } from './deps'

export const adapter = createRouterAdapter()

export const root = createRoot(appController, {
  queries: queryEngine(),
  deps,
  plugins: [adapter.plugin], // provides the three route scopes on the root
})
```

The `Bridge` pushes state in a client-only effect. On the server, seed the adapter from the request instead: `createRouterAdapter({ params, search, pathname })`.

### Bridging — TanStack Router

```tsx
import { OlasProvider } from '@kontsedal/olas-react'
import { useLocation, useParams, useSearch } from '@tanstack/react-router'
import { adapter, root } from './root'
import { YourRoutes } from './routes'

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
import { OlasProvider } from '@kontsedal/olas-react'
import { useLocation, useParams, useSearchParams } from 'react-router-dom'
import { adapter, root } from './root'
import { YourRoutes } from './routes'

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

The `Bridge` shallow-equals the incoming `params` and `search` records, so
fresh-object-every-render (the typical router pattern) doesn't churn
downstream consumers.

### Consume in any controller

<!-- snippet-prelude
import type { Query } from '@kontsedal/olas-core'
type User = { id: string; name: string }
declare const userQuery: Query<[userId: string], User>
-->
```ts
import { createQuery, defineController } from '@kontsedal/olas-core'
import { RouteParamsScope } from '@kontsedal/olas-router'

const profileController = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const user = createQuery(ctx, userQuery, {
    key: () => [params.value.userId ?? ''],
    enabled: () => params.value.userId !== undefined,
  })
  return { user }
})
```

`createQuery`'s key thunk reads `params.value` — route changes auto-rekey
the subscription. No effects, no manual subscriptions. A param is
`string | undefined`, because an optional segment can be absent, and
`enabled` keeps the query idle until the route has a `userId`.

### Pattern B — controller-per-route via `ctx.attach`

For "the whole controller tree under a route changes when the user navigates," attach the page controller with `ctx.attach` and swap it when the route key changes. The old page's subscriptions tear down, and the new page's boot.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const profilePageController: ControllerDef<{ userId: string }, { userId: string }>
-->
```ts
import { type CtrlApi, defineController, signal, untracked } from '@kontsedal/olas-core'
import { RouteParamsScope } from '@kontsedal/olas-router'

type PageApi = CtrlApi<typeof profilePageController>

const appController = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const page = signal<PageApi | null>(null)
  let current: { userId: string; dispose: () => void } | null = null

  ctx.effect(() => {
    const userId = params.value.userId
    // `resume()` re-runs effects, so keep the page while the key holds.
    if (userId === current?.userId) return
    untracked(() => {
      current?.dispose()
      current = null
      page.set(null)
      if (userId === undefined) return
      const attached = ctx.attach(profilePageController, { userId })
      current = { userId, dispose: attached.dispose }
      page.set(attached.api)
    })
  })

  return { page }
})
```

`ctx.attach(def, props)` builds a child controller and returns `{ api, dispose, suspend, resume }`. The effect tracks `params` alone: `untracked` keeps the page factory's own signal reads out of it. The parent's disposal disposes the attached page, so the effect needs no cleanup. For routes whose key derives from path *and* search params, the effect reads both and swaps on either changing.

### Pattern C — pre-fetching on route enter

Use the router's loader and `beforeLoad` hook to prefetch — the data lands in the cache before the component mounts, so `createQuery` returns it synchronously. (See "structural sharing" in §6 of `SPEC.md` for the ref-stability guarantees this gives you.)

Prefetch through `root.bindQuery(query)` rather than the bare definition, so the fetch lands in *this* root's cache:

<!-- snippet-prelude
import type { Query } from '@kontsedal/olas-core'
type User = { id: string; name: string }
declare const userQuery: Query<[userId: string], User>
declare function createRoute(options: {
  path: string
  loader: (args: { params: { userId: string } }) => unknown
}): unknown
-->
```tsx
import { root } from './root'

// TanStack Router route definition
const userRoute = createRoute({
  path: '/users/$userId',
  loader: ({ params }) => root.bindQuery(userQuery).prefetch(params.userId),
})
```

On the client there is usually one root, and the bare `userQuery.prefetch(...)` still works. The bound form is the one that survives SSR. A server handling concurrent requests has a root per request, and an unbound prefetch there rejects rather than guessing whose cache to warm.

Combined with `useQuery(sub, { suspense: true })`, the suspense fallback is skipped because data is already in cache by the time React reads it.

---

## Server rendering — one root per request

A server handling concurrent requests builds one root per request, so no request reads another's cache. The client builds its own root with `queries: queryEngine()` and seeds it with the server's state (§15).

### Render, then inline the state

```tsx
// server.tsx
import { createRoot, queryEngine, serializeForScript } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { renderToString } from 'react-dom/server'
import { App } from './App'
import { appController } from './app'
import { createDeps } from './deps'

export async function render(request: Request): Promise<string> {
  const root = createRoot(appController, { queries: queryEngine(), deps: createDeps(request) })
  await root.waitForIdle()
  const html = renderToString(
    <OlasProvider root={root}>
      <App />
    </OlasProvider>,
  )
  const state = serializeForScript(root.dehydrate())
  root.dispose()
  return `<div id="app">${html}</div><script>window.__OLAS_STATE__ = ${state}</script>`
}
```

`serializeForScript` writes the state as `JSON.parse("…")` over a fully escaped string. Query data containing `</script>` cannot end the tag, and a `__proto__` key stays an own property.

```tsx
// client.tsx
import { createRoot, type DehydratedState, queryEngine } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'
import { App } from './App'
import { appController } from './app'
import { clientDeps } from './deps'

const state = (window as { __OLAS_STATE__?: DehydratedState }).__OLAS_STATE__
const root = createRoot(appController, { queries: queryEngine(), deps: clientDeps, hydrate: state })

hydrateRoot(
  document.getElementById('app') as HTMLElement,
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

A client root without `queries` has no cache to seed. It discards the payload, and development builds warn.

### Streaming

`createStreamingHydrator` sends each query's data as it resolves, rather than after the slowest one. Its plugin records the server root's writes, and `createStreamingTransform` writes them into React's stream:

```tsx
// server.tsx — Web Streams: Node, Deno, Workers
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import {
  createStreamingHydrator,
  createStreamingTransform,
  OLAS_BOOTSTRAP_SCRIPT,
  OlasProvider,
} from '@kontsedal/olas-react'
import { renderToReadableStream } from 'react-dom/server'
import { App } from './App'
import { appController } from './app'
import { createDeps } from './deps'

export async function handle(request: Request): Promise<Response> {
  const nonce = crypto.randomUUID()
  const { plugin, flush } = createStreamingHydrator({ nonce })
  // One root per request. On the server, render it through OlasProvider: a
  // HydrationBoundary disposes its root in an effect, and effects never run here.
  const root = createRoot(appController, {
    deps: createDeps(request),
    queries: queryEngine(),
    plugins: [plugin],
  })
  const stream = await renderToReadableStream(
    <OlasProvider root={root}>
      <App />
    </OlasProvider>,
    { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT, nonce },
  )
  return new Response(stream.pipeThrough(createStreamingTransform(flush)), {
    headers: {
      'content-type': 'text/html',
      'content-security-policy': `script-src 'nonce-${nonce}'`,
    },
  })
}
```

Three details keep the stream safe (§22):

- **The transform writes only between elements.** React writes its stream in fixed-size chunks, so a chunk can end inside a tag or an attribute value. A `<script>` written there breaks the markup, and query data can inject attributes. The transform holds each batch until the HTML so far ends between elements.
- **The payload goes through `serializeForScript`**, as in the one-shot render.
- **The `nonce` goes on every script.** The hydrator puts it on its own `<script>` tags, and `renderToReadableStream` puts it on React's, so a `script-src 'nonce-…'` policy admits both.

For that first reason, do not call `flush()` from a hand-written Node `Transform` after each chunk. With `renderToPipeableStream`, render with `renderToReadableStream` instead and pipe through the transform, or write `flush()` only after the stream has ended.

```tsx
// client.tsx
import { queryEngine } from '@kontsedal/olas-core'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'
import { App } from './App'
import { appController } from './app'
import { clientDeps } from './deps'

// <App /> renders the whole document, <html> included, as it did on the server.
hydrateRoot(
  document,
  <HydrationBoundary def={appController} options={{ deps: clientDeps, queries: queryEngine() }}>
    <App />
  </HydrationBoundary>,
)
```

`OLAS_BOOTSTRAP_SCRIPT` queues the batches that arrive before React hydrates. `HydrationBoundary` drains the queue into its root when it mounts, then applies each later batch as it arrives.

---

## `readsFactory` — one query, many React readers that own no controller

`useQuery(subscription)` reads a subscription; it cannot *create* one. Only a controller can, through `createQuery`, and that is deliberate. A component that mints its own cache subscription owns data lifetime, which is the thing Olas exists to move out of the view. That leaves one real shape unaddressed: a **React context or hook** that needs server data and has no controller of its own. Theme providers, feature-flag gates, keybinding overrides, "current user" wrappers — all of them read one query and render children.

The pattern: a controller owns the subscriptions, exposes them as a plain object, and React reads them **by identity**.

```ts file=reads.ts
// reads.ts — a reusable composable (spec §3.3), not a controller
import { type Ctx, createQuery } from '@kontsedal/olas-core'
import { flagsQuery, themeQuery } from './queries'

export function createAppReads(ctx: Ctx) {
  return {
    theme: createQuery(ctx, themeQuery),
    flags: createQuery(ctx, flagsQuery),
  }
}
export type AppReads = ReturnType<typeof createAppReads>
```

```ts file=app.controller.ts
// app.controller.ts — the root (or any long-lived controller) owns them
import { type CtrlApi, defineController } from '@kontsedal/olas-core'
import { createAppReads } from './reads'

export const appController = defineController((ctx) => ({
  reads: createAppReads(ctx),
  // ...the rest of the root's api
}))
export type AppApi = CtrlApi<typeof appController>
```

```tsx
// ThemeProvider.tsx — a context that reads, and owns nothing
import { useQuery, useRoot } from '@kontsedal/olas-react'
import { createContext, type ReactNode } from 'react'
import type { AppApi } from './app.controller'
import type { Theme } from './queries'

export const ThemeContext = createContext<Theme | undefined>(undefined)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useRoot<AppApi>().reads
  const { data, isLoading } = useQuery(theme)
  if (isLoading) return null
  return <ThemeContext.Provider value={data}>{children}</ThemeContext.Provider>
}
```

An app that registers its root through `Register` (see the React README) can drop the type argument and call `useRoot()`.

Three properties make this worth the indirection:

- **One entry, one fetch.** Every reader goes through the same subscription, so N providers reading the same query dedupe to one fetch and one cache entry. N components each minting a subscription would instead each hold a reference.
- **Lifetime is the controller's.** The subscription lives and dies with the controller that owns it, not with whichever component mounted first. A provider that unmounts and remounts (a route change, a StrictMode double-mount) re-reads a warm entry instead of re-acquiring one.
- **It survives the reader moving.** When the provider eventually becomes a controller itself, the factory does not change — only who calls it.

Two roots can share the same provider, such as a main window and a detached one. Have **both** roots expose the factory under the same key, and `useRoot()` resolves to whichever root the component is mounted under. And keep the factory to reads that a React *provider* owns — a read belonging to one feature belongs in that feature's controller, where `createQuery` is already available.

---

## When to lift to a package

If a composable ends up:

- Used in ≥3 unrelated controllers in your codebase, or
- Has its own meaningful tests, or
- Encapsulates non-trivial async/timing logic that would be easy to get wrong,

…then it belongs in its own file (or a shared internal `composables/` directory). Resist publishing to npm unless someone else asks — composables are easy to copy, and divergence is fine.
