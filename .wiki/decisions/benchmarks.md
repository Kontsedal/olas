---
name: benchmarks
description: How Olas is benchmarked against raw @preact/signals-core, MobX and TanStack Query core, the 1.0 results, and the two teardown costs the first comparison exposed.
type: decision
covers:
  - packages/core/bench/engine.bench.ts
  - packages/core/bench/baselines.bench.ts
  - vitest.config.ts
edges:
  - { type: related, target: engine-assurance.md }
  - { type: related, target: ../entities/entry.md }
  - { type: related, target: ../entities/query-client.md }
last_verified: 2026-09-24
confidence: medium
---

# Benchmarks

## How they run

`pnpm bench` runs `vitest bench --run` over `packages/core/bench/`. No CI job runs it, because wall-clock timing is noisy; `size-limit` guards bundle size instead (`esm-only-build.md`).

- `engine.bench.ts` times Olas alone: signal fan-out, a write to an entry with 10,000 observed subscribers, a 1,000-query fetch cycle, structural sharing over a 1 MB payload, and a 500-field form.
- `baselines.bench.ts` runs the same operations through the libraries Olas is compared with. Each `describe` is one group, and vitest prints how many times faster the fastest entry is.

Three choices keep the comparison fair:
- **Raw `@preact/signals-core` is an entry.** It is the runtime Olas wraps, so the gap is the wrapper's cost.
- **TanStack Query's notifications are made synchronous** with `notifyManager.setScheduler((cb) => cb())`. Its default batches them onto a timer, which would move its work outside the measured function.
- **Benchmarks run in one vitest project.** The `svelte` project sets `benchmark: { include: [] }`. With both projects benchmarking at once, the first run reported raw preact as 1.02× faster than Olas; alone, it is 1.30×.

## Results, 2026-09-24

AMD Ryzen 7 9800X3D (16 threads), Node 26.8.1, Windows 11. Two runs; the range is the spread between them.

| Operation | Result |
|---|---|
| Signal fan-out: one source, 10,000 computed + effect pairs | raw preact is 1.30–1.32× faster than Olas; Olas is 4.4–5.3× faster than MobX |
| Write one entry observed by 10,000 subscribers | Olas is 2.0–2.1× faster than TanStack Query |
| Fetch 1,000 queries and wait for all to settle | TanStack Query is 1.12–1.14× faster |
| Refetch an unchanged 1 MB payload (structural sharing) | TanStack Query is 1.18–1.28× faster |

The fetch cycle is not like for like. Olas builds a controller tree with 1,000 subscriptions and waits on `root.waitForIdle()`. TanStack creates 1,000 observers and awaits `fetchQuery`.

## What the first comparison found

The first run had TanStack 2.7× faster on the fetch cycle. Timing its phases on core's production build showed dispose taking 7.1 ms of the ~11 ms cycle, and a CPU profile put half of all samples in `DOMException`. Two costs, both fixed:

- **A settled request kept its `AbortController`.** `Entry` and `InfiniteEntry` held the last request's controller as `currentAbort` until the next fetch, a hydration, a cancel or dispose aborted it. Aborting a finished request cancels nothing, but Node builds a `DOMException` with a stack trace for each `abort()` without a reason. So every refetch paid for one, and so did every entry at dispose. `releaseOnSettle` now drops the controller when its request settles. A side effect worth having: a fetcher's `signal` no longer fires `abort` after its request has finished.
- **Root dispose armed a gc timer per entry.** Disposing the controllers released each subscription, and each release armed a gc timer. `QueryClient.dispose` cleared them all a moment later, so 1,000 queries cost 1,000 `setTimeout` and `clearTimeout` pairs. The root now calls `queryClient.close()` first, and a release on a closing client arms nothing.

Dispose went from 6.9 ms to 0.37 ms for 1,000 queries, and the fetch-cycle gap from 2.7× to 1.14×. Both are pinned by `regressions.test.ts` under "W15 regression: teardown costs", confirmed to fail on the old code. One devtools test used `root.dispose()` to make a subscriber leave; it now detaches a child controller, since a root teardown no longer collects entries one at a time.
