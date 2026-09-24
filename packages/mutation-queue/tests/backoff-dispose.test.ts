import { createRoot, defineController, defineMutation, queryEngine } from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { mutationQueuePlugin } from '../src'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('dispose() during a backoff wait releases the replay pass and its lease at once', async () => {
  vi.useFakeTimers()
  const lease = new Map<string, string>()
  vi.stubGlobal('navigator', { onLine: true }) // no Web Locks: the localStorage lease path
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => lease.get(k) ?? null,
    setItem: (k: string, v: string) => lease.set(k, v),
    removeItem: (k: string) => lease.delete(k),
  })
  const id = 'mq-test/backoff-dispose'
  _unregisterMutationById(id)
  defineMutation({ id, mutate: async () => 'ok', meta: { persist: true } })
  const store = new Map<string, string>([
    [
      `mq-bd/${id}/r1`,
      JSON.stringify({
        v: 1,
        mutationId: id,
        runId: 'r1',
        variables: null,
        attempts: 1,
        enqueuedAt: Date.now(),
      }),
    ],
  ])
  const storage = {
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => void store.set(k, v),
    delete: (k: string) => void store.delete(k),
    keys: () => [...store.keys()],
  }
  const root = createRoot(
    defineController(() => ({})),
    {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage, keyPrefix: 'mq-bd', backoffMs: 30_000 })],
    },
  )
  await vi.advanceTimersByTimeAsync(1_000) // the replay is parked in its 30 s backoff
  expect([...lease.keys()].some((k) => k.includes('lease'))).toBe(true)

  root.dispose()
  await vi.advanceTimersByTimeAsync(10)
  expect([...lease.keys()].some((k) => k.includes('lease'))).toBe(false)
  expect(vi.getTimerCount()).toBe(0) // no backoff timer outlives the root
})
