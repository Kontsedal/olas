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
import { MutationQueue, mutationQueuePlugin, type QueueEntry } from '../src'

// A `serial` run that waits behind another is persisted when it is queued,
// not when it starts. Otherwise a first request that hangs or backs off
// leaves only itself on disk, and a reload loses everything queued behind it.

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

/** The stored entries' variables, in replay (`seq`) order. */
const storedItems = (adapter: MemoryAdapter): unknown[] =>
  [...adapter.store.values()]
    .map((raw) => JSON.parse(raw) as QueueEntry)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((e) => e.variables)

/**
 * A fake server. While `hold` is on, a request stays pending until the test
 * accepts it; with `hold` off it accepts at once. `calls` records every
 * request the app sent, in order.
 */
function fakeServer() {
  const calls: string[] = []
  const pending = new Map<string, () => void>()
  const server = {
    calls,
    hold: true,
    accept(item: string) {
      pending.get(item)?.()
    },
    request(item: string): Promise<string> {
      calls.push(item)
      if (!server.hold) return Promise.resolve(item)
      return new Promise<string>((resolve) => {
        pending.set(item, () => resolve(item))
      })
    },
  }
  return server
}

function defineItems(id: string, server: ReturnType<typeof fakeServer>) {
  _unregisterMutationById(id)
  return defineMutation({
    id,
    concurrency: 'serial',
    meta: { persist: true },
    mutate: (item: string) => server.request(item),
  })
}

function serialRoot(
  id: string,
  keyPrefix: string,
  hooks: { onMutate?: (item: string) => void } = {},
  adapter: MemoryAdapter = memoryAdapter(),
) {
  const server = fakeServer()
  const items = defineItems(id, server)
  const panel = defineController((ctx) => ({
    add: createMutation(ctx, items, hooks) as Mutation<string, string>,
  }))
  const root = createRoot(
    defineController((ctx) => ({ panel: ctx.attach(panel, undefined) })),
    {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix })],
    },
  )
  return { adapter, server, root, panel: root.api.panel, add: root.api.panel.api.add }
}

describe('mutationQueuePlugin — queued serial runs are durable', () => {
  test('runs queued behind a hanging request are on disk, and a reload replays all of them in order', async () => {
    const id = 'mq-serial/reload'
    const keyPrefix = 'test/mq/serial-reload'
    const { adapter, root, add } = serialRoot(id, keyPrefix)
    await settle()

    for (const item of ['1', '2', '3']) void add.run(item).catch(() => {})
    await settle()
    expect(storedItems(adapter)).toEqual(['1', '2', '3'])

    // The reload: the root goes away and plugins hear nothing of it.
    root.dispose()

    const server = fakeServer()
    server.hold = false
    defineItems(id, server)
    const next = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix })],
      },
    )
    await next.waitForIdle()
    expect(server.calls).toEqual(['1', '2', '3'])
    expect(adapter.store.size).toBe(0)
    next.dispose()
  })

  test('reset() drops the queued entries with the active one', async () => {
    const { adapter, root, add } = serialRoot('mq-serial/reset', 'test/mq/serial-reset')
    await settle()

    const runs = ['1', '2', '3'].map((item) => add.run(item).catch(() => {}))
    await settle()
    expect(adapter.store.size).toBe(3)
    add.reset()
    await Promise.all(runs)
    await settle()
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('the owner disposing keeps the queued entries, and a replay sends them in order', async () => {
    const { adapter, server, root, panel, add } = serialRoot(
      'mq-serial/dispose',
      'test/mq/serial-dispose',
    )
    await settle()

    const runs = ['1', '2', '3'].map((item) => add.run(item).catch(() => {}))
    await settle()
    panel.dispose()
    await Promise.all(runs)
    await settle()
    expect(storedItems(adapter)).toEqual(['1', '2', '3'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.calls).toEqual(['1', '1', '2', '3'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a replay pass skips a queued run: the live queue sends it', async () => {
    const { adapter, server, root, add } = serialRoot('mq-serial/skip', 'test/mq/serial-skip')
    await settle()

    const one = add.run('1')
    const two = add.run('2')
    await settle()
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.calls).toEqual(['1']) // '2' waits for the live queue

    server.accept('1')
    await one
    await settle()
    server.accept('2')
    await two
    await settle()
    expect(server.calls).toEqual(['1', '2'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a queued run whose onMutate throws leaves no entry behind', async () => {
    // The same failure on a run that did not wait persists nothing, since the
    // run never reaches `mutate`.
    const { adapter, server, root, add } = serialRoot('mq-serial/onmutate', 'test/mq/serial-om', {
      onMutate: (item) => {
        if (item === '2') throw new Error('optimistic setup failed')
      },
    })
    await settle()

    const one = add.run('1')
    const two = add.run('2').catch(() => {})
    await settle()
    expect(adapter.store.size).toBe(2)
    server.accept('1')
    await one
    await two
    await settle()
    expect(adapter.store.size).toBe(0)

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.calls).toEqual(['1'])
    root.dispose()
  })
})

describe('mutationQueuePlugin — serial + dedupeBy: a queued run is durable on its own', () => {
  // A `dedupeBy` collapse makes a run ride on another run's entry. A queued
  // `serial` run would ride on the run ahead of it, which settles before the
  // queued run even starts: its success drops the entry, and the queued run
  // then goes out with nothing on disk. So a queued run never collapses.
  type Draft = { key: string; body: string }

  function draftsRoot(id: string, keyPrefix: string, adapter: MemoryAdapter = memoryAdapter()) {
    _unregisterMutationById(id)
    const server = fakeServer()
    const save = defineMutation({
      id,
      concurrency: 'serial',
      meta: { persist: true },
      mutate: (draft: Draft) => server.request(draft.body),
    })
    const panel = defineController((ctx) => ({
      save: createMutation(ctx, save) as Mutation<Draft, string>,
    }))
    const root = createRoot(
      defineController((ctx) => ({
        panel: ctx.attach(panel, undefined),
        other: ctx.attach(panel, undefined),
      })),
      {
        queries: queryEngine(),
        deps: {},
        onError: () => {},
        plugins: [
          mutationQueuePlugin({
            storage: adapter,
            keyPrefix,
            dedupeBy: (_id, vars) => (vars as Draft).key,
          }),
        ],
      },
    )
    return { adapter, server, root, panel: root.api.panel, other: root.api.other }
  }

  const bodies = (adapter: MemoryAdapter): string[] =>
    storedItems(adapter).map((v) => (v as Draft).body)

  /** A fresh root on the same storage, the way a reload finds it. */
  function reload(id: string, keyPrefix: string, adapter: MemoryAdapter) {
    const server = fakeServer()
    server.hold = false
    _unregisterMutationById(id)
    defineMutation({
      id,
      concurrency: 'serial',
      meta: { persist: true },
      mutate: (draft: Draft) => server.request(draft.body),
    })
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          mutationQueuePlugin({
            storage: adapter,
            keyPrefix,
            dedupeBy: (_id, vars) => (vars as Draft).key,
          }),
        ],
      },
    )
    return { server, root }
  }

  test('a queued run with the key of the run ahead has its own entry, which outlives that run', async () => {
    const id = 'mq-serial-dedupe/own-entry'
    const keyPrefix = 'test/mq/serial-dedupe-own'
    const { adapter, server, root, panel } = draftsRoot(id, keyPrefix)
    await settle()

    const one = panel.api.save.run({ key: 'doc', body: 'a' })
    void panel.api.save.run({ key: 'doc', body: 'ab' }).catch(() => {})
    await settle()
    // What a reload while 'a' hangs would find: both, in call order.
    expect(bodies(adapter)).toEqual(['a', 'ab'])

    server.accept('a')
    await one
    await settle()
    // 'ab' is in flight now, and still on disk.
    expect(server.calls).toEqual(['a', 'ab'])
    expect(bodies(adapter)).toEqual(['ab'])

    root.dispose() // the reload
    const next = reload(id, keyPrefix, adapter)
    await next.root.waitForIdle()
    expect(next.server.calls).toEqual(['ab'])
    expect(adapter.store.size).toBe(0)
    next.root.dispose()
  })

  test('a reload while the run ahead hangs replays both runs, in order', async () => {
    const id = 'mq-serial-dedupe/reload'
    const keyPrefix = 'test/mq/serial-dedupe-reload'
    const { adapter, root, panel } = draftsRoot(id, keyPrefix)
    await settle()

    void panel.api.save.run({ key: 'doc', body: 'a' }).catch(() => {})
    void panel.api.save.run({ key: 'doc', body: 'ab' }).catch(() => {})
    await settle()
    root.dispose()

    const next = reload(id, keyPrefix, adapter)
    await next.root.waitForIdle()
    expect(next.server.calls).toEqual(['a', 'ab'])
    expect(adapter.store.size).toBe(0)
    next.root.dispose()
  })

  test('the owner disposing keeps both entries, and a replay sends both in order', async () => {
    const { adapter, server, root, panel } = draftsRoot(
      'mq-serial-dedupe/dispose',
      'test/mq/serial-dedupe-dispose',
    )
    await settle()

    const runs = [
      panel.api.save.run({ key: 'doc', body: 'a' }).catch(() => {}),
      panel.api.save.run({ key: 'doc', body: 'ab' }).catch(() => {}),
    ]
    await settle()
    panel.dispose()
    await Promise.all(runs)
    await settle()
    expect(bodies(adapter)).toEqual(['a', 'ab'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.calls).toEqual(['a', 'a', 'ab'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('after a dispose, a run under the same key that succeeds leaves no older draft to replay', async () => {
    // Both drafts stay when the screen closes. The user reopens the document
    // and saves 'abc', which lands. Replaying 'a' or 'ab' after it would put
    // the server back on an older draft.
    const { adapter, server, root, panel, other } = draftsRoot(
      'mq-serial-dedupe/reopen',
      'test/mq/serial-dedupe-reopen',
    )
    await settle()

    const runs = [
      panel.api.save.run({ key: 'doc', body: 'a' }).catch(() => {}),
      panel.api.save.run({ key: 'doc', body: 'ab' }).catch(() => {}),
    ]
    await settle()
    panel.dispose()
    await Promise.all(runs)
    await settle()

    const reopened = other.api.save.run({ key: 'doc', body: 'abc' })
    await settle()
    server.accept('abc')
    await reopened
    await settle()
    expect(adapter.store.size).toBe(0)

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.calls).toEqual(['a', 'abc'])
    root.dispose()
  })
})
