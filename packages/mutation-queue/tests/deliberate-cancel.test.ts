import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  type Mutation,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { describe, expect, test } from 'vitest'
import { MutationQueue, mutationQueuePlugin } from '../src'

// A `'cancel'` carries its reason. A `latest-wins` supersede and `reset()` are
// the app dropping a run on purpose, so the queue drops its entry: replaying
// it later would send a write the app replaced or withdrew, over the newer
// one. The owning controller disposing only means the screen is gone, so that
// entry stays for a replay.

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

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/**
 * A fake server. While `hold` is on, each request stays pending until the
 * test accepts it, and rejects when its signal fires. With `hold` off, it
 * accepts at once: that is how a replay finds it. `accepted` is the order
 * the server took the writes in.
 */
function fakeServer() {
  const accepted: string[] = []
  const pending = new Map<string, () => void>()
  const server = {
    accepted,
    hold: true,
    accept(body: string) {
      pending.get(body)?.()
    },
    request(body: string, signal: AbortSignal): Promise<string> {
      if (!server.hold) {
        accepted.push(body)
        return Promise.resolve(body)
      }
      return new Promise<string>((resolve, reject) => {
        pending.set(body, () => {
          accepted.push(body)
          resolve(body)
        })
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      })
    },
  }
  return server
}

function autosaveRoot(
  id: string,
  keyPrefix: string,
  options: { dedupeBy?: (mutationId: string, variables: unknown) => string | undefined } = {},
) {
  _unregisterMutationById(id)
  const adapter = memoryAdapter()
  const server = fakeServer()
  const autosave = defineMutation({
    id,
    concurrency: 'latest-wins',
    meta: { persist: true },
    mutate: (draft: { key: string; body: string }, { signal }) =>
      server.request(draft.body, signal),
  })
  const panel = defineController((ctx) => ({
    save: createMutation(ctx, autosave) as Mutation<{ key: string; body: string }, string>,
  }))
  const root = createRoot(
    defineController((ctx) => ({ panel: ctx.attach(panel, undefined) })),
    {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix, ...options })],
    },
  )
  return { adapter, server, root, panel: root.api.panel, save: root.api.panel.api.save }
}

describe('mutationQueuePlugin — a deliberate cancel drops the entry', () => {
  test('a superseded latest-wins run is not replayed over the newer write', async () => {
    const { adapter, server, root, save } = autosaveRoot('mq-cancel/autosave', 'test/mq/autosave')
    await settle() // the startup pass, so `replayNow()` below is not a no-op

    const first = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle() // 'a' is on disk and its request is out
    expect(adapter.store.size).toBe(1)
    const second = save.run({ key: 'doc', body: 'ab' })
    await first
    await settle()
    server.accept('ab')
    await second
    await settle()
    // 'a' was replaced by the app, not interrupted by a reload.
    expect(adapter.store.size).toBe(0)

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['ab'])
    root.dispose()
  })

  test('reset() drops the entry of the run it cancels', async () => {
    const { adapter, server, root, save } = autosaveRoot('mq-cancel/reset', 'test/mq/reset')
    await settle()

    const run = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    expect(adapter.store.size).toBe(1)
    save.reset()
    await run
    await settle()
    expect(adapter.store.size).toBe(0)

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual([])
    root.dispose()
  })

  test('the owning controller disposing keeps the entry, and a replay sends it', async () => {
    const { adapter, server, root, panel, save } = autosaveRoot(
      'mq-cancel/dispose',
      'test/mq/dispose',
    )
    await settle()

    const run = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    panel.dispose() // the screen closed; the user still asked for the write
    await run
    await settle()
    expect(adapter.store.size).toBe(1)

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['a'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a superseded entry stays while a dedupeBy collapse still rides on it', async () => {
    // B carries A's idempotency key, so it collapses onto A's entry and writes
    // none of its own. A's cancel arrives after B started: dropping A's entry
    // then would leave B in flight with nothing on disk.
    const { adapter, server, root, save } = autosaveRoot('mq-cancel/collapse', 'test/mq/collapse', {
      dedupeBy: (_id, vars) => (vars as { key: string }).key,
    })
    await settle()

    const first = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    const second = save.run({ key: 'doc', body: 'ab' })
    await first
    await settle()
    expect(adapter.store.size).toBe(1) // B is still in flight on A's entry

    server.accept('ab')
    await second
    await settle()
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })
})
