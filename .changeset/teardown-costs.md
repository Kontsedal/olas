---
"@kontsedal/olas-core": patch
---

**Faster teardown and refetch, found by the new benchmark baselines.**

- **A settled request lets go of its `AbortController`.** A query kept its last request's controller until the next refetch, hydration, cancel or dispose aborted it. That aborted nothing, but each `abort()` built a `DOMException`, and on Node that was half the CPU time of a root with 1,000 queries. It also fired the finished request's `signal` late, so an `abort` listener a fetcher left behind ran long after its request was over. A fetcher's `signal` now stays un-aborted once its request has settled.
- **`root.dispose()` no longer arms a gc timer per query.** Disposing the controllers released each subscription, and each release armed a gc timer the query client cleared a moment later. A root with 1,000 queries now disposes in 0.37 ms, down from 6.9 ms.
