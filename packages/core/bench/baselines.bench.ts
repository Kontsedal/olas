/**
 * The same operations through Olas and through the libraries people compare it
 * with. Each `test` is one comparison group, so vitest reports how many times
 * faster the fastest entry is. Every entry's fixture is built before the group
 * runs, in the order listed, and torn down after it. Run with `pnpm bench`; the numbers never
 * gate CI.
 *
 * - Raw `@preact/signals-core` is there to show what Olas's wrapper costs over
 *   the runtime it is built on.
 * - TanStack Query batches its observer notifications onto a timer by default.
 *   The scheduler is made synchronous here, so both sides do the same work
 *   inside the measured function.
 */
import {
  computed as preactComputed,
  effect as preactEffect,
  signal as preactSignal,
} from '@preact/signals-core'
import { notifyManager, QueryClient, QueryObserver } from '@tanstack/query-core'
import { autorun, computed as mobxComputed, observable, runInAction } from 'mobx'
import { type BenchRegistration, test } from 'vitest'
import {
  computed,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  effect,
  queryEngine,
  signal,
} from '../src'

notifyManager.setScheduler((callback) => callback())

const FAN_OUT = 10_000

test('signal fan-out: set one source read by 10,000 derived values, each with an effect', async ({
  bench,
}) => {
  const entries: BenchRegistration<string>[] = []
  const stops: (() => void)[] = []
  {
    const source = signal(0)
    const derived = Array.from({ length: FAN_OUT }, (_, i) => computed(() => source.value + i))
    stops.push(...derived.map((d) => effect(() => void d.value)))
    entries.push(
      bench('olas', () => {
        source.set(source.peek() + 1)
      }),
    )
  }
  {
    const source = preactSignal(0)
    const derived = Array.from({ length: FAN_OUT }, (_, i) =>
      preactComputed(() => source.value + i),
    )
    stops.push(...derived.map((d) => preactEffect(() => void d.value)))
    entries.push(
      bench('@preact/signals-core', () => {
        source.value = source.peek() + 1
      }),
    )
  }
  {
    const source = observable.box(0)
    const derived = Array.from({ length: FAN_OUT }, (_, i) => mobxComputed(() => source.get() + i))
    stops.push(...derived.map((d) => autorun(() => void d.get())))
    entries.push(
      bench('mobx', () => {
        runInAction(() => source.set(source.get() + 1))
      }),
    )
  }
  await bench.compare(...entries)
  for (const stop of stops) stop()
})

test('cache write: update one entry observed by 10,000 subscribers', async ({ bench }) => {
  const entries: BenchRegistration<string>[] = []
  const stops: (() => void)[] = []
  {
    const q = defineQuery({
      id: 'baseline/write',
      key: () => [],
      fetcher: async () => ({ n: 0 }),
      staleTime: Number.POSITIVE_INFINITY,
    })
    const root = createRoot(
      defineController((ctx) => ({
        subs: Array.from({ length: FAN_OUT }, () => createQuery(ctx, q)),
      })),
      { queries: queryEngine(), deps: {} },
    )
    stops.push(...root.api.subs.map((sub) => effect(() => void sub.data.value)))
    stops.push(() => root.dispose())
    const bound = root.bindQuery(q)
    let n = 0
    entries.push(
      bench('olas', () => {
        n += 1
        bound.write(() => ({ n }))
      }),
    )
  }
  {
    const client = new QueryClient()
    client.setQueryData(['write'], { n: 0 })
    const observers = Array.from(
      { length: FAN_OUT },
      () =>
        new QueryObserver(client, {
          queryKey: ['write'],
          queryFn: async () => ({ n: 0 }),
          staleTime: Number.POSITIVE_INFINITY,
        }),
    )
    stops.push(...observers.map((o) => o.subscribe(() => {})))
    stops.push(() => client.clear())
    let n = 0
    entries.push(
      bench('@tanstack/query-core', () => {
        n += 1
        client.setQueryData(['write'], { n })
      }),
    )
  }
  await bench.compare(...entries)
  for (const stop of stops) stop()
})

test('fetch cycle: fetch 1,000 queries and wait until every one settles', async ({ bench }) => {
  const COUNT = 1_000
  const queries = Array.from({ length: COUNT }, (_, i) =>
    defineQuery({ id: `baseline/fetch/${i}`, key: () => [], fetcher: async () => i }),
  )
  await bench.compare(
    bench('olas', async () => {
      const root = createRoot(
        defineController((ctx) => ({ subs: queries.map((q) => createQuery(ctx, q)) })),
        { queries: queryEngine(), deps: {} },
      )
      await root.waitForIdle()
      root.dispose()
    }),
    bench('@tanstack/query-core', async () => {
      const client = new QueryClient()
      const observers = Array.from(
        { length: COUNT },
        (_, i) => new QueryObserver(client, { queryKey: ['fetch', i], queryFn: async () => i }),
      )
      const stops = observers.map((o) => o.subscribe(() => {}))
      await Promise.all(observers.map((o, i) => client.fetchQuery(o.options).then(() => i)))
      for (const stop of stops) stop()
      client.clear()
    }),
    { iterations: 20 },
  )
})

test('structural sharing: refetch an unchanged 1 MB payload', async ({ bench }) => {
  // ~1 MB of JSON: 5,000 rows of 10 fields.
  const payload = () =>
    Array.from({ length: 5_000 }, (_, i) => ({
      id: i,
      title: `row ${i} ${'x'.repeat(120)}`,
      tags: ['a', 'b', 'c'],
      meta: { created: 1_700_000_000_000 + i, owner: { id: i % 17, name: `user ${i % 17}` } },
    }))
  const q = defineQuery({ id: 'baseline/share', key: () => [], fetcher: async () => payload() })
  const root = createRoot(
    defineController((ctx) => ({ rows: createQuery(ctx, q) })),
    { queries: queryEngine(), deps: {} },
  )
  const client = new QueryClient()
  const observer = new QueryObserver(client, {
    queryKey: ['share'],
    queryFn: async () => payload(),
  })
  const stop = observer.subscribe(() => {})
  await bench.compare(
    bench('olas', async () => {
      await root.api.rows.refetch()
    }),
    bench('@tanstack/query-core', async () => {
      await observer.refetch()
    }),
    { iterations: 20 },
  )
  stop()
  client.clear()
  root.dispose()
})
