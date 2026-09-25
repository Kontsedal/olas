/**
 * Engine micro-benchmarks. Run with `pnpm bench`; they never gate CI, because
 * wall-clock numbers are noisy. Each bench builds its fixture outside the
 * measured function where it can, so the number is the operation named.
 */
import { test } from 'vitest'
import {
  computed,
  createField,
  createForm,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  effect,
  queryEngine,
  signal,
} from '../src'

test('signals', async ({ bench }) => {
  const source = signal(0)
  const derived = Array.from({ length: 10_000 }, (_, i) => computed(() => source.value + i))
  const stops = derived.map((d) => effect(() => void d.value))
  await bench('set a signal read by 10,000 computed + effect pairs', () => {
    source.set(source.peek() + 1)
  }).run()
  for (const stop of stops) stop()
})

test('query subscriptions', async ({ bench }) => {
  const q = defineQuery({
    id: 'bench/shared',
    key: () => [],
    fetcher: async () => ({ n: 0 }),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const root = createRoot(
    defineController((ctx) => ({
      subs: Array.from({ length: 10_000 }, () => createQuery(ctx, q)),
    })),
    { queries: queryEngine(), deps: {} },
  )
  // An effect per subscription, as 10,000 mounted components would hold:
  // without a reader, a subscription's `data` computed is never evaluated.
  const readers = root.api.subs.map((sub) => effect(() => void sub.data.value))
  const bound = root.bindQuery(q)
  let n = 0
  await bench('write to an entry with 10,000 observed subscribers', () => {
    n += 1
    bound.write(() => ({ n }))
  }).run()
  for (const stop of readers) stop()
  root.dispose()
})

test('fetch cycle', async ({ bench }) => {
  const queries = Array.from({ length: 1_000 }, (_, i) =>
    defineQuery({ id: `bench/fetch/${i}`, key: () => [], fetcher: async () => i }),
  )
  await bench('create a root that fetches 1,000 queries, and wait for idle', async () => {
    const root = createRoot(
      defineController((ctx) => ({ subs: queries.map((q) => createQuery(ctx, q)) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    root.dispose()
  }).run({ iterations: 20 })
})

test('structural sharing', async ({ bench }) => {
  // ~1 MB of JSON: 5,000 rows of 10 fields.
  const payload = () =>
    Array.from({ length: 5_000 }, (_, i) => ({
      id: i,
      title: `row ${i} ${'x'.repeat(120)}`,
      tags: ['a', 'b', 'c'],
      meta: { created: 1_700_000_000_000 + i, owner: { id: i % 17, name: `user ${i % 17}` } },
    }))
  const q = defineQuery({ id: 'bench/share', key: () => [], fetcher: async () => payload() })
  const root = createRoot(
    defineController((ctx) => ({ rows: createQuery(ctx, q) })),
    {
      queries: queryEngine(),
      deps: {},
    },
  )
  await bench(
    'refetch an unchanged 1 MB payload (structural share keeps every reference)',
    async () => {
      await root.api.rows.refetch()
    },
  ).run({ iterations: 20 })
  root.dispose()
})

test('forms', async ({ bench }) => {
  const root = createRoot(
    defineController((ctx) => {
      const schema: Record<string, ReturnType<typeof createField<string>>> = {}
      for (let i = 0; i < 500; i++) {
        schema[`f${i}`] = createField<string>(ctx, '', {
          validators: [(v) => (v.length > 20 ? 'too long' : null)],
        })
      }
      return { form: createForm(ctx, schema) }
    }),
    { deps: {} },
  )
  const form = root.api.form
  const stop = effect(() => void form.value)
  let n = 0
  await bench('set one field of a 500-field form and re-read the aggregate value', () => {
    n += 1
    form.fields.f250?.set(`v${n % 10}`)
    void form.value
  }).run()
  stop()
  root.dispose()
})
