---
"@kontsedal/olas-react": patch
---

**`useSuspenseQuery` no longer loops forever on a query that settled on `undefined`.**

The hook suspended whenever `data` was `undefined`. A load can succeed with `undefined`: a `select` that reads an optional field, a fetcher that resolves nothing, an infinite query replaced with no pages. `firstValue()` resolved at once then, React retried, and the hook suspended again, thousands of times, starving the event loop. `useQuery(sub, { suspense: true })`, `useSuspenseQuery` and `useInfiniteQuery(sub, { suspense: true })` now suspend only until the first load settles, and return `undefined` as the value when it settled on that. A refetch over an `undefined` result does not suspend either.
