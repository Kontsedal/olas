---
"@kontsedal/olas-core": minor
"@kontsedal/olas-react": minor
"@kontsedal/olas-cross-tab": minor
---

**Infinite queries reach parity with regular queries.**

- **SSR.** `root.dehydrate()` includes infinite queries. A dehydrated entry for one carries its pages in `data` and one param per page in the new `pageParams` field. The client seeds the pages without refetching them and pages on from there. The streaming hydrator captures and delivers infinite queries too.
- **Focus and reconnect.** `refetchOnWindowFocus` and `refetchOnReconnect` apply to infinite queries, on the query or as engine defaults. A refetch re-fetches every loaded page.
- **Offline.** In `networkMode: 'offlineFirst'`, a network failure while offline parks an infinite query's fetch, including `fetchNextPage` and `fetchPreviousPage`, and retries it on reconnect, instead of surfacing an error. `isPaused` reports it.
- **Cross-tab.** An infinite query with `meta: { crossTab: true }` syncs across tabs, its pages together with their params.
- **Devtools.** Infinite queries show on the devtools timeline: fetch start and settle for each direction, and optimistic snapshot layers. The `cache:fetch-*` events carry `queryId` for every query.
- **Plugins.** `WriteEvent` carries `pageParams` for an infinite query. `host.queries.write` and `replace` accept `{ pageParams }` (the new `WriteOptions` type).
