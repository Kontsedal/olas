---
name: query-client
description: Per-root entry registry. Owns the maps, gcTime, mutationsInflight$, dehydrate/hydrate/waitForIdle.
type: entity
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/query/focus-online.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-focus-online.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: uses, target: entry.md }
  - { type: uses, target: ../decisions/per-root-query-client.md }
  - { type: related, target: ../pitfalls/callargs-vs-keyargs.md }
last_verified: 2026-05-19
confidence: high
---

# `QueryClient`

One per root (`createRoot` instantiates it; the root's `dispose` disposes it). Holds the entry registry, GC timers, refetch-interval timers, mutation-inflight counter, and the dehydrate/hydrate/waitForIdle implementations. Spec §5.1, §21.4, §21.5.

## Two maps, two entry types

```ts
maps:         Map<AnyQuery,         Map<keyHash, ClientEntry<T>>>
infiniteMaps: Map<AnyInfiniteQuery, Map<keyHash, InfiniteClientEntry>>
```

Why two? Regular and infinite queries differ enough (single `data` vs array of `pages`, `fetchNextPage` mechanic) that a unified entry would be more confusing than two parallel paths. They share the AsyncState shape via `Entry`/`InfiniteEntry`'s common signals.

## ClientEntry vs Entry

`Entry<T>` is the state machine. `ClientEntry<T>` wraps it and adds the **per-root** stuff:

- `subscriberCount` — incremented by `acquire()`, decremented by `release()`.
- `gcTimer` — started on `release()` when count hits zero; cleared on `acquire()`. Fires `client.dropEntry(this)`.
- `intervalTimer` — runs `entry.startFetch()` every `refetchInterval` ms while subscribers exist.
- `unsubFocus` / `unsubOnline` — `window` focus and `online` subscriptions, installed on the 0→1 acquire transition when the resolved flag is `true`. Resolution: `spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus ?? false` (and same for reconnect) — per-query spec wins, root-wide default fills in, otherwise off. Cleared on release-to-zero and on dispose. The handler skips refetch if `entry.isStaleNow()` is false, so a freshly-fetched query within `staleTime` ignores the focus event. The window/document listeners themselves live in `query/focus-online.ts` as a lazy single-listener pubsub, shared across all clients and SSR-safe.
- `callArgs` and `keyArgs` — separately stored. `callArgs` is fed to the fetcher. `keyArgs = spec.key(...callArgs)` is hashed for identity. See `../pitfalls/callargs-vs-keyargs.md`.

## Cross-root query operation

A `Query` is module-scoped. When `bindEntry` runs on this client for that query, the client adds itself to `query.__clients`. On dispose, the client removes itself from every `touchedQueries`. So `query.invalidate(...)` reaches exactly the live clients, no GC concerns. See `../decisions/per-root-query-client.md`.

## Mutation inflight counter

`mutationsInflight$: Signal<number>` lives on the client (not on individual mutations). `MutationImpl` receives a reference and `.update(n => n+1)` on each `executeRun` start, `.update(n => n-1)` on settle (in `finally`). `waitForIdle()` waits for this AND for all per-entry `isFetching` flags. Initial implementation in `client.ts:200-260`.

## SSR

`dehydrate()`: iterate `maps`, emit `{ key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'`. Skip infinite queries and error/idle. `hydrate(state)` populates `hydratedData: Map<keyHash, { data, lastUpdatedAt }>`. `bindEntry` checks `hydratedData` on first bind for a key and threads the values into the new Entry's `initialData` / `initialUpdatedAt`. Consumed once — subsequent rebinds refetch normally. See `../flows/ssr.md`.

## What `dispose()` does

Disposes every `ClientEntry`/`InfiniteClientEntry` (clearing their timers and aborting their Entry). Clears both maps and `hydratedData`. Removes the client from every touched query's `__clients` set. Sets `disposed: true`.
