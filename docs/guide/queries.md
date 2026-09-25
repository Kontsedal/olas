# Queries

A query gives a controller server data as signals. Every controller that asks for the same key shares one cache entry and one request. Only the latest fetch for an entry lands, and the cache refetches on the triggers you opt into. The loading, error and staleness state is ten signals, so a test reads it without a renderer.

This page walks through the query layer in the order you meet it. Full signatures are in the [API reference](/reference/olas-core), and the contract is SPEC [§5](https://github.com/Kontsedal/olas/blob/main/SPEC.md#5-caches--queries).

## The model

Three pieces take part in every query:

```text
defineQuery (module scope)       createQuery(ctx, …)            the root's query client
  id, key, fetcher, policy  ──►  AsyncState signals   ──bind──►  one entry per key hash
  a description, no data         one per controller               one fetch, shared
```

- **The definition** lives at module scope. `defineQuery` describes how to fetch and how long the data stays fresh. It holds no data.
- **The subscription** comes from `createQuery(ctx, query, key)` inside a controller. It is an `AsyncState<T>`: signals for `data`, `status` and the flags, plus four actions. The controller owns it, and disposing the controller releases it.
- **The entry** lives on the root's query client. Two subscribers to one key share it, and the fetcher runs once per key however many subscribe (§5.1). Each root has its own client, so two roots do not share data.

## Give the root a query engine

A root has no cache until you pass it a query engine. Without one, `createQuery`, `createMutation` and `bindQuery` throw an error that names the fix.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
import type { Api } from './api'
declare const app: ControllerDef<void, unknown>
declare const api: Api
-->
```ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'

const root = createRoot(app, { deps: { api }, queries: queryEngine() })
```

`queryEngine()` is a definition, not an instance. Each root that adopts it builds its own client, so one engine value can serve several roots.

## Define a query

The examples on this page share one service, typed once through `AmbientDeps` so every fetcher sees `deps.api`:

```ts file=api.ts
// api.ts: the app's services, typed once for every fetcher and controller
type Options = { signal: AbortSignal }

export type User = { id: string; name: string }
export type Session = { userId: string }
export type Post = { id: string; title: string }
export type FeedPage = { items: Post[]; nextCursor: string | null }

export type Api = {
  getUser(id: string, options: Options): Promise<User>
  getSession(options: Options): Promise<Session>
  getFeed(channel: string, cursor: string | null, options: Options): Promise<FeedPage>
  getStats(userId: string, options: Options): Promise<{ posts: number }>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
  }
}
```

```ts file=queries.ts
import { defineQuery } from '@kontsedal/olas-core'

export const userQuery = defineQuery({
  id: 'users/detail',
  key: (id: string) => ['user', id],
  fetcher: ({ signal, deps }, id) => deps.api.getUser(id, { signal }),
  staleTime: 30_000,
})
```

- **`id`** is required, and `defineQuery` throws without it. It names the query in SSR payloads, plugin events, devtools and error contexts. Write it by hand: a name derived from `fetcher.name` changes under minification, and the server and client bundles must agree on it (§5.2).
- **`key(...args)`** turns the arguments into the cache key. The client hashes its output, and the same hash means the same entry. The hash follows what JSON would carry, so the key survives an SSR payload (§5.4). An `undefined` member counts as absent, a Date as its ISO string, and `NaN` as `null`.
- **`fetcher(ctx, ...args)`** receives the fetch context `{ signal, deps }` first, then the original arguments. Pass `signal` to your I/O so an aborted fetch stops the request. [`olas/honor-abort-signal`](https://github.com/Kontsedal/olas/blob/main/packages/eslint-plugin/docs/honor-abort-signal.md), in the lint plugin's `strict` config, reports a fetcher that does not.

The fetcher gets the arguments you passed, not the output of `key`. Here it receives `'u1'`, while the hash is built from `['user', 'u1']`. The [callArgs vs keyArgs pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/callargs-vs-keyargs.md) records the bug that confusion caused once.

## Subscribe from a controller

```ts file=user-card.ts
import { createQuery, defineController, signal } from '@kontsedal/olas-core'
import { userQuery } from './queries'

export const userCard = defineController((ctx, props: { userId: string }) => {
  const selected = signal(props.userId)
  const user = createQuery(ctx, userQuery, () => [selected.value])
  return { user, select: (id: string) => selected.set(id) }
})
```

The third argument is one thunk that returns the arguments as a tuple (§5.4). The thunk is tracked. When `selected` changes, the subscription releases the old entry and acquires the new one. The old entry stays cached for `gcTime` after its last subscriber leaves, so switching back shows its data at once. A query with no arguments needs no thunk: `createQuery(ctx, todosQuery)`.

When the new key has nothing cached, `data` reads `undefined` until it loads. Set `keepPreviousData: true` on the query to keep showing the previous entry's data meanwhile. `isFetching` is then `true`, and `isLoading` stays `false`. `keepPreviousData` covers key changes only. A subscription whose `enabled` gate is closed still reads `undefined`, unless it sets `keepDataWhileDisabled`.

## Read the state

A subscription is an [`AsyncState<T>`](/reference/olas-core.asyncstate). Every field is a read-only signal:

| Signal | Meaning |
|---|---|
| `data` | The latest value, or `undefined` before the first success. |
| `error` | The latest failure, or `undefined`. |
| `status` | `'idle'`, `'pending'`, `'success'` or `'error'`. It reads `'pending'` during a background refetch too, while `data` stays. |
| `isLoading` | A first load is in flight and there is no data yet. Gate spinners on it. |
| `isFetching` | Any fetch is in flight, background refetches included. Gate progress bars on it. |
| `isStale` | `staleTime` has passed since the last success. |
| `lastUpdatedAt` | Epoch ms of the last success. |
| `hasPendingMutations` | An optimistic write on this entry has not settled yet. See [Mutations](/guide/mutations#optimistic-updates). |
| `isPaused` | A fetch is parked until the network returns. |
| `isEnabled` | `false` while the subscription's `enabled` gate is closed. |

Four actions sit beside them. `refetch()` fetches regardless of staleness and resolves with the value. `reset()` clears `error` and settles `status` without fetching. `cancel()` aborts the fetch in flight and keeps `data`. `firstValue()` resolves with the data at once when there is some, and otherwise on the first success. That makes it the promise for Suspense, React 19's `use(...)` and navigation guards.

In React, `useQuery(sub)` returns every field as a plain value and re-renders only for the fields the component read. See [the React adapter](/adapters/react#usequery-re-renders-for-what-the-component-reads). The [Vue](/adapters/vue) `useQuery` returns refs, and the [Svelte](/adapters/svelte) `queryStore` returns a store.

## Wait for another value: `enabled`

A dependent query waits for its input. Pass an options object with `enabled`, a tracked thunk:

```ts
import { createQuery, defineController, defineQuery } from '@kontsedal/olas-core'
import { userQuery } from './queries'

const sessionQuery = defineQuery({
  id: 'session',
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.getSession({ signal }),
})

export const header = defineController((ctx) => {
  const session = createQuery(ctx, sessionQuery)
  const me = createQuery(ctx, userQuery, {
    key: () => [session.data.value!.userId],
    enabled: () => session.data.value !== undefined,
  })
  return { session, me }
})
```

The key thunk runs only once `enabled` returns `true`, so the non-null assertion above is safe. While the gate is closed, the subscription holds no entry and fetches nothing (§5.2):

- `status` is `'idle'`, `data` is `undefined`, and `isEnabled` is `false`.
- `refetch()` rejects with [`QueryDisabledError`](/reference/olas-core.querydisablederror), which carries the `queryId`. A Retry button can disable itself on `isEnabled` instead.
- `firstValue()` waits until the gate opens and the entry loads. A suspense view over a dependent query therefore suspends until its input arrives.

Closing the gate releases the entry without disposing it. A re-enable inside `gcTime` reuses the cached data. Add `keepDataWhileDisabled: true` to keep reporting the last `data` while the gate is closed, for views that would otherwise flash empty. `error` is not kept, and `status` stays `'idle'`. The [disabled-subscriptions decision](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/disabled-subscriptions.md) records why the subscription waits rather than rejecting.

## Project the data: `select`

<!-- snippet-prelude
import { createQuery, defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'
-->
```ts
export const userName = defineController((ctx, props: { userId: string }) => {
  const name = createQuery(ctx, userQuery, {
    key: () => [props.userId],
    select: (user) => user.name,
  })
  return { name } // name.data is a ReadSignal<string | undefined>
})
```

The projection runs per subscriber, and the cache keeps the raw value. It re-runs only when the raw value's reference changes, which structural sharing keeps rare (see [below](#structural-sharing)).

## Freshness: `staleTime`, `gcTime` and refetch triggers

| Setting | Default | Effect |
|---|---|---|
| `staleTime` | `0` | How long a success stays fresh. A subscriber that acquires a stale entry starts a fetch. |
| `gcTime` | 5 min | How long an entry with no subscribers survives before the client drops it. |
| `refetchInterval` | off | A background refetch while subscribed: a fixed gap in ms, or a thunk over the latest data. |
| `refetchOnWindowFocus` | `false` | Refetch a subscribed, stale entry when the window regains focus. |
| `refetchOnReconnect` | `false` | Refetch a subscribed, stale entry when the browser comes back online. |
| `retry` | `0` | Retries after a failure: a count, `false` for none, or `(attempt, error) => boolean`. |
| `retryDelay` | exponential | Backoff in ms. Without it, the delay doubles from 1 s and caps at 30 s. |

The defaults are quieter than TanStack Query's, because surprise refetches are a common source of bugs (§5.9). `Infinity` is a valid `staleTime` or `gcTime`, and it means no expiry. A retried fetch counts as one fetch for `isFetching` and for race protection, and an abort cancels the whole retry chain. A `retry` or `retryDelay` callback that throws fails the fetch with its own error. When an invalidation reports that failure to the root's `onError`, the fetch error travels as `cause`.

`refetchInterval` as a thunk polls fast while there is work and slowly when idle:

```ts
import { defineQuery } from '@kontsedal/olas-core'

type Job = { id: string; state: 'queued' | 'running' | 'done' }

export const jobsQuery = defineQuery({
  id: 'jobs/list',
  key: () => [],
  fetcher: ({ signal }) => fetch('/api/jobs', { signal }).then((r) => r.json() as Promise<Job[]>),
  refetchInterval: (jobs) => (jobs?.some((j) => j.state === 'running') ? 1_000 : 30_000),
})
```

The client resolves the thunk once per tick, for the next gap. Its first call comes at subscribe time, before the first fetch settles, so it can receive `undefined`. Reading a signal inside it registers no dependency. A gap of `0`, `NaN`, a negative number or `Infinity` stops the timer with a development warning. The timer belongs to the shared entry, so ten subscribers on one key share one interval. A tick is skipped while the tab is hidden.

### App-wide defaults

`queryEngine({ defaults })` sets policy once for every query, infinite query and `createCache` under the root:

```ts
import { queryEngine } from '@kontsedal/olas-core'

export const queries = queryEngine({
  defaults: { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: true },
})
```

Resolution is `spec.X ?? defaults.X ?? built-in`, so a field on the query wins over the default. `refetchInterval` cannot be a default, because a root-wide interval would poll every query in the app. See [`QueryDefaults`](/reference/olas-core.querydefaults) for the list.

## Invalidate after a change

`userQuery.invalidate('u1')` marks one entry stale and refetches it if it has subscribers. `invalidateAll()` does the same for every entry of the query. An entry without subscribers is only marked stale, and its next subscriber fetches it. Both return a promise that resolves when the refetches they started settle. A failed refetch lands on the entry's `error` signal and the root's `onError`, and the promise still resolves (§5.7).

An invalidation often catches up on what the app missed, such as a reconnect's `invalidateAll()`. When a `replace` lands while that refetch is in flight, it discards the response, and the entry fetches once more to reconcile. The promise resolves when that catch-up settles. Further `replace` calls during the catch-up leave it in flight, so a burst of pushes cannot keep it from landing (§6.4).

Mutations are the usual caller. [Mutations](/guide/mutations) shows `invalidate` in an `onSuccess` hook.

### Bound and unbound handles

The methods on the query value are unbound. They act on the one root that has used the query. While a second root is also using it, an unbound call throws or rejects as ambiguous. A server that renders concurrent requests, one root each, reaches that state under load. Bind the query to a root instead:

```ts
import { bindQuery, defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

export const userMenu = defineController((ctx) => {
  const users = bindQuery(ctx, userQuery) // this controller's root, and only it
  return {
    refresh: (id: string) => users.invalidate(id),
    warm: (id: string) => users.prefetch(id),
  }
})
```

Outside a controller, `root.bindQuery(userQuery)` returns the same handle, for example to prefetch on the server before rendering. Binding neither subscribes nor fetches. A bound operation fails once its root is disposed. Library code and anything that may run under SSR should bind.

## Read and write the cache directly

A bound or unbound handle reaches an entry without subscribing:

| Method | What it does |
|---|---|
| `peek(...args)` | Returns the cached value synchronously, or `undefined`. It creates no entry, fetches nothing and registers no reactive dependency. |
| `setData(...args, updater)` | An optimistic patch that returns a `Snapshot` to settle. It belongs inside a mutation's `onMutate`. |
| `write(...args, updater)` | A canonical patch. It pushes no snapshot and leaves a fetch in flight alone. |
| `replace(...args, value)` | A canonical whole value. It supersedes a fetch in flight for the key. |
| `cancel(...args)`, `cancelAll()` | Abort fetches in flight and keep `data`. |
| `prefetch(...args)` | Fetches into the cache without subscribing. It joins a fetch in flight, and rejects with an `AbortError` when a `cancel()` leaves no data. |

The three writes make different claims, so they behave differently (§6.4). `setData` is a guess that a mutation may undo. `write` is true about the fields it touches and silent about the rest, so a response already on its way may still carry newer values. `replace` asserts the whole record, so an earlier request has nothing left to add. The [canonical-vs-optimistic decision](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/canonical-vs-optimistic-writes.md) records how the split was reached.

```ts
import { bindQuery, defineController } from '@kontsedal/olas-core'
import type { User } from './api'
import { userQuery } from './queries'

export const userSync = defineController((ctx) => {
  const users = bindQuery(ctx, userQuery)
  return {
    // A push that carries one field: patch it, if the user is cached at all.
    onRenamed: (id: string, name: string) => {
      if (users.peek(id) === undefined) return
      users.write(id, (prev) => ({ ...prev!, name }))
    },
    // A push that carries the whole record: replace it.
    onUpdated: (user: User) => users.replace(user.id, user),
  }
})
```

Use `write` or `replace` for data that is already true, such as a server push or a realtime event. A `setData` with no mutation to settle it leaves a live snapshot behind on every call, and `hasPendingMutations` stays `true` for the rest of the entry's life.

## Controller-local data: `createCache`

When one controller wants async data that nothing else will share, `createCache` skips the module-scope definition:

```ts
import { createCache, defineController } from '@kontsedal/olas-core'

export const statsPanel = defineController((ctx, props: { userId: string }) => {
  const stats = createCache(ctx, ({ signal, deps }) => deps.api.getStats(props.userId, { signal }), {
    staleTime: 60_000,
  })
  return { stats, refresh: () => stats.invalidate() }
})
```

A local cache is the same `AsyncState` plus `invalidate()` and the three writes a query has: `setData()`, `write()` and `replace()`, with the rules [below](#read-and-write-the-cache-directly). It stays out of the root's query client, and it needs no query engine. Its fetches still count toward `root.waitForIdle()`. It still reads the engine's `staleTime` and `keepPreviousData` defaults when the root has one. Its `key` option takes a tracked thunk that refetches on change. It has no `refetchInterval`, no id and no plugin integration. If sharing may come later, start with `defineQuery` and save the refactor (§5.10).

## Infinite queries

`defineInfiniteQuery` accumulates pages for feeds and chat history:

```ts file=feed.ts
import { defineInfiniteQuery } from '@kontsedal/olas-core'
import type { FeedPage } from './api'

export const feedQuery = defineInfiniteQuery({
  id: 'feed/list',
  key: (channel: string) => ['feed', channel],
  fetcher: ({ pageParam, signal, deps }, channel) =>
    deps.api.getFeed(channel, pageParam, { signal }),
  initialPageParam: null as string | null,
  getNextPageParam: (last: FeedPage) => last.nextCursor,
  itemsOf: (page: FeedPage) => page.items,
})
```

```ts
import { createQuery, defineController } from '@kontsedal/olas-core'
import { feedQuery } from './feed'

export const feed = defineController((ctx, props: { channel: string }) => {
  const posts = createQuery(ctx, feedQuery, () => [props.channel])
  const more = () => (posts.hasNextPage.value ? posts.fetchNextPage() : Promise.resolve())
  return { posts, more }
})
```

The subscription is an `AsyncState` of the pages array, plus `pages`, `flat`, `hasNextPage`, `hasPreviousPage`, `isFetchingNextPage`, `isFetchingPreviousPage`, `fetchNextPage()` and `fetchPreviousPage()`. `flat` holds the items that `itemsOf` pulls out of each page, and equals `pages` without it. `getPreviousPageParam` makes the list bidirectional.

- `getNextPageParam` returns `null` to say there are no more pages. `hasNextPage` compares against `null`, so an `undefined` return counts as a next page. Write `?? null` when your cursor can be missing.
- A refetch reloads every loaded page in order, from `initialPageParam`, and swaps them in at the end (§5.11). A list scrolled 20 pages deep costs 20 requests per invalidation or interval tick.
- An infinite query has the regular query's integrations. It dehydrates for [SSR](/guide/ssr) with its page params, so the client continues paging where the server stopped. It honours focus and reconnect refetch and the `offlineFirst` park. It has `peek`, `write`, `replace`, `cancel` and `cancelAll` over the pages array.

In React, `useInfiniteQuery(sub)` reads it with `useQuery`'s rules.

## Offline behaviour: `networkMode`

| `networkMode` | A fetch requested while `navigator.onLine` is `false` |
|---|---|
| `'online'` (default) | Is deferred, reports `isPaused: true`, and runs on reconnect. |
| `'always'` | Runs anyway. Use it for localhost, IPC and service-worker sources. |
| `'offlineFirst'` | Runs anyway. A network-shaped failure while offline parks the entry at `isPaused: true` and retries on reconnect. |

A network-shaped failure is a `fetch` `TypeError`. An `AbortError` does not count. While parked, nothing is in flight and `status` stays at `idle` or the last success. The UI can therefore show "waiting for network" apart from the spinner and the error (§5.5).

## Structural sharing

The client compares every successful fetch against the entry's previous data (`structuralShare`, default `true`). Wherever a subtree is unchanged, the entry keeps the old reference. A refetch that returns the same payload leaves `data` identical under `===`, and no `computed` or component downstream re-runs. The walk covers plain objects and arrays. It replaces a `Map`, `Set`, `Date` or class instance whole. Set `structuralShare: false` on a query with a very large payload, where the walk on every refetch costs more than the re-render it saves.

## Sharp edges

- **The fetcher gets the arguments, and the hash gets the key.** A `key` that adds a prefix or drops an argument changes the hash only.
- **`isStale` is timer-driven.** A signal derived from `Date.now()` would not update as time passes, so the entry flips `isStale` on a timer. The [isStale pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/isstale-needs-timer.md) has the details.
- **A stale entry fetches without any invalidator.** A new subscriber, a second root and a `resume()` each start a fetch on a stale entry. An optimistic `setData` needs a `cancel` first even when nothing calls `invalidate` (§5.5).
- **An unbound call with no root yet does nothing.** `invalidate`, `write` and `peek` have no client to act on, and `setData` returns an inert snapshot. `prefetch` throws and names `root.bindQuery`.
- **`undefined` means "nothing here".** `peek`, `firstValue` and `replace` read `undefined` as no data, so `replace(..., undefined)` does not supersede a fetch in flight.

## See also

- Reference: [`defineQuery`](/reference/olas-core.definequery), [`createQuery`](/reference/olas-core.createquery), [`QuerySpec`](/reference/olas-core.queryspec), [`Query`](/reference/olas-core.query), [`bindQuery`](/reference/olas-core.bindquery), [`createCache`](/reference/olas-core.createcache), [`defineInfiniteQuery`](/reference/olas-core.defineinfinitequery) and [`queryEngine`](/reference/olas-core.queryengine).
- [Recipes](/guide/recipes): a debounced search key, pagination, realtime patches and server rendering.
- [SSR](/guide/ssr) for `dehydrate`, `hydrate` and `waitForIdle`.
- [Mutations](/guide/mutations) for the write side.
