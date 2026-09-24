---
"@kontsedal/olas-core": patch
---

Three fixes in the query engine and `selection`.

- **A fetcher that rejects with its own `AbortError` left an infinite query fetching.** This is the defect fixed for regular queries in the previous release, and it lived in both of `InfiniteEntry`'s loops too. The request now settles as a failure: `status: 'error'`, the error on `error`, and `isFetching`, `isLoading` and the page-direction flag cleared. Loaded pages are kept. `root.waitForIdle()` now resolves after it. A superseded request still writes nothing.
- **`keepDataWhileDisabled` did nothing on an infinite query.** `createQuery(ctx, infiniteQuery, { enabled, keepDataWhileDisabled: true })` accepted the option and ignored it. Disabling now keeps the loaded `pages`, `data` and `flat`, as it does for a regular query. `flat` also follows retained pages under `keepPreviousData`; before, it went empty while `pages` still showed the previous key's data.
- **`selection().isSelected(id)` minted a new signal on every call.** A row rendering `use(sel.isSelected(id))` then re-subscribed on every render. The same id now returns the same signal while anything holds it. The cache holds them weakly, so a long list scrolled end to end does not pin one per row.
