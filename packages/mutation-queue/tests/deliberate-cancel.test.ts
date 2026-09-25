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
  const failing = new Map<string, () => void>()
  const refusing = new Map<string, () => void>()
  const server = {
    accepted,
    hold: true,
    accept(body: string) {
      pending.get(body)?.()
    },
    /** Fail a held request, as a 500 would: a failure worth a retry. */
    fail(body: string) {
      failing.get(body)?.()
    },
    /** Refuse a held request, as a 422 would: a failure no retry can fix. */
    refuse(body: string) {
      refusing.get(body)?.()
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
        failing.set(body, () => reject(new Error('500')))
        refusing.set(body, () => reject(new Error('422')))
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
  options: {
    dedupeBy?: (mutationId: string, variables: unknown) => string | undefined
    isRetryable?: (err: unknown) => boolean
  } = {},
  /** Another tab of the same app: the storage and the server it shares. */
  shared?: { adapter: MemoryAdapter; server: ReturnType<typeof fakeServer> },
) {
  _unregisterMutationById(id)
  const adapter = shared?.adapter ?? memoryAdapter()
  const server = shared?.server ?? fakeServer()
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
    // Two screens that edit through the same definition, each with its own run queue.
    defineController((ctx) => ({
      panel: ctx.attach(panel, undefined),
      other: ctx.attach(panel, undefined),
    })),
    {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({ storage: adapter, keyPrefix, onReplayError: () => {}, ...options }),
      ],
    },
  )
  return {
    adapter,
    server,
    root,
    panel: root.api.panel,
    save: root.api.panel.api.save,
    other: root.api.other,
  }
}

/** The drafts on disk, in replay (`seq`) order. */
const storedBodies = (adapter: MemoryAdapter): string[] =>
  [...adapter.store.values()]
    .map((raw) => JSON.parse(raw) as QueueEntry)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((e) => (e.variables as { body: string }).body)

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

describe('mutationQueuePlugin — latest-wins + dedupeBy: the entry holds the newest draft', () => {
  // `dedupeBy` gives one durable entry per key. When the run that wrote it is
  // superseded, the entry stays for the run riding on it, and it has to hold
  // that run's draft: replaying the older one is the stale write the
  // `'superseded'` reason exists to stop.
  const byKey = { dedupeBy: (_id: string, vars: unknown) => (vars as { key: string }).key }

  test('a superseded entry kept for a rider holds its draft, and a replay after the rider is disposed sends it', async () => {
    const { adapter, server, root, panel, save } = autosaveRoot(
      'mq-rider/dispose',
      'test/mq/rider-dispose',
      byKey,
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    const second = save.run({ key: 'doc', body: 'ab' }).catch(() => {})
    await first
    await settle()
    // What a reload would find now: the newer draft.
    expect(storedBodies(adapter)).toEqual(['ab'])

    panel.dispose()
    await second
    await settle()
    expect(storedBodies(adapter)).toEqual(['ab'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['ab'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a rider that fails with a retryable error leaves its own draft for the replay', async () => {
    const { adapter, server, root, save } = autosaveRoot(
      'mq-rider/error',
      'test/mq/rider-error',
      byKey,
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    const second = save.run({ key: 'doc', body: 'ab' }).catch(() => {})
    await first
    await settle()
    server.fail('ab')
    await second
    await settle()
    expect(storedBodies(adapter)).toEqual(['ab'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['ab'])
    root.dispose()
  })

  test('a run that collapses onto an entry kept by dispose makes it hold its draft', async () => {
    const { adapter, server, root, panel, save, other } = autosaveRoot(
      'mq-rider/kept',
      'test/mq/rider-kept',
      byKey,
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    panel.dispose() // 'a' stays for a replay, under the key
    await first
    await settle()

    // The user reopens the document in another screen and types on.
    const second = other.api.save.run({ key: 'doc', body: 'ad' }).catch(() => {})
    await settle()
    expect(storedBodies(adapter)).toEqual(['ad'])
    other.dispose()
    await second
    await settle()

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['ad'])
    root.dispose()
  })

  // A replay of a kept entry is sending the old draft when the user saves a
  // new one. The new run collapses onto the entry and rewrites it. The
  // replay's success then deleted the rewritten entry, so a failure of the
  // new run left nothing for the next load.
  test("a replay's success keeps an entry a collapse rewrote while it was sending", async () => {
    const { adapter, server, root, save } = autosaveRoot(
      'mq-rider/replaying',
      'test/mq/rider-replaying',
      byKey,
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'v1' }).catch(() => {})
    await settle()
    server.fail('v1') // kept for a replay, with its key
    await first
    await settle()

    const replay = root.inject(MutationQueue).replayNow()
    await settle() // the replay's request for 'v1' is out
    const second = save.run({ key: 'doc', body: 'v2' }).catch(() => {})
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.accept('v1')
    await replay
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.fail('v2')
    await second
    await settle()
    // What a reload finds: the newer draft.
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['v1', 'v2'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a replay that fails for good keeps an entry a collapse rewrote while it was sending', async () => {
    const { adapter, server, root, save } = autosaveRoot(
      'mq-rider/replay-refused',
      'test/mq/rider-replay-refused',
      { ...byKey, isRetryable: (err) => (err as Error).message !== '422' },
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'v1' }).catch(() => {})
    await settle()
    server.fail('v1')
    await first
    await settle()

    const replay = root.inject(MutationQueue).replayNow()
    await settle()
    const second = save.run({ key: 'doc', body: 'v2' }).catch(() => {})
    await settle()
    server.refuse('v1') // the queue gives up on v1, not on the v2 riding on its entry
    await replay
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.accept('v2')
    await second
    await settle()
    expect(adapter.store.size).toBe(0)
    expect(server.accepted).toEqual(['v2'])
    root.dispose()
  })

  // The same window across tabs: tab A replays the entry tab B kept, and the
  // user saves again in tab B, whose key it is. Tab A's memory never sees
  // tab B's rewrite, so the check reads the entry's `seq` back from storage.
  test("another tab's replay keeps an entry this tab rewrote while it was sending", async () => {
    const tabB = autosaveRoot('mq-rider/tabs', 'test/mq/rider-tabs', byKey)
    const { adapter, server } = tabB
    await settle()
    const first = tabB.save.run({ key: 'doc', body: 'v1' }).catch(() => {})
    await settle()
    server.fail('v1') // tab B keeps it for a replay, with its key
    await first
    await settle()

    const tabA = autosaveRoot('mq-rider/tabs', 'test/mq/rider-tabs', byKey, { adapter, server })
    await settle() // tab A's startup pass: v1's request is out
    const second = tabB.save.run({ key: 'doc', body: 'v2' }).catch(() => {})
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.accept('v1')
    await tabA.root.waitForIdle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.fail('v2')
    await second
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])
    tabA.root.dispose()
    tabB.root.dispose()
  })

  // The same window with the owner live: two screens save one document, so
  // the second run collapses onto the first run's entry while the first is
  // still sending. The owner's success deleted the entry, and the rider went
  // on with nothing on disk.
  test("an owner's success hands the entry to a rider still sending", async () => {
    const { adapter, server, root, save, other } = autosaveRoot(
      'mq-rider/live-owner',
      'test/mq/rider-live-owner',
      byKey,
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'v1' })
    await settle()
    const second = other.api.save.run({ key: 'doc', body: 'v2' }).catch(() => {})
    await settle()
    expect(storedBodies(adapter)).toEqual(['v1'])

    server.accept('v1')
    await first
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.fail('v2')
    await second
    await settle()
    expect(storedBodies(adapter)).toEqual(['v2'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['v1', 'v2'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a retry that collapses onto the entry of a failed run makes it hold the newer draft', async () => {
    const { adapter, server, root, save } = autosaveRoot(
      'mq-rider/retry',
      'test/mq/rider-retry',
      byKey,
    )
    await settle()

    const first = save.run({ key: 'doc', body: 'a' }).catch(() => {})
    await settle()
    server.fail('a') // kept for a replay, with its key
    await first
    await settle()

    const retry = save.run({ key: 'doc', body: 'ad' }).catch(() => {})
    await settle()
    server.fail('ad')
    await retry
    await settle()
    expect(storedBodies(adapter)).toEqual(['ad'])

    server.hold = false
    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(server.accepted).toEqual(['ad'])
    root.dispose()
  })
})
