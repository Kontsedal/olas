---
name: infinite-query-parity
description: How infinite queries reached parity with regular ones for 1.0 — pageParams on dehydrated entries and write events, hydration seeding, focus/reconnect, the offlineFirst park, cross-tab, devtools.
type: decision
covers:
  - packages/core/src/query/infinite.ts
  - packages/core/src/query/client.ts
  - packages/core/src/query/types.ts:122-151
  - packages/core/src/plugin/types.ts
  - packages/react/src/streaming.ts
  - packages/cross-tab/src/plugin.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/infinite-parity.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-rebase.test.ts }
  - { type: tested-by, target: ../../packages/react/tests/streaming.test.tsx }
  - { type: tested-by, target: ../../packages/cross-tab/tests/plugin.test.ts }
  - { type: uses, target: ../modules/query.md }
  - { type: related, target: ../flows/ssr.md }
last_verified: 2026-09-25
confidence: medium
---

# Infinite queries do what regular queries do

Before 1.0, an infinite query did not dehydrate, ignored `refetchOnWindowFocus` and `refetchOnReconnect`, surfaced an offline error in `offlineFirst` mode, could not cross tabs, and was invisible on the devtools timeline. Each gap was a BACKLOG item. 1.0 closes all five.

## `pageParams` travel with the pages

An infinite entry's state is two aligned arrays, `pages` and `pageParams`. Every path that copies that state out of one entry and into another now carries both:

- `DehydratedEntry.pageParams?: readonly unknown[]` (`packages/core/src/query/types.ts`). When present, the entry is an infinite query's and `data` holds its pages.
- `WriteEvent.pageParams?` (`packages/core/src/plugin/types.ts`). The client adds it to every write of an infinite entry through `emitInfiniteWrite`. The streaming hydrator, cross-tab, and a cache-persistence plugin all need it.
- `QueryHost.write` and `replace` take `{ pageParams }`, and `InfiniteEntry.setData(…, { pageParams })` uses them when their length matches the new pages. Otherwise the params are trimmed or padded, as before.

**Why an optional field, not a discriminated `kind`.** The payload is still `version: 1`, and a regular entry's shape does not change. The client knows each query's kind from its `id`, so the field only has to supply what the regular shape lacks.

**The payload is validated before it seeds anything** (`infinitePayload` in `client.ts`). `data` must be an array, `pageParams` an array of the same length, and neither empty. Anything else under an infinite query's id is ignored, and the entry fetches for itself, so a stale or regular-shaped payload cannot put the cursors out of line.

**The params are bookkeeping, today.** `fetchNextPage` and `fetchPreviousPage` derive the next param from the page data through `getNextPageParam`, and a refetch re-derives every param from page one. The stored params keep a dehydrate, a persisted cache or a cross-tab relay faithful to the entry. They are also what lets a future param-driven refetch work. The cross-tab test pins that the receiver stores the sender's params, `[0, 1, 2]`; padding its own would have given `[0, 0, 0]`.

## Hydration

`bindInfiniteEntry` adopts a buffered payload the way `bindEntry` does, and reports one `'hydrate'` write. `InfiniteEntry` seeds `pages`, `pageParams`, `status: 'success'` and `lastUpdatedAt` in its constructor, and derives `isStale` from the payload's real age (`settleStaleness`). A payload for an entry that is already bound goes through `InfiniteEntry.applyHydration`. That supersedes the fetch in flight, as `Entry.applyHydration` does.

## Focus, reconnect and `offlineFirst`

- **Focus and reconnect.** `InfiniteClientEntry` subscribes on its first `acquire`, reading the spec field or the engine default. A focus or reconnect refetch re-fetches every loaded page, because that is what an infinite refetch is (T3.7).
- **The `offlineFirst` park.** A network-shaped failure (`TypeError`) while offline parks the fetch, in `runRefetchAll` and in `runFetch` alike, instead of surfacing an error. `settleParked` clears the fetching flags and keeps the loaded pages. The drain re-runs the parked direction on reconnect. A parked refetch re-runs whole: the pages it had already fetched are dropped, because a partial refetch would mix fresh pages with stale ones.

## Devtools

`InfiniteEntry` reports through the same `EntryEvents` bundle as `Entry`: fetch start and settle for each direction, plus the snapshot layer events. `devtoolsEntryEvents` in `client.ts` builds the bundle for both entry kinds. The `cache:fetch-*` events now carry `queryId` for regular queries too; before, only `cache:set-data` did. The fetch `causeId` counter (`nextFetchCauseId` in `entry.ts`) is shared, so ids never collide across the two kinds.

## Open items

Nothing listed here now. The last item, rebasing live optimistic snapshots on a successful page fetch, landed in 1.0. The open question was what a rebase means for an appended page. The answer is to add the page to each baseline. A refetch sets every baseline to the refetched pages, `fetchNextPage` appends the page and its param, and `fetchPreviousPage` prepends them. A rollback then drops the optimistic change and keeps the fetched page. The mechanics are in `../entities/entry.md`; pinned by `infinite-rebase.test.ts`.
