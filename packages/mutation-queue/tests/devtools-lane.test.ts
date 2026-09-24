import {
  createMutation,
  createRoot,
  type DebugEvent,
  defineController,
  defineMutation,
  type OlasPlugin,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { describe, expect, test } from 'vitest'
import {
  MUTATION_QUEUE_PLUGIN_NAME,
  MutationQueue,
  mutationQueuePlugin,
  PROTOCOL_VERSION,
  type QueueEntry,
} from '../src'

// The queue's devtools lane: `host.debug` payloads for each replay attempt,
// its result, and each entry a pass skipped. Vitest runs with `__DEV__` on;
// the production build strips every one of these calls.

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
}

/**
 * A root with the queue and an empty store, so the startup pass does nothing.
 * The test seeds storage afterwards and drives a pass with `replayNow()`,
 * after it has subscribed to the lane.
 */
function laneRoot(plugin: OlasPlugin) {
  const root = createRoot(
    defineController(() => ({})),
    { queries: queryEngine(), deps: {}, onError: () => {}, plugins: [plugin] },
  )
  const lane: unknown[] = []
  root.debug.subscribe((e: DebugEvent) => {
    if (e.type === 'plugin:event' && e.plugin === MUTATION_QUEUE_PLUGIN_NAME) lane.push(e.payload)
  })
  return { root, lane, replay: () => root.inject(MutationQueue).replayNow() }
}

function registered(id: string, mutate: (vars: unknown) => Promise<unknown>, persist = true) {
  _unregisterMutationById(id)
  return defineMutation({ id, mutate, meta: { persist } })
}

describe('mutation queue — devtools lane', () => {
  test('a replay that succeeds reports its attempt, then its result', async () => {
    const id = 'lane/success'
    registered(id, async () => 'ok')
    const adapter = memoryAdapter()
    const { root, lane, replay } = laneRoot(
      mutationQueuePlugin({ storage: adapter, keyPrefix: id }),
    )
    await root.waitForIdle()
    seed(adapter, id, { mutationId: id, runId: 'r1', attempts: 1 })
    await replay()

    expect(lane).toEqual([
      { kind: 'replay:attempt', mutationId: id, runId: 'r1', attempt: 2 },
      { kind: 'replay:result', mutationId: id, runId: 'r1', attempt: 2, result: 'success' },
    ])
    root.dispose()
  })

  test('a failed attempt reports whether the entry stays: retry-later, not-retryable or max-attempts', async () => {
    const id = 'lane/failures'
    const failure = Object.assign(new Error('HTTP 422'), { status: 422 })
    const outage = Object.assign(new Error('HTTP 503'), { status: 503 })
    registered(id, async (vars) => {
      throw (vars as { status: number }).status === 422 ? failure : outage
    })
    const adapter = memoryAdapter()
    const { root, lane, replay } = laneRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: id,
        maxAttempts: 3,
        isRetryable: (err) => (err as { status: number }).status >= 500,
        onReplayError: () => {},
      }),
    )
    await root.waitForIdle()
    seed(adapter, id, { mutationId: id, runId: 'a', variables: { status: 503 }, seq: 1 })
    seed(adapter, id, { mutationId: id, runId: 'b', variables: { status: 422 }, seq: 2 })
    seed(adapter, id, {
      mutationId: id,
      runId: 'c',
      variables: { status: 503 },
      seq: 3,
      attempts: 2,
    })
    await replay()

    const results = lane.filter((p) => (p as { kind: string }).kind === 'replay:result')
    expect(results).toEqual([
      {
        kind: 'replay:result',
        mutationId: id,
        runId: 'a',
        attempt: 1,
        result: 'retry-later',
        error: outage,
      },
      {
        kind: 'replay:result',
        mutationId: id,
        runId: 'b',
        attempt: 1,
        result: 'not-retryable',
        error: failure,
      },
      {
        kind: 'replay:result',
        mutationId: id,
        runId: 'c',
        attempt: 3,
        result: 'max-attempts',
        error: outage,
      },
    ])
    root.dispose()
  })

  test('an attempt that ends in an AbortError reports aborted and keeps the entry', async () => {
    const id = 'lane/aborted'
    registered(id, async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    const adapter = memoryAdapter()
    const { root, lane, replay } = laneRoot(
      mutationQueuePlugin({ storage: adapter, keyPrefix: id }),
    )
    await root.waitForIdle()
    seed(adapter, id, { mutationId: id, runId: 'r1' })
    await replay()

    expect(lane).toContainEqual({
      kind: 'replay:result',
      mutationId: id,
      runId: 'r1',
      attempt: 1,
      result: 'aborted',
    })
    expect(adapter.store.size).toBe(1)
    root.dispose()
  })

  test('a pass reports each entry it skips without an attempt, and why', async () => {
    const prefix = 'lane/skips'
    registered('lane/skips-opted-out', async () => 'ok', false)
    registered('lane/skips-exhausted', async () => 'ok')
    _unregisterMutationById('lane/skips-unknown')
    const adapter = memoryAdapter()
    const { root, lane, replay } = laneRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        maxAttempts: 2,
        ttlMs: 60_000,
        onReplayError: () => {},
      }),
    )
    await root.waitForIdle()
    seed(adapter, prefix, { mutationId: 'lane/skips-unknown', runId: 'u' })
    seed(adapter, prefix, { mutationId: 'lane/skips-opted-out', runId: 'o' })
    seed(adapter, prefix, { mutationId: 'lane/skips-exhausted', runId: 'x', attempts: 2 })
    seed(adapter, prefix, {
      mutationId: 'lane/skips-exhausted',
      runId: 't',
      enqueuedAt: Date.now() - 120_000,
    })
    await replay()

    expect(lane).toEqual(
      expect.arrayContaining([
        {
          kind: 'replay:skipped',
          mutationId: 'lane/skips-unknown',
          runId: 'u',
          reason: 'not-registered',
        },
        {
          kind: 'replay:skipped',
          mutationId: 'lane/skips-opted-out',
          runId: 'o',
          reason: 'not-persisted',
        },
        {
          kind: 'replay:skipped',
          mutationId: 'lane/skips-exhausted',
          runId: 'x',
          reason: 'max-attempts',
        },
        {
          kind: 'replay:skipped',
          mutationId: 'lane/skips-exhausted',
          runId: 't',
          reason: 'ttl-expired',
        },
      ]),
    )
    expect(lane).toHaveLength(4)
    root.dispose()
  })

  test('a pass that meets a run executing in this tab reports it as in-flight', async () => {
    const id = 'lane/in-flight'
    let release: (value: string) => void = () => {}
    const save = registered(
      id,
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const adapter = memoryAdapter()
    const plugin = mutationQueuePlugin({ storage: adapter, keyPrefix: id })
    const root = createRoot(
      defineController((ctx) => ({ save: createMutation(ctx, save) })),
      { queries: queryEngine(), deps: {}, plugins: [plugin] },
    )
    await root.waitForIdle()
    const lane: unknown[] = []
    root.debug.subscribe((e) => {
      if (e.type === 'plugin:event' && e.plugin === MUTATION_QUEUE_PLUGIN_NAME) lane.push(e.payload)
    })

    const run = root.api.save.run({ n: 1 })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const [entry] = [...adapter.store.values()].map((raw) => JSON.parse(raw) as QueueEntry)
    await root.inject(MutationQueue).replayNow()

    expect(lane).toEqual([
      { kind: 'replay:skipped', mutationId: id, runId: entry?.runId, reason: 'in-flight' },
    ])
    release('done')
    await run
    root.dispose()
  })
})
