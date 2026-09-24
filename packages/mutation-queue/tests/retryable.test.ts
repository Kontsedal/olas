import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  type OlasPlugin,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { describe, expect, test } from 'vitest'
import { MutationQueue, mutationQueuePlugin, PROTOCOL_VERSION, type QueueEntry } from '../src'

// `isRetryable(err, entry)`: a failure no later attempt can fix drops its
// entry at once, on a replay and on a live run, instead of spending every
// `maxAttempts` on it.

type MemoryAdapter = StorageAdapter & { store: Map<string, string>; keys(): string[] }

function memoryAdapter(): MemoryAdapter {
  const store = new Map<string, string>()
  return {
    store,
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
    keys: () => [...store.keys()],
  }
}

/** What an app's `mutate` throws so `isRetryable` can read the status. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** Retry 5xx, 408 and 429; every other 4xx fails the same way on every load. */
const retryableStatus = (err: unknown): boolean =>
  !(err instanceof HttpError) || err.status >= 500 || err.status === 408 || err.status === 429

const seed = (
  adapter: MemoryAdapter,
  prefix: string,
  e: Partial<QueueEntry> & { mutationId: string; runId: string },
) => {
  const entry: QueueEntry = {
    v: PROTOCOL_VERSION,
    variables: {},
    attempts: 0,
    enqueuedAt: Date.now(),
    ...e,
  }
  adapter.store.set(`${prefix}/${entry.mutationId}/${entry.runId}`, JSON.stringify(entry))
  return entry
}

const emptyApp = defineController(() => ({}))

function queueRoot(plugin: OlasPlugin) {
  return createRoot(emptyApp, {
    queries: queryEngine(),
    deps: {},
    onError: () => {},
    plugins: [plugin],
  })
}

/** A registered mutation that throws each status in `statuses` in turn, then succeeds. */
function failingWith(id: string, statuses: number[]) {
  _unregisterMutationById(id)
  const calls: unknown[] = []
  const definition = defineMutation({
    id,
    mutate: async (vars: unknown) => {
      calls.push(vars)
      const status = statuses.shift()
      if (status !== undefined) throw new HttpError(status)
      return 'ok'
    },
    meta: { persist: true },
  })
  return { calls, definition }
}

describe('isRetryable — a replay', () => {
  test('a non-retryable failure drops the entry on its first attempt and reports it', async () => {
    const id = 'retryable/replay-422'
    const { calls } = failingWith(id, [422, 422, 422])
    const prefix = 'retryable/replay-422'
    const adapter = memoryAdapter()
    seed(adapter, prefix, { mutationId: id, runId: 'r1' })
    const errors: Array<{ err: unknown; entry: QueueEntry }> = []
    const attempts: unknown[] = []
    const asked: Array<{ err: unknown; entry: QueueEntry }> = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        maxAttempts: 5,
        isRetryable: (err, entry) => {
          asked.push({ err, entry })
          return retryableStatus(err)
        },
        onReplayError: (err, entry) => errors.push({ err, entry }),
        onReplayAttempt: (err) => attempts.push(err),
      }),
    )
    await root.waitForIdle()

    expect(calls).toHaveLength(1)
    expect(adapter.store.size).toBe(0)
    expect(attempts).toEqual([])
    expect(errors).toHaveLength(1)
    expect((errors[0]?.err as HttpError).status).toBe(422)
    // The entry as it stood when the attempt failed: its first attempt.
    expect(errors[0]?.entry).toMatchObject({ mutationId: id, runId: 'r1', attempts: 1 })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.err).toBe(errors[0]?.err)
    expect(asked[0]?.entry).toMatchObject({ runId: 'r1', attempts: 1 })

    // Nothing is left for the next pass.
    await root.inject(MutationQueue).replayNow()
    expect(calls).toHaveLength(1)
    root.dispose()
  })

  test('a retryable failure keeps the entry and reports an attempt, as without the option', async () => {
    const id = 'retryable/replay-503'
    const { calls } = failingWith(id, [503])
    const prefix = 'retryable/replay-503'
    const adapter = memoryAdapter()
    seed(adapter, prefix, { mutationId: id, runId: 'r1' })
    const errors: unknown[] = []
    const attempts: unknown[] = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        isRetryable: retryableStatus,
        onReplayError: (err) => errors.push(err),
        onReplayAttempt: (err) => attempts.push(err),
      }),
    )
    await root.waitForIdle()

    expect(errors).toEqual([])
    expect(attempts).toHaveLength(1)
    const [kept] = [...adapter.store.values()].map((raw) => JSON.parse(raw) as QueueEntry)
    expect(kept).toMatchObject({ runId: 'r1', attempts: 1 })

    // The next pass succeeds and drops it.
    await root.inject(MutationQueue).replayNow()
    expect(calls).toHaveLength(2)
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('the last allowed attempt is final whatever isRetryable says, and it is not asked', async () => {
    const id = 'retryable/replay-last'
    failingWith(id, [503])
    const prefix = 'retryable/replay-last'
    const adapter = memoryAdapter()
    seed(adapter, prefix, { mutationId: id, runId: 'r1', attempts: 2 })
    const errors: unknown[] = []
    let asked = 0
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        maxAttempts: 3,
        isRetryable: () => {
          asked++
          return true
        },
        onReplayError: (err) => errors.push(err),
      }),
    )
    await root.waitForIdle()

    expect(errors).toHaveLength(1)
    expect(asked).toBe(0)
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('an isRetryable that throws is reported through onWarn, and the entry is kept', async () => {
    const id = 'retryable/replay-throws'
    failingWith(id, [422])
    const prefix = 'retryable/replay-throws'
    const adapter = memoryAdapter()
    seed(adapter, prefix, { mutationId: id, runId: 'r1' })
    const warnings: Array<{ message: string; cause: unknown }> = []
    const errors: unknown[] = []
    const boom = new Error('predicate bug')
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        isRetryable: () => {
          throw boom
        },
        onReplayError: (err) => errors.push(err),
        onWarn: (message, cause) => warnings.push({ message, cause }),
      }),
    )
    await root.waitForIdle()

    expect(errors).toEqual([])
    expect(warnings).toEqual([{ message: expect.stringMatching(/isRetryable threw/), cause: boom }])
    expect(adapter.store.size).toBe(1)
    root.dispose()
  })
})

describe('isRetryable — a live run', () => {
  test('a non-retryable failure drops the entry the run wrote, so no later load replays it', async () => {
    const id = 'retryable/live-422'
    const { calls, definition } = failingWith(id, [422])
    const prefix = 'retryable/live-422'
    const adapter = memoryAdapter()
    const errors: Array<{ err: unknown; entry: QueueEntry }> = []
    const plugin = mutationQueuePlugin({
      storage: adapter,
      keyPrefix: prefix,
      isRetryable: retryableStatus,
      onReplayError: (err, entry) => errors.push({ err, entry }),
    })
    const app = defineController((ctx) => ({ create: createMutation(ctx, definition) }))
    const root = createRoot(app, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    await root.waitForIdle()

    await expect(root.api.create.run({ sku: 'A-1' })).rejects.toBeInstanceOf(HttpError)
    await root.waitForIdle()

    expect(calls).toEqual([{ sku: 'A-1' }])
    expect(adapter.store.size).toBe(0)
    expect(errors).toHaveLength(1)
    expect((errors[0]?.err as HttpError).status).toBe(422)
    expect(errors[0]?.entry).toMatchObject({ mutationId: id, variables: { sku: 'A-1' } })
    root.dispose()

    // A reload finds nothing to replay.
    const reloaded = queueRoot(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    await reloaded.waitForIdle()
    expect(calls).toHaveLength(1)
    reloaded.dispose()
  })

  test('a retryable failure keeps the entry for the next load', async () => {
    const id = 'retryable/live-503'
    const { calls, definition } = failingWith(id, [503])
    const prefix = 'retryable/live-503'
    const adapter = memoryAdapter()
    const errors: unknown[] = []
    const plugin = mutationQueuePlugin({
      storage: adapter,
      keyPrefix: prefix,
      isRetryable: retryableStatus,
      onReplayError: (err) => errors.push(err),
    })
    const app = defineController((ctx) => ({ create: createMutation(ctx, definition) }))
    const root = createRoot(app, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    await root.waitForIdle()

    await expect(root.api.create.run({ sku: 'B-2' })).rejects.toBeInstanceOf(HttpError)
    await root.waitForIdle()
    expect(errors).toEqual([])
    expect(adapter.store.size).toBe(1)
    root.dispose()

    // The next load replays it, and it succeeds.
    const reloaded = queueRoot(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    await reloaded.waitForIdle()
    expect(calls).toEqual([{ sku: 'B-2' }, { sku: 'B-2' }])
    expect(adapter.store.size).toBe(0)
    reloaded.dispose()
  })
})
