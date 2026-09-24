# Performance

This page says what Olas costs in bytes and in time, and how each number was measured. It includes the cases where Olas is slower than the libraries it is compared with. SPEC [§23](https://github.com/Kontsedal/olas/blob/main/SPEC.md#23-performance-characteristics) holds the full estimates, including per-primitive allocation.

## Bundle size

`size-limit` measures one entry per row of `.size-limit.json`. Each size is minified and brotlied, with the runtime peers left out: `@preact/signals-core`, the framework, Zod, and the Olas packages a satellite builds on. These are the sizes from one `pnpm build && pnpm size` run on 2026-09-24, and from a second run on 2026-09-25 for vue and realtime:

| Entry | Imports | Size | Budget |
|---|---|---|---|
| core: controllers + signals | `createRoot`, `defineController`, `signal`, `computed` | 5.16 kB | 5.4 kB |
| core: + forms | `createRoot`, `defineController`, `createField`, `createForm`, `createFieldArray` | 9.08 kB | 9.2 kB |
| core: + queries and mutations | `createRoot`, `defineController`, `queryEngine`, `defineQuery`, `createQuery`, `createMutation` | 16.18 kB | 16.6 kB |
| core: everything | `*` | 21.84 kB | 22.3 kB |
| react | `*` | 3.54 kB | 3.8 kB |
| vue | `*` | 833 B | 900 B |
| svelte | `*` | 772 B | 850 B |
| persist: `createPersisted` | `createPersisted`, `localStorageAdapter` | 990 B | 1.05 kB |
| persist: `persistQueryCachePlugin` | `persistQueryCachePlugin`, `restoreQueryCache` | 1.09 kB | 1.25 kB |
| zod | `*` | 1.29 kB, plus Zod | 1.35 kB |
| cross-tab | `*` | 1.31 kB | 1.4 kB |
| entities | `*` | 2.2 kB | 2.2 kB |
| mutation-queue | `*` | 3.07 kB | 3.3 kB |
| realtime | `*` | 1 kB | 1.05 kB |
| router | `*` | 580 B | 650 B |
| devtools | `*` | 17.84 kB | 18.8 kB |

Each budget sits about 5% over the size measured when it was set, so a real regression fails and build noise does not. CI runs `pnpm size` after the build and fails a build over any budget. The runtime Olas wraps adds about 1.8 kB on top: `@preact/signals-core` 1.14.2, minified with esbuild and brotlied.

### What a bundle carries

Core tree-shakes at the level of its free functions. A primitive enters your bundle when you import it:

- **Controllers only** carry neither forms nor the query engine. `pnpm smoke:dist` bundles a controllers-only import from the published `dist` and fails if either appears.
- **Forms** enter with `createField`, `createForm` or `createFieldArray`, and cost about 4 kB.
- **The query engine** enters only with `queryEngine`. Queries and mutations cost about 11 kB over controllers alone.
- **A kitchen-sink app**, with everything in core plus react, `createPersisted` and zod, sums to about 27.7 kB, plus Zod and the peers. That is a sum of separate measurements, so it is an estimate: one combined bundle compresses a little differently.

The devtools panel is 17.84 kB, so load it behind your app's own development gate. Core's production build removes every debug-event emission site, so production code pays nothing to emit devtools events (§23).

To get current numbers:

```bash
pnpm build   # size-limit measures the built dist
pnpm size
```

## Speed: the benchmark baselines

Olas is benchmarked against three things:

- **raw `@preact/signals-core`**, the runtime it wraps, so the gap is the wrapper's cost;
- **MobX**, for signal fan-out;
- **`@tanstack/query-core`**, for the query engine.

`packages/core/bench/baselines.bench.ts` runs the same operation through each library, one `describe` per comparison, and vitest prints how many times faster the fastest entry is. `packages/core/bench/engine.bench.ts` times Olas alone, including a 500-field form that has no baseline.

### What each bench measures

| Bench | The measured function |
|---|---|
| Signal fan-out | Set one source read by 10,000 derived values, each with an effect. |
| Cache write | Write one entry that 10,000 subscribers observe, each through an effect or observer. |
| Fetch cycle | Build 1,000 query subscriptions, fetch all of them, wait for every one to settle, and tear down. |
| Structural sharing | Refetch an unchanged payload of about 1 MB: 5,000 rows of nested objects. |

Two choices keep the comparison fair. TanStack Query batches its observer notifications onto a timer by default, which would move its work outside the measured function, so the bench makes its scheduler synchronous. And the benches run in one vitest project, because two projects benchmarking at once skewed the first run.

### Results

Recorded on 2026-09-24: AMD Ryzen 7 9800X3D (16 threads), Node 26.8.1, Windows 11. Two runs; each range is the spread between them.

| Operation | Result |
|---|---|
| Signal fan-out | raw preact is **1.30–1.32× faster** than Olas; Olas is 4.4–5.3× faster than MobX |
| Cache write, 10,000 subscribers | Olas is 2.0–2.1× faster than TanStack Query |
| Fetch cycle, 1,000 queries | TanStack Query is **1.12–1.14× faster** |
| Structural sharing, 1 MB | TanStack Query is **1.18–1.28× faster** |

Read these with their caveats:

- **Olas is slower in three of the four groups.** The signal fan-out gap is the price of the wrapper types over `@preact/signals-core` (see [why the runtime is wrapped](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/signals-runtime-wrapped.md)).
- **The fetch cycle is not like for like.** Olas builds a controller tree with 1,000 subscriptions and waits on `root.waitForIdle()`. TanStack creates 1,000 observers and awaits `fetchQuery`.
- **They are micro-benchmarks on one machine.** A run on other hardware, or with other work on the machine, gives other ratios. Compare ratios within one run, not absolute times across runs.
- **They do not gate CI.** Wall-clock timing is too noisy for a pass or fail line, so no CI job runs them. `size-limit` guards bundle size instead.

[The benchmarks decision](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/benchmarks.md) records the method and the run.

## Teardown costs

The first comparison had TanStack Query 2.7× faster on the fetch cycle. Timing the phases showed dispose taking most of the cycle, and a CPU profile put half of all samples in `DOMException`. Core fixed two costs:

- **A settled request lets go of its `AbortController`.** A query used to keep its last request's controller until the next refetch, hydration, cancel or dispose aborted it. That abort cancelled nothing, but Node builds a `DOMException` with a stack trace for each `abort()` without a reason. Now the entry drops the controller when its request settles. As a result, a fetcher's `signal` stays un-aborted once its request has settled, so an `abort` listener a fetcher left behind no longer fires late.
- **`root.dispose()` arms no gc timer per query.** Disposing the controllers released each subscription, and each release armed a gc timer that the query client cleared a moment later. Now the root closes its query client first, and a release on a closing client arms nothing.

A root with 1,000 queries now disposes in 0.37 ms, down from 6.9 ms, and the fetch-cycle gap went from 2.7× to 1.14×. The "W15 regression: teardown costs" tests in `packages/core/tests/regressions.test.ts` pin both fixes.

## Fine-grained re-renders

Each adapter keeps a component's re-renders close to the values it reads:

| Adapter | Re-render granularity |
|---|---|
| React | `useQuery` and `useInfiniteQuery`: per field read during render. Other hooks: per hook. |
| Vue | Per ref. `useQuery` returns one ref per `AsyncState` signal, and Vue tracks which refs a template reads. |
| Svelte | Per `$store`. A signal is a store as it is. `queryStore` is one `computed` over every signal of the query, so it updates once per `batch` of writes. |

In React, `useQuery` returns a tracked snapshot. Its getters record each field the component reads during render, and the hook notifies React only when one of those fields changes:

```tsx
import type { AsyncState } from '@kontsedal/olas-core'
import { useQuery } from '@kontsedal/olas-react'

type User = { name: string }

export function UserName(props: { user: AsyncState<User> }) {
  // Reads `data` only: a background refetch that flips `isFetching` does not re-render this.
  const { data } = useQuery(props.user)
  return <span>{data?.name}</span>
}
```

Three rules follow from the tracking:

- A field read later, in an event handler or an effect, returns its current value and is tracked from then on.
- Spreading the result reads every field, so it tracks every field.
- With `{ suspense: true }`, the hook tracks `data` and `status` itself, because the suspend decision reads them.

Two more tools narrow a subscription:

- **`useValue(signal, { select, isEqual })`** re-renders only when the selected slice changes, by `isEqual`, which defaults to `Object.is`.
- **Subscribe to fields, not the whole form.** `form.value` is one `computed` over every leaf, so `useValue(form)` re-renders on any change to any field. `useField(form.fields.email)` re-renders for that field only.

On the write side, `batch(() => …)` runs several signal writes as one step, so subscribers re-run once after the batch instead of once per write. See the [React adapter](/adapters/react#usequery-re-renders-for-what-the-component-reads) for the details of the tracking.

## Structural sharing

A successful fetch is structurally shared with the entry's previous data. Wherever a subtree of the new result equals the old one, the entry keeps the old reference. A refetch that returns an unchanged payload therefore leaves `data` identical (`===`), and no downstream `computed` or component re-runs. A partial change keeps every unchanged subtree's reference, so a memoized row component whose row did not change skips its re-render.

The walk covers plain objects and arrays. `Map`, `Set`, `Date` and class instances are replaced whole. An infinite query shares its head page on refresh.

The walk costs time on every successful fetch, and TanStack Query is faster on the 1 MB refetch bench above. For a very large payload that changes on most polls, the walk costs more than the re-renders it saves. Turn it off on that query:

<!-- snippet-prelude
type LogLine = { at: number; text: string }
declare function fetchLog(signal: AbortSignal): Promise<LogLine[]>
-->
```ts
import { defineQuery } from '@kontsedal/olas-core'

export const logQuery = defineQuery({
  id: 'ops/log',
  key: () => [],
  fetcher: ({ signal }) => fetchLog(signal),
  refetchInterval: 5_000,
  // Large, and different on most polls: skip the walk, take the new value whole.
  structuralShare: false,
})
```

Structural sharing applies to fetched data. For an optimistic `setData` on nested data, the updater's cost is yours. `structuredClone(prev)` copies every node on each call, and Immer's `produce` copies only the touched path, so prefer Immer for any cache holding more than a few hundred nodes (§5.7).

## Run the benches yourself

```bash
pnpm bench              # every suite in packages/core/bench
pnpm bench baselines    # only the comparison with preact, MobX and TanStack Query
```

`pnpm bench` runs `vitest bench --run`, and an argument filters the bench files by name. Each group prints its table of timings, and the summary at the end says how many times faster the fastest entry is. Close other heavy programs, run it twice, and compare the ratios. A single run on a busy machine can move a ratio by more than the differences in the table above.

## Where next

- SPEC [§23](https://github.com/Kontsedal/olas/blob/main/SPEC.md#23-performance-characteristics) has per-primitive allocation, controller counts, reactivity costs and query-client gc.
- [Queries](/guide/queries) teaches the query engine these numbers measure.
- Reference: [`batch`](/reference/olas-core.batch), [`useQuery`](/reference/olas-react.usequery), [`useValue`](/reference/olas-react.usevalue).
