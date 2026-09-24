import { createRoot, defineController, defineMutation, queryEngine } from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MutationQueue, mutationQueuePlugin, PROTOCOL_VERSION, type QueueEntry } from '../src'

// Cross-tab replay coordination (`withReplayLock`): the Web Locks path, the
// TTL'd localStorage lease used when Web Locks is missing, and the
// uncoordinated fallback when neither primitive exists. The lock and lease are
// named `olas-mq:<keyPrefix>`, so every tab of one app contends for the same one.

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

/** A `Storage` over a Map — stands in for `localStorage`, which node lacks. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush()
}

const emptyApp = defineController(() => ({}))

/**
 * Register a persistable mutation under `id` that counts its calls, and seed
 * one pending entry for it under `prefix`.
 */
function pendingReplay(id: string, prefix: string) {
  _unregisterMutationById(id)
  const calls: unknown[] = []
  defineMutation({
    id,
    mutate: async (vars: unknown) => {
      calls.push(vars)
    },
    meta: { persist: true },
  })
  const adapter = memoryAdapter()
  const entry: QueueEntry = {
    v: PROTOCOL_VERSION,
    mutationId: id,
    runId: 'r1',
    variables: 'payload',
    attempts: 0,
    enqueuedAt: Date.now(),
  }
  adapter.store.set(`${prefix}/${id}/r1`, JSON.stringify(entry))
  return { adapter, calls }
}

function queueRoot(
  adapter: StorageAdapter,
  prefix: string,
  onWarn?: (m: string, c?: unknown) => void,
) {
  return createRoot(emptyApp, {
    queries: queryEngine(),
    deps: {},
    plugins: [
      mutationQueuePlugin({ storage: adapter, keyPrefix: prefix, ...(onWarn ? { onWarn } : {}) }),
    ],
  })
}

/** Web Locks unavailable (older Safari): only `onLine`, no `locks`. */
function withoutWebLocks(storage: Storage) {
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('localStorage', storage)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('replay lock — Web Locks', () => {
  test('a pass that cannot get the lock skips; the holder replays for it', async () => {
    const prefix = 'cov/lock/held'
    const { adapter, calls } = pendingReplay('cov/lock-held', prefix)
    let releaseLock: () => void = () => {}
    // Another tab holds the app's replay lock.
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    let acquired: () => void = () => {}
    const holding = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const otherTab = navigator.locks.request(`olas-mq:${prefix}`, () => {
      acquired()
      return held
    })
    await holding

    const root = queueRoot(adapter, prefix)
    await root.waitForIdle()
    expect(calls).toEqual([])
    expect(adapter.store.size).toBe(1)

    releaseLock()
    await otherTab
    await root.inject(MutationQueue).replayNow()
    expect(calls).toEqual(['payload'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })
})

describe('replay lock — localStorage lease fallback', () => {
  test('the lease is held for the pass, refreshed by a heartbeat, and released after', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    withoutWebLocks(storage)
    const prefix = 'cov/lease/heartbeat'
    const id = 'cov/lease-heartbeat'
    _unregisterMutationById(id)
    let release: () => void = () => {}
    let calls = 0
    defineMutation({
      id,
      mutate: () => {
        calls += 1
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
      meta: { persist: true },
    })
    const adapter = memoryAdapter()
    adapter.store.set(
      `${prefix}/${id}/r1`,
      JSON.stringify({
        v: PROTOCOL_VERSION,
        mutationId: id,
        runId: 'r1',
        variables: null,
        attempts: 0,
        enqueuedAt: Date.now(),
      }),
    )
    const leaseKey = `olas-mq:${prefix}:lease`

    const root = queueRoot(adapter, prefix)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    const first = storage.getItem(leaseKey)
    expect(first).toMatch(/^\d+:[a-z0-9]+$/)
    const [firstTs, leaseId] = (first as string).split(':')

    await vi.advanceTimersByTimeAsync(15_000)
    const refreshed = storage.getItem(leaseKey) as string
    expect(refreshed.endsWith(`:${leaseId}`)).toBe(true)
    expect(Number(refreshed.split(':')[0])).toBe(Number(firstTs) + 15_000)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.store.size).toBe(0)
    expect(storage.getItem(leaseKey)).toBeNull()
    root.dispose()
  })

  test('a fresh lease held by another tab skips the pass and is left alone', async () => {
    const storage = memoryStorage()
    withoutWebLocks(storage)
    const prefix = 'cov/lease/fresh'
    const { adapter, calls } = pendingReplay('cov/lease-fresh', prefix)
    const theirs = `${Date.now() - 1_000}:other-tab`
    storage.setItem(`olas-mq:${prefix}:lease`, theirs)

    const root = queueRoot(adapter, prefix)
    await root.waitForIdle()

    expect(calls).toEqual([])
    expect(adapter.store.size).toBe(1)
    expect(storage.getItem(`olas-mq:${prefix}:lease`)).toBe(theirs)
    root.dispose()
  })

  test.each([
    ['expired', () => `${Date.now() - 31_000}:crashed-tab`],
    ['unparseable', () => 'garbage-without-a-timestamp'],
  ])('an %s lease is taken over and the pass replays', async (label, lease) => {
    const storage = memoryStorage()
    withoutWebLocks(storage)
    const prefix = `cov/lease/${label}`
    const { adapter, calls } = pendingReplay(`cov/lease-${label}`, prefix)
    storage.setItem(`olas-mq:${prefix}:lease`, lease())

    const root = queueRoot(adapter, prefix)
    await root.waitForIdle()

    expect(calls).toEqual(['payload'])
    expect(adapter.store.size).toBe(0)
    expect(storage.getItem(`olas-mq:${prefix}:lease`)).toBeNull()
    root.dispose()
  })

  test.each([
    // Another tab wrote between our write and our re-read: last writer wins.
    [
      'another tab wins the race',
      'lost',
      (value: string) => value.replace(/:[^:]*$/, ':other-tab'),
    ],
    // The write did not stick at all.
    ['the write is dropped', 'dropped', () => null],
  ])('the pass skips when the re-read shows it does not own the lease (%s)', async (_label, slug, reread) => {
    const storage = memoryStorage()
    let written: string | null = null
    const racing: Storage = {
      ...storage,
      getItem: (key) => (written === null ? storage.getItem(key) : reread(written)),
      setItem: (_key, value) => {
        written = value
      },
    }
    withoutWebLocks(racing)
    const prefix = `cov/lease/race-${slug}`
    const { adapter, calls } = pendingReplay(`cov/lease-race-${slug}`, prefix)

    const root = queueRoot(adapter, prefix)
    await root.waitForIdle()

    expect(written).not.toBeNull()
    expect(calls).toEqual([])
    expect(adapter.store.size).toBe(1)
    root.dispose()
  })

  test('a lease storage that throws degrades to an uncoordinated replay, with a warning', async () => {
    const quota = new DOMException('denied', 'SecurityError')
    const broken: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw quota
      },
    }
    withoutWebLocks(broken)
    const prefix = 'cov/lease/throws'
    const { adapter, calls } = pendingReplay('cov/lease-throws', prefix)
    const warnings: Array<{ message: string; cause: unknown }> = []

    const root = queueRoot(adapter, prefix, (message, cause) => warnings.push({ message, cause }))
    await root.waitForIdle()

    expect(warnings).toEqual([
      {
        message:
          '[olas/mutation-queue] lease acquire failed; replaying without cross-tab coordination',
        cause: quota,
      },
    ])
    expect(calls).toEqual(['payload'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a lease another tab took over mid-pass is not released by this tab', async () => {
    const storage = memoryStorage()
    withoutWebLocks(storage)
    const prefix = 'cov/lease/taken-over'
    const id = 'cov/lease-taken-over'
    const leaseKey = `olas-mq:${prefix}:lease`
    _unregisterMutationById(id)
    const theirs = 'later:other-tab'
    defineMutation({
      id,
      mutate: async () => {
        // This tab stalled past the TTL and another tab claimed the lease.
        storage.setItem(leaseKey, theirs)
      },
      meta: { persist: true },
    })
    const adapter = memoryAdapter()
    adapter.store.set(
      `${prefix}/${id}/r1`,
      JSON.stringify({
        v: PROTOCOL_VERSION,
        mutationId: id,
        runId: 'r1',
        variables: null,
        attempts: 0,
        enqueuedAt: Date.now(),
      }),
    )

    const root = queueRoot(adapter, prefix)
    await root.waitForIdle()

    expect(adapter.store.size).toBe(0)
    expect(storage.getItem(leaseKey)).toBe(theirs)
    root.dispose()
  })
})

describe('replay lock — no coordination primitive', () => {
  test('with no navigator and a localStorage that throws on access, the pass still replays', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    vi.stubGlobal('navigator', undefined)
    // A sandboxed iframe: touching `localStorage` throws a SecurityError.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('sandboxed', 'SecurityError')
      },
    })
    try {
      const prefix = 'cov/lock/none'
      const { adapter, calls } = pendingReplay('cov/lock-none', prefix)
      const root = queueRoot(adapter, prefix)
      await root.waitForIdle()
      await settle()

      expect(calls).toEqual(['payload'])
      expect(adapter.store.size).toBe(0)
      root.dispose()
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})
