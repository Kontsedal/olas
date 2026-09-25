---
name: infinite-query-parity
description: How infinite queries reached parity with regular ones for 1.0 — pageParams on dehydrated entries and write events, hydration seeding, focus/reconnect, the offlineFirst park, cross-tab, devtools.
type: decision
covers:
  - packages/core/src/query/infinite.ts
  - packages/core/src/query/client.ts
  - packages/core/src/query/types.ts:134-168
  - packages/core/src/plugin/types.ts
  - packages/react/src/streaming.ts
  - packages/cross-tab/src/plugin.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/infinite-parity.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-rebase.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-edges.test.ts }
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

**The first param drives a refetch (1.0, fourth pass).** `fetchNextPage` and `fetchPreviousPage` derive the next param from the page data through `getNextPageParam`. A refetch starts from `pageParams[0]` and re-derives the rest, as TanStack does. It used to start at `initialPageParam`, so a list paged backwards to `[-2, -1, 0]` refetched as `[0, 1, 2]` (SPEC §5.11, which said both). The stored params therefore matter beyond bookkeeping: a hydrated, persisted or relayed entry refetches from its own first param. A write that adds pages to an entry with no params pads with `initialPageParam`, not `undefined`, so the refetch that follows starts where a first load would. The cross-tab test pins that the receiver stores the sender's params, `[0, 1, 2]`; padding its own would have given `[0, 0, 0]`. Pinned by `infinite-edges.test.ts`, "a refetch starts from the first loaded page".

## Hydration

`bindInfiniteEntry` adopts a buffered payload the way `bindEntry` does, and reports one `'hydrate'` write. `InfiniteEntry` seeds `pages`, `pageParams`, `status: 'success'` and `lastUpdatedAt` in its constructor, and derives `isStale` from the payload's real age (`settleStaleness`). A payload for an entry that is already bound goes through `InfiniteEntry.applyHydration`. That supersedes the fetch in flight, as `Entry.applyHydration` does.

## Focus, reconnect and `offlineFirst`

- **Focus and reconnect.** `InfiniteClientEntry` subscribes on its first `acquire`, reading the spec field or the engine default. A focus or reconnect refetch re-fetches every loaded page, because that is what an infinite refetch is (T3.7).
- **The `offlineFirst` park.** A network-shaped failure (`TypeError`) while offline parks the fetch, in `runRefetchAll` and in `runFetch` alike, instead of surfacing an error. `park` clears the fetching flags and keeps the loaded pages, in the batch that parks the request, so no observer sees the entry idle and unpaused in between. The drain re-runs the parked direction on reconnect. A parked refetch re-runs whole: the pages it had already fetched are dropped, because a partial refetch would mix fresh pages with stale ones. The drain resolves a parked refetch with the first page, as a refetch made online does. A `prefetch` requested offline therefore resolves with the page, not `undefined` (1.0, second pass). Pinned by `query-focus-online.test.ts`, "an infinite prefetch requested offline resolves with the first page".

## Devtools

`InfiniteEntry` reports through the same `EntryEvents` bundle as `Entry`: fetch start and settle for each direction, plus the snapshot layer events. `devtoolsEntryEvents` in `client.ts` builds the bundle for both entry kinds. The `cache:fetch-*` events now carry `queryId` for regular queries too; before, only `cache:set-data` did. The fetch `causeId` counter (`nextFetchCauseId` in `entry.ts`) is shared, so ids never collide across the two kinds.

## Open items

Nothing listed here now. The last item, rebasing live optimistic snapshots on a successful page fetch, landed in 1.0. The open question was what a rebase means for an appended page. The answer is to add the page to each baseline. A refetch sets every baseline to the refetched pages, `fetchNextPage` appends the page and its param, and `fetchPreviousPage` prepends them. A rollback then drops the optimistic change and keeps the fetched page. The mechanics are in `../entities/entry.md`; pinned by `infinite-rebase.test.ts`.
