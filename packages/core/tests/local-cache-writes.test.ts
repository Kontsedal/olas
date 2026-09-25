/**
 * `LocalCache` has the canonical writes `Query` has: `write` patches and `replace`
 * sets the whole record, neither pushes a snapshot (SPEC §6.4). And a local cache's
 * fetches count toward `root.waitForIdle()`, though it is not a query-client entry.
 */
import { describe, expect, test } from 'vitest'
import { createCache, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A local cache whose fetches each wait on a deferred, in call order. */
function cacheRoot<T>() {
  const calls: Array<ReturnType<typeof deferred<T>>> = []
  const root = createRoot(
    defineController((ctx) => ({
      c: createCache(ctx, () => {
        const d = deferred<T>()
        calls.push(d)
        return d.promise
      }),
    })),
    { deps: {} },
  )
  return { root, calls, c: root.api.c }
}

describe('LocalCache.write and replace', () => {
  test('write is a canonical patch: no snapshot, and a fetch in flight still lands', async () => {
    const { calls, c } = cacheRoot<string>()
    calls[0]?.resolve('v1')
    await flush()

    void c.refetch()
    c.write((prev) => `${prev} + patch`)
    expect(c.data.value).toBe('v1 + patch')
    expect(c.hasPendingMutations.value).toBe(false)
    expect(c.isFetching.value).toBe(true)

    calls[1]?.resolve('v2')
    await flush()
    expect(c.data.value).toBe('v2')
  })

  test('write rebases a live optimistic snapshot, so a rollback keeps it', async () => {
    const { calls, c } = cacheRoot<string>()
    calls[0]?.resolve('v1')
    await flush()
    const snap = c.setData(() => 'guess')
    expect(c.hasPendingMutations.value).toBe(true)
    c.write(() => 'canonical')
    snap.rollback()
    expect(c.data.value).toBe('canonical')
    expect(c.hasPendingMutations.value).toBe(false)
  })

  test('replace supersedes a fetch in flight', async () => {
    const { calls, c } = cacheRoot<string>()
    calls[0]?.resolve('v1')
    await flush()

    void c.refetch()
    c.replace('record')
    expect(c.isFetching.value).toBe(false)
    calls[1]?.resolve('from before the record')
    await flush()
    expect(c.data.value).toBe('record')
    expect(c.status.value).toBe('success')
    expect(calls).toHaveLength(2)
  })

  test('replace with undefined leaves the fetch in flight to produce the value', async () => {
    const { calls, c } = cacheRoot<string | undefined>()
    expect(c.isFetching.value).toBe(true)
    c.replace(undefined)
    expect(c.isFetching.value).toBe(true)
    calls[0]?.resolve('first')
    await flush()
    expect(c.data.value).toBe('first')
  })
})

describe('root.waitForIdle() counts createCache fetches', () => {
  test('it waits for a local cache on a root without a query engine', async () => {
    const { root, calls, c } = cacheRoot<string>()
    let idle = false
    void root.waitForIdle().then(() => {
      idle = true
    })
    await flush()
    expect(idle).toBe(false)
    calls[0]?.resolve('v1')
    await flush()
    expect(idle).toBe(true)
    expect(c.data.value).toBe('v1')
  })

  test('it waits for local caches and query fetches together', async () => {
    const cacheAnswer = deferred<string>()
    const queryAnswer = deferred<string>()
    const q = defineQuery({ id: 'idle/both', key: () => ['k'], fetcher: () => queryAnswer.promise })
    const root = createRoot(
      defineController((ctx) => ({
        c: createCache(ctx, () => cacheAnswer.promise),
        s: createQuery(ctx, q),
      })),
      { queries: queryEngine(), deps: {} },
    )
    let idle = false
    void root.waitForIdle().then(() => {
      idle = true
    })
    queryAnswer.resolve('q')
    await flush()
    expect(idle).toBe(false)
    cacheAnswer.resolve('c')
    await flush()
    expect(idle).toBe(true)
    root.dispose()
  })

  test('a disposed controller stops counting its cache', async () => {
    const pending = deferred<string>()
    const child = defineController((ctx) => ({ c: createCache(ctx, () => pending.promise) }))
    const items = signal<readonly string[]>(['a'])
    const root = createRoot(
      defineController((ctx) => ({
        kids: ctx.collection({
          source: items,
          keyOf: (k: string) => k,
          controller: child,
          propsOf: () => undefined,
        }),
      })),
      { deps: {} },
    )
    let idle = false
    void root.waitForIdle().then(() => {
      idle = true
    })
    await flush()
    expect(idle).toBe(false) // the child's cache is counted

    items.set([]) // disposes the child while its fetch is in flight
    await flush()
    expect(idle).toBe(true)
    root.dispose()
  })
})
