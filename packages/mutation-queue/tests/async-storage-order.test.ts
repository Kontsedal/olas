import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  type MutationEvent,
  type OlasPlugin,
  type PluginHost,
  type QueryHost,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { describe, expect, test } from 'vitest'
import { mutationQueuePlugin } from '../src'

// The queue's `pendingWrites` guard, against a storage whose writes and
// deletes are promises that settle in whatever order the test picks. An
// async store like IndexedDB gives no ordering between two requests the
// queue has in flight at once, so a `delete` issued while its entry's `write`
// is pending can land first. The write then lands after it and leaves an
// entry for a run that already settled: a replay of a finished write.

type Op = { kind: 'set' | 'delete'; key: string; land: () => void }

/**
 * A `StorageAdapter` whose `set` and `delete` stay pending until the test
 * lands them. An op changes the store when it lands, not when it is issued,
 * as a real async store commits. `get` and `keys` answer at once.
 */
function asyncStorage(): StorageAdapter & {
  store: Map<string, string>
  pending: Op[]
  landNewestFirst(): Promise<void>
} {
  const store = new Map<string, string>()
  const pending: Op[] = []
  const hold = (kind: Op['kind'], key: string, apply: () => void): Promise<void> =>
    new Promise<void>((resolve) => {
      const op: Op = {
        kind,
        key,
        land: () => {
          pending.splice(pending.indexOf(op), 1)
          apply()
          resolve()
        },
      }
      pending.push(op)
    })
  return {
    store,
    pending,
    get: async (key) => store.get(key) ?? null,
    set: (key, value) => hold('set', key, () => store.set(key, value)),
    delete: (key) =>
      hold('delete', key, () => {
        store.delete(key)
      }),
    keys: async () => [...store.keys()],
    /**
     * Land every pending op, the newest first, until none is left, letting
     * the queue's continuations run between two landings. Newest first is the
     * order in which a delete overtakes the write it follows.
     */
    async landNewestFirst() {
      await settle()
      while (pending.length > 0) {
        pending[pending.length - 1]?.land()
        await settle()
      }
    },
  }
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush()
}

/**
 * A fake online host with no registered definitions, as in `plugin.test.ts`.
 * `setup` requires a query host; these tests never reach it, so a stub does.
 */
function directHooks(plugin: OlasPlugin) {
  const host: PluginHost = {
    deps: {},
    provide() {},
    reportError() {},
    onDispose() {},
    track() {},
    network: { isOnline: () => true, onReconnect: () => () => {}, onFocus: () => () => {} },
    queries: {} as QueryHost,
    mutations: {
      has: () => false,
      get: () => undefined,
      run: () => Promise.reject(new Error('no definitions')),
    },
    debug() {},
  }
  const hooks = plugin.setup(host) ?? {}
  const mutation = { id: 'order/create', meta: { persist: true } }
  const emit = (event: Omit<MutationEvent, 'origin'>) =>
    hooks.onMutation?.({ ...event, origin: undefined })
  return {
    /** `start`, then the first attempt, which issues the write. */
    enqueue(runId: string, variables: unknown) {
      emit({ mutation, runId, variables, phase: 'start' })
      void hooks.wrapMutate?.(
        {
          mutation,
          runId,
          variables,
          signal: new AbortController().signal,
          attempt: 0,
          origin: undefined,
        },
        () => Promise.resolve(undefined),
      )
    },
    settle(runId: string, phase: 'success' | 'error') {
      emit({ mutation, runId, variables: undefined, phase })
    },
    dispose() {
      hooks.dispose?.()
    },
  }
}

describe('mutation queue on an async storage — a delete never overtakes its write', () => {
  test('a run that settles while its write is pending issues its delete only after the write lands', async () => {
    const storage = asyncStorage()
    const hooks = directHooks(
      mutationQueuePlugin({ storage, keyPrefix: 'async/order', maxAttempts: 1 }),
    )
    await settle()

    hooks.enqueue('run-1', { sku: 'A-1' })
    hooks.settle('run-1', 'success')
    await settle()
    // Only the write is in flight. The delete waits for it.
    expect(storage.pending.map((op) => op.kind)).toEqual(['set'])

    await storage.landNewestFirst()
    expect(storage.store.size).toBe(0)
    hooks.dispose()
  })

  test('the same holds for a run dropped at maxAttempts', async () => {
    const storage = asyncStorage()
    const hooks = directHooks(
      mutationQueuePlugin({
        storage,
        keyPrefix: 'async/order',
        maxAttempts: 0,
        onReplayError: () => {},
      }),
    )
    await settle()

    hooks.enqueue('run-1', { sku: 'A-1' })
    hooks.settle('run-1', 'error')
    await settle()
    expect(storage.pending.map((op) => op.kind)).toEqual(['set'])

    await storage.landNewestFirst()
    expect(storage.store.size).toBe(0)
    hooks.dispose()
  })

  test('a dedupeBy collapse that succeeds while the owner is still writing does not leave the owner to replay', async () => {
    // Run A writes its entry and waits for the write before its request goes
    // out. Run B carries the same idempotency key, so it collapses onto A's
    // entry, writes nothing, and goes out at once. B's success drops A's
    // entry, since the server has the write. A then fails. Had B's delete
    // landed before A's write, A's entry would be on disk after that failure,
    // and the next load would send the write a third time.
    const id = 'async/collapse'
    _unregisterMutationById(id)
    let calls = 0
    const create = defineMutation({
      id,
      mutate: async (_vars: { key: string }) => {
        calls++
        if (calls === 2) throw new Error('409: already created')
        return 'created'
      },
      meta: { persist: true },
    })
    const storage = asyncStorage()
    const app = defineController((ctx) => ({ create: createMutation(ctx, create) }))
    const root = createRoot(app, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({
          storage,
          keyPrefix: 'async/collapse',
          dedupeBy: (_id, vars) => (vars as { key: string }).key,
        }),
      ],
    })
    await settle()

    const a = root.api.create.run({ key: 'k' }).catch((err: unknown) => err)
    const b = root.api.create.run({ key: 'k' })
    await expect(b).resolves.toBe('created')
    await settle()
    // B's delete waits behind A's write.
    expect(storage.pending.map((op) => op.kind)).toEqual(['set'])

    await storage.landNewestFirst()
    expect(await a).toBeInstanceOf(Error)
    expect(calls).toBe(2)
    expect(storage.pending).toEqual([])
    expect(storage.store.size).toBe(0)
    root.dispose()
  })
})
