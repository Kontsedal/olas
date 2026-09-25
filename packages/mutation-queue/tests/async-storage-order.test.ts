import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  isAbortError,
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

describe('mutation queue on an async storage — a run superseded during its write sends nothing', () => {
  test('a latest-wins run superseded while its entry is being written never calls mutate', async () => {
    // The queue holds a run's first attempt until its entry is written. A
    // supersede during that write aborts the run, and `mutate` must not be
    // called once the write lands: a `mutate` that ignores its signal would
    // send the stale draft after all.
    const id = 'async/supersede-during-write'
    _unregisterMutationById(id)
    const sent: string[] = []
    const autosave = defineMutation({
      id,
      concurrency: 'latest-wins',
      meta: { persist: true },
      // Ignores its signal, as plenty of real `mutate` functions do.
      mutate: (draft: string) => {
        sent.push(draft)
        return Promise.resolve(draft)
      },
    })
    const storage = asyncStorage()
    const app = defineController((ctx) => ({ save: createMutation(ctx, autosave) }))
    const root = createRoot(app, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ storage, keyPrefix: 'async/supersede' })],
    })
    await settle()

    const first = root.api.save.run('a').catch((err: unknown) => err)
    await settle()
    const second = root.api.save.run('ab')
    await settle()
    // Both entries are still being written; neither request went out.
    expect(storage.pending.map((op) => op.kind)).toEqual(['set', 'set'])
    expect(sent).toEqual([])

    // The superseded run's write lands first.
    storage.pending[0]?.land()
    await settle()
    expect(sent).toEqual([])

    await storage.landNewestFirst()
    await expect(second).resolves.toBe('ab')
    expect(isAbortError(await first)).toBe(true)
    expect(sent).toEqual(['ab'])
    await storage.landNewestFirst()
    expect(storage.store.size).toBe(0)
    root.dispose()
  })
})

describe('mutation queue on an async storage — a collapse waits for its rewrite', () => {
  test('a run that collapses onto the entry of a settled run goes out once the entry holds its variables', async () => {
    // The first screen closed with 'a' in flight, so its entry stays. A run
    // in a second screen collapses onto it and rewrites it with 'ad'. Its
    // request waits for that rewrite: sent first, a crash before the rewrite
    // lands would replay 'a' over the 'ad' the server may already have.
    const id = 'async/collapse-rewrite'
    _unregisterMutationById(id)
    type Draft = { key: string; body: string }
    const sent: string[] = []
    const autosave = defineMutation({
      id,
      concurrency: 'latest-wins',
      meta: { persist: true },
      mutate: (draft: Draft, { signal }) => {
        sent.push(draft.body)
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      },
    })
    const storage = asyncStorage()
    const screen = defineController((ctx) => ({ save: createMutation(ctx, autosave) }))
    const root = createRoot(
      defineController((ctx) => ({
        first: ctx.attach(screen, undefined),
        second: ctx.attach(screen, undefined),
      })),
      {
        queries: queryEngine(),
        deps: {},
        onError: () => {},
        plugins: [
          mutationQueuePlugin({
            storage,
            keyPrefix: 'async/collapse-rewrite',
            dedupeBy: (_id, vars) => (vars as Draft).key,
          }),
        ],
      },
    )
    await settle()

    const first = root.api.first.api.save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await storage.landNewestFirst()
    expect(sent).toEqual(['a'])
    root.api.first.dispose()
    await first
    await settle()

    void root.api.second.api.save.run({ key: 'doc', body: 'ad' }).catch(() => {})
    await settle()
    expect(storage.pending.map((op) => op.kind)).toEqual(['set'])
    expect(sent).toEqual(['a'])

    await storage.landNewestFirst()
    expect(sent).toEqual(['a', 'ad'])
    const stored = [...storage.store.values()].map((raw) => JSON.parse(raw).variables.body)
    expect(stored).toEqual(['ad'])
    root.dispose()
  })
})
