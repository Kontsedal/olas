/**
 * Plugin host v2 contract (SPEC §13). Every rule `PluginSet` and the query
 * client promise a plugin author is pinned here: setup order and failure,
 * disposal order, silence after dispose, scopes, the write-source and
 * origin vocabulary, activity, mutation events, the mutation host,
 * middleware, error isolation and `track`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { bindQuery, createMutation, createQuery, defineMutation } from '../src'
import { createRoot, defineController } from '../src/controller'
import type { ErrorContext } from '../src/errors'
import { definePlugin } from '../src/plugin/host'
import type {
  ActivityEvent,
  InvalidateEvent,
  MutationEvent,
  OlasPlugin,
  PluginHooks,
  PluginHost,
  WriteEvent,
} from '../src/plugin/types'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { _unregisterMutationById } from '../src/query/mutation-registry'
import { defineScope } from '../src/scope'
import { signal } from '../src/signals'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose()
})
const keep = <T extends { dispose(): void }>(root: T): T => {
  roots.push(root)
  return root
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A plugin that hands its host out and records every observation hook. */
function recorder(name = 'recorder', extra: PluginHooks = {}) {
  const log = {
    host: undefined as PluginHost | undefined,
    writes: [] as WriteEvent[],
    invalidations: [] as InvalidateEvent[],
    removals: [] as string[],
    activity: [] as Array<{ kind: 'on' | 'off'; e: ActivityEvent }>,
    mutations: [] as MutationEvent[],
  }
  const plugin = definePlugin({
    name,
    setup(host) {
      log.host = host
      return {
        onWrite: (e) => log.writes.push(e),
        onInvalidate: (e) => log.invalidations.push(e),
        onRemove: (e) => log.removals.push(`${e.query.id}:${JSON.stringify(e.key)}`),
        onActivate: (e) => log.activity.push({ kind: 'on', e }),
        onDeactivate: (e) => log.activity.push({ kind: 'off', e }),
        onMutation: (e) => log.mutations.push(e),
        ...extra,
      }
    },
  })
  return { log, plugin }
}

const userQuery = defineQuery({
  id: 'plugin-host/user',
  key: (id: string) => ['user', id],
  fetcher: async (_ctx, id: string) => ({ id, name: `User ${id}` }),
  staleTime: 60_000,
})

const userRootDef = defineController((ctx) => ({
  user: createQuery(ctx, userQuery, () => ['1']),
  users: bindQuery(ctx, userQuery),
}))

describe('setup', () => {
  test('runs once per root, in order, before the root factory', () => {
    const order: string[] = []
    const make = (name: string): OlasPlugin => ({
      name,
      setup: () => {
        order.push(`setup:${name}`)
      },
    })
    const def = defineController(() => {
      order.push('factory')
      return {}
    })
    keep(createRoot(def, { deps: {}, plugins: [make('a'), make('b')] }))
    expect(order).toEqual(['setup:a', 'setup:b', 'factory'])
  })

  test('one plugin value serves many roots, each with its own state', async () => {
    const { log, plugin } = recorder()
    const seen: PluginHost[] = []
    const tracking: OlasPlugin = {
      name: 'tracking',
      setup(host) {
        seen.push(host)
      },
    }
    const a = keep(
      createRoot(userRootDef, { queries: queryEngine(), deps: {}, plugins: [plugin, tracking] }),
    )
    const b = keep(
      createRoot(userRootDef, { queries: queryEngine(), deps: {}, plugins: [plugin, tracking] }),
    )
    await Promise.all([a.waitForIdle(), b.waitForIdle()])
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    // Both roots fetched; the one recorder saw both, which is what "state in
    // setup's closure" means for a recorder that closes over one `log`.
    expect(log.writes.filter((w) => w.source === 'fetch')).toHaveLength(2)
  })

  test('a throwing setup aborts createRoot and disposes earlier plugins in reverse', () => {
    const order: string[] = []
    const ok = (name: string): OlasPlugin => ({
      name,
      setup(host) {
        host.onDispose(() => order.push(`disposer:${name}`))
        return { dispose: () => order.push(`dispose:${name}`) }
      },
    })
    const bad: OlasPlugin = {
      name: 'bad',
      setup() {
        throw new Error('boom')
      },
    }
    const factory = vi.fn(() => ({}))
    expect(() =>
      createRoot(defineController(factory), {
        queries: queryEngine(),
        deps: {},
        plugins: [ok('a'), ok('b'), bad],
      }),
    ).toThrow('boom')
    expect(factory).not.toHaveBeenCalled()
    expect(order).toEqual(['dispose:b', 'disposer:b', 'dispose:a', 'disposer:a'])
  })

  test('names must be present and unique', () => {
    const def = defineController(() => ({}))
    expect(() =>
      createRoot(def, { deps: {}, plugins: [{ name: '', setup() {} } as OlasPlugin] }),
    ).toThrow(/non-empty `name`/)
    const p: OlasPlugin = { name: 'twice', setup() {} }
    expect(() => createRoot(def, { deps: {}, plugins: [p, p] })).toThrow(/two plugins are named/)
  })

  test('works without a query engine: queries and mutations are null', () => {
    let host: PluginHost | undefined
    keep(
      createRoot(
        defineController(() => ({})),
        {
          deps: { tag: 'x' },
          plugins: [
            {
              name: 'no-engine',
              setup(h) {
                host = h
              },
            },
          ],
        },
      ),
    )
    expect(host?.queries).toBeNull()
    expect(host?.mutations).toBeNull()
    expect(host?.deps).toEqual({ tag: 'x' })
    expect(host?.network.isOnline()).toBe(true)
  })
})

describe('scopes', () => {
  const Service = defineScope<{ hello(): string }>({ name: 'service' })

  test('a provided scope reaches ctx.inject and root.inject', () => {
    const plugin: OlasPlugin = {
      name: 'provider',
      setup: (host) => host.provide(Service, { hello: () => 'from plugin' }),
    }
    const child = defineController((ctx) => ({ said: ctx.inject(Service).hello() }))
    const def = defineController((ctx) => ({ child: ctx.child(child, undefined) }))
    const root = keep(createRoot(def, { deps: {}, plugins: [plugin] }))
    expect(root.api.child.said).toBe('from plugin')
    expect(root.inject(Service).hello()).toBe('from plugin')
  })

  test('RootOptions.scopes override a plugin-provided value', () => {
    const plugin: OlasPlugin = {
      name: 'provider',
      setup: (host) => host.provide(Service, { hello: () => 'plugin' }),
    }
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          deps: {},
          plugins: [plugin],
          scopes: [[Service as never, { hello: () => 'fake' }]],
        },
      ),
    )
    expect(root.inject(Service).hello()).toBe('fake')
  })

  test('provide after setup throws', () => {
    let host: PluginHost | undefined
    keep(
      createRoot(
        defineController(() => ({})),
        {
          deps: {},
          plugins: [
            {
              name: 'late',
              setup(h) {
                host = h
              },
            },
          ],
        },
      ),
    )
    expect(() => host?.provide(Service, { hello: () => '' })).toThrow(/after setup/)
  })
})

describe('onWrite', () => {
  test('fetch, optimistic, rollback, write and replace each report their source', async () => {
    const { log, plugin } = recorder()
    const root = keep(
      createRoot(userRootDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    await root.waitForIdle()
    expect(log.writes.map((w) => w.source)).toEqual(['fetch'])
    expect(log.writes[0]).toMatchObject({
      query: { id: 'plugin-host/user', kind: 'query' },
      key: ['user', '1'],
      origin: undefined,
    })
    expect(typeof log.writes[0]?.updatedAt).toBe('number')

    const snap = root.api.users.setData('1', (u) => ({ ...u!, name: 'opt' }))
    snap.rollback()
    root.api.users.write('1', (u) => ({ ...u!, name: 'written' }))
    root.api.users.replace('1', { id: '1', name: 'replaced' })
    expect(log.writes.map((w) => w.source)).toEqual([
      'fetch',
      'optimistic',
      'rollback',
      'write',
      'replace',
    ])
    expect(log.writes.at(-1)?.data).toEqual({ id: '1', name: 'replaced' })
  })

  test('hydrating a bound entry reports ONE write, as hydrate', async () => {
    const { log, plugin } = recorder()
    const root = keep(
      createRoot(userRootDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    await root.waitForIdle()
    log.writes.length = 0
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'plugin-host/user',
          key: ['user', '1'],
          data: { id: '1', name: 'H' },
          lastUpdatedAt: 42,
        },
      ],
    })
    expect(log.writes).toHaveLength(1)
    expect(log.writes[0]).toMatchObject({ source: 'hydrate', updatedAt: 42, origin: undefined })
  })

  test('a buffered payload reports as hydrate when its entry binds', () => {
    const { log, plugin } = recorder()
    keep(
      createRoot(userRootDef, {
        queries: queryEngine(),
        deps: {},
        plugins: [plugin],
        hydrate: {
          version: 1,
          entries: [
            {
              id: 'plugin-host/user',
              key: ['user', '1'],
              data: { id: '1', name: 'SSR' },
              lastUpdatedAt: 7,
            },
          ],
        },
      }),
    )
    expect(log.writes).toHaveLength(1)
    expect(log.writes[0]).toMatchObject({ source: 'hydrate', updatedAt: 7 })
  })

  test('writes through a host carry the plugin name as origin, and bindQuery can tag its own', async () => {
    const { log, plugin } = recorder()
    const realtime = defineController((ctx) => ({
      user: createQuery(ctx, userQuery, () => ['1']),
      pushed: bindQuery(ctx, userQuery, { origin: 'realtime' }),
    }))
    const root = keep(createRoot(realtime, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    await root.waitForIdle()
    log.writes.length = 0
    log.host?.queries?.write('plugin-host/user', ['user', '1'], (u) => ({ ...(u as object), n: 1 }))
    root.api.pushed.write('1', (u) => ({ ...u!, name: 'push' }))
    expect(log.writes.map((w) => [w.source, w.origin])).toEqual([
      ['write', 'recorder'],
      ['write', 'realtime'],
    ])
  })

  test('host writes to an absent entry are no-ops', () => {
    const { log, plugin } = recorder()
    keep(createRoot(userRootDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    log.host?.queries?.write('plugin-host/user', ['user', 'nope'], () => 'x')
    log.host?.queries?.write('unknown/id', ['k'], () => 'x')
    expect(log.host?.queries?.peek('plugin-host/user', ['user', 'nope'])).toBeUndefined()
  })
})

describe('onInvalidate', () => {
  test('carries origin, and a host invalidate refetches only a subscribed entry', async () => {
    const fetcher = vi.fn(async (_ctx: unknown, id: string) => ({ id }))
    const q = defineQuery({
      id: 'plugin-host/inv',
      key: (id: string) => [id],
      fetcher,
      staleTime: 60_000,
    })
    const { log, plugin } = recorder()
    const def = defineController((ctx) => ({
      a: createQuery(ctx, q, () => ['a']),
      handle: bindQuery(ctx, q),
    }))
    const root = keep(createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    await root.waitForIdle()
    await root.api.handle.prefetch('orphan')
    expect(fetcher).toHaveBeenCalledTimes(2)

    await log.host?.queries?.invalidate('plugin-host/inv', ['a'])
    expect(fetcher).toHaveBeenCalledTimes(3) // subscribed → refetched
    await log.host?.queries?.invalidate('plugin-host/inv', ['orphan'])
    expect(fetcher).toHaveBeenCalledTimes(3) // no subscriber → marked stale only
    expect(log.invalidations.map((e) => [e.key[0], e.origin])).toEqual([
      ['a', 'recorder'],
      ['orphan', 'recorder'],
    ])
    await root.api.handle.invalidate('a')
    expect(log.invalidations.at(-1)?.origin).toBeUndefined()
  })
})

describe('activity and removal', () => {
  test('onActivate / onDeactivate fire on the 0→1 and 1→0 transitions only', async () => {
    const { log, plugin } = recorder()
    const enabled = signal(true)
    const def = defineController((ctx) => ({
      a: createQuery(ctx, userQuery, { key: () => ['1'], enabled: () => enabled.value }),
      b: createQuery(ctx, userQuery, () => ['1']),
    }))
    const root = keep(createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    await root.waitForIdle()
    expect(log.activity.map((a) => a.kind)).toEqual(['on'])
    enabled.set(false) // 2→1: nothing
    expect(log.activity.map((a) => a.kind)).toEqual(['on'])
    root.suspend() // 1→0
    expect(log.activity.map((a) => a.kind)).toEqual(['on', 'off'])
    expect(log.activity[0]?.e).toMatchObject({
      query: { id: 'plugin-host/user' },
      key: ['user', '1'],
    })
  })

  test('onRemove fires when an entry is garbage collected', async () => {
    vi.useFakeTimers()
    try {
      const q = defineQuery({
        id: 'plugin-host/gc',
        key: () => ['k'],
        fetcher: async () => 1,
        gcTime: 10,
      })
      const { log, plugin } = recorder()
      const root = createRoot(
        defineController((ctx) => ({ x: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      )
      await vi.advanceTimersByTimeAsync(0)
      root.suspend()
      await vi.advanceTimersByTimeAsync(20)
      expect(log.removals).toEqual(['plugin-host/gc:["k"]'])
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('onMutation', () => {
  test('every run reports start then one outcome, with variables and meta', async () => {
    const { log, plugin } = recorder()
    let fail = false
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        mutate: async (v: number) => {
          if (fail) throw new Error('nope')
          return v * 2
        },
      }),
      named: createMutation(ctx, { id: 'named', meta: {}, mutate: async () => 'ok' }),
    }))
    const root = keep(createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    await root.api.save.run(2)
    fail = true
    await root.api.save.run(3).catch(() => {})
    await root.api.named.run()
    const phases = log.mutations.map((e) => [e.mutation.id, e.phase, e.variables])
    expect(phases).toEqual([
      [undefined, 'start', 2],
      [undefined, 'success', 2],
      [undefined, 'start', 3],
      [undefined, 'error', 3],
      ['named', 'start', undefined],
      ['named', 'success', undefined],
    ])
    expect(log.mutations[1]?.result).toBe(4)
    expect((log.mutations[3]?.error as Error).message).toBe('nope')
    const runIds = new Set(log.mutations.map((e) => e.runId))
    expect(runIds.size).toBe(3)
  })

  test('reset() reports cancel', async () => {
    const { log, plugin } = recorder()
    const def = defineController((ctx) => ({
      slow: createMutation(ctx, {
        mutate: (_v: void, { signal }) =>
          new Promise((_, rej) =>
            signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
          ),
      }),
    }))
    const root = keep(createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    const run = root.api.slow.run().catch(() => {})
    root.api.slow.reset()
    await run
    expect(log.mutations.map((e) => e.phase)).toEqual(['start', 'cancel'])
  })
})

describe('host.mutations', () => {
  afterEach(() => _unregisterMutationById('plugin-host/replay'))

  test('run goes through the runner: retry, deps, waitForIdle, origin', async () => {
    let calls = 0
    defineMutation({
      id: 'plugin-host/replay',
      retry: 1,
      retryDelay: 0,
      mutate: async (v: string, { deps }) => {
        calls += 1
        if (calls === 1) throw new Error('flaky')
        return `${(deps as { prefix: string }).prefix}${v}`
      },
    })
    const { log, plugin } = recorder()
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: { prefix: '>' }, plugins: [plugin] },
      ),
    )
    const mutations = log.host?.mutations
    expect(mutations?.has('plugin-host/replay')).toBe(true)
    expect(mutations?.has('plugin-host/missing')).toBe(false)
    const result = mutations?.run('plugin-host/replay', 'x')
    let idle = false
    const waited = root.waitForIdle().then(() => {
      idle = true
    })
    await settle()
    await expect(result).resolves.toBe('>x')
    await waited
    expect(idle).toBe(true)
    expect(calls).toBe(2)
    expect(log.mutations.map((e) => [e.phase, e.origin])).toEqual([
      ['start', 'recorder'],
      ['success', 'recorder'],
    ])
    await expect(mutations?.run('plugin-host/missing', 1)).rejects.toThrow(
      /no mutation is registered/,
    )
  })
})

describe('middleware', () => {
  test('wrapFetch composes in plugin order, first outermost, and can answer without fetching', async () => {
    const order: string[] = []
    const fetcher = vi.fn(async () => 'real')
    const q = defineQuery({ id: 'plugin-host/mw', key: () => [], fetcher })
    const outer: OlasPlugin = {
      name: 'outer',
      setup: () => ({
        wrapFetch: async (c, next) => {
          order.push(`outer:${c.query.id}:${c.attempt}`)
          return `outer(${await next()})`
        },
      }),
    }
    const inner: OlasPlugin = {
      name: 'inner',
      setup: () => ({
        wrapFetch: async (_c, next) => {
          order.push('inner')
          return `inner(${await next()})`
        },
      }),
    }
    const root = keep(
      createRoot(
        defineController((ctx) => ({ x: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [outer, inner],
        },
      ),
    )
    await root.waitForIdle()
    expect(root.api.x.data.value).toBe('outer(inner(real))')
    expect(order).toEqual(['outer:plugin-host/mw:0', 'inner'])

    const mock: OlasPlugin = { name: 'mock', setup: () => ({ wrapFetch: async () => 'mocked' }) }
    const mocked = keep(
      createRoot(
        defineController((ctx) => ({ x: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [mock],
        },
      ),
    )
    await mocked.waitForIdle()
    expect(mocked.api.x.data.value).toBe('mocked')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('wrapFetch sees each retry attempt and the infinite page', async () => {
    const attempts: Array<[number, unknown]> = []
    let n = 0
    const q = defineInfiniteQuery({
      id: 'plugin-host/mw-inf',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        n += 1
        if (n === 1) throw new Error('first fails')
        return { page: pageParam }
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      retry: 1,
      retryDelay: 0,
    })
    const watcher: OlasPlugin = {
      name: 'watcher',
      setup: () => ({
        wrapFetch: (c, next) => {
          attempts.push([c.attempt, c.pageParam])
          return next()
        },
      }),
    }
    const root = keep(
      createRoot(
        defineController((ctx) => ({ x: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [watcher],
        },
      ),
    )
    await root.waitForIdle()
    expect(attempts).toEqual([
      [0, 0],
      [1, 0],
    ])
  })

  test('wrapMutate wraps every attempt', async () => {
    const seen: number[] = []
    let calls = 0
    const plugin: OlasPlugin = {
      name: 'mw',
      setup: () => ({
        wrapMutate: (c, next) => {
          seen.push(c.attempt)
          return next()
        },
      }),
    }
    const def = defineController((ctx) => ({
      m: createMutation(ctx, {
        retry: 1,
        retryDelay: 0,
        mutate: async () => {
          calls += 1
          if (calls === 1) throw new Error('once')
          return 'ok'
        },
      }),
    }))
    const root = keep(createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] }))
    await expect(root.api.m.run()).resolves.toBe('ok')
    expect(seen).toEqual([0, 1])
  })
})

describe('isolation and lifecycle', () => {
  test('a throwing hook reaches onError with the plugin name; later plugins still run', async () => {
    const errors: ErrorContext[] = []
    const bad: OlasPlugin = {
      name: 'bad',
      setup: () => ({
        onWrite: () => {
          throw new Error('hook')
        },
      }),
    }
    const { log, plugin } = recorder('after')
    const root = keep(
      createRoot(userRootDef, {
        queries: queryEngine(),
        deps: {},
        plugins: [bad, plugin],
        onError: (_e, c) => errors.push(c),
      }),
    )
    await root.waitForIdle()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'plugin', pluginName: 'bad' })
    expect(log.writes).toHaveLength(1)
  })

  test('no hook runs once the root starts disposing, and plugins dispose in reverse', async () => {
    const order: string[] = []
    const { log, plugin } = recorder('first', { dispose: () => order.push('first') })
    const second: OlasPlugin = {
      name: 'second',
      setup: () => ({ dispose: () => order.push('second') }),
    }
    const def = defineController((ctx) => ({
      user: createQuery(ctx, userQuery, () => ['1']),
      slow: createMutation(ctx, {
        mutate: (_v: void, { signal }) =>
          new Promise<void>((_, rej) =>
            signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
          ),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin, second] })
    await root.waitForIdle()
    const run = root.api.slow.run().catch(() => {})
    const before = log.activity.length + log.mutations.length
    root.dispose()
    await run
    await settle()
    // The entry releasing and the run cancelling both happen during teardown.
    expect(log.activity.length + log.mutations.length).toBe(before)
    expect(order).toEqual(['second', 'first'])
  })

  test('track() makes waitForIdle wait for the work', async () => {
    let release: () => void = () => {}
    const work = new Promise<void>((r) => {
      release = r
    })
    const plugin: OlasPlugin = { name: 'tracker', setup: (host) => host.track(work) }
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { deps: {}, plugins: [plugin] },
      ),
    )
    let idle = false
    const waited = root.waitForIdle().then(() => {
      idle = true
    })
    await settle()
    expect(idle).toBe(false)
    release()
    await waited
    expect(idle).toBe(true)
  })

  test('host.debug publishes on the devtools bus', () => {
    let host: PluginHost | undefined
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          deps: {},
          plugins: [
            {
              name: 'lane',
              setup(h) {
                host = h
              },
            },
          ],
        },
      ),
    )
    const events: unknown[] = []
    root.debug.subscribe((e) => {
      if (e.type === 'plugin:event') events.push(e)
    })
    host?.debug({ hello: 1 })
    expect(events).toEqual([expect.objectContaining({ plugin: 'lane', payload: { hello: 1 } })])
  })

  test('two queries sharing an id in one root warn in dev', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = defineQuery({ id: 'plugin-host/dup', key: () => ['a'], fetcher: async () => 'a' })
      const b = defineQuery({ id: 'plugin-host/dup', key: () => ['b'], fetcher: async () => 'b' })
      keep(
        createRoot(
          defineController((ctx) => ({ a: createQuery(ctx, a), b: createQuery(ctx, b) })),
          { queries: queryEngine(), deps: {} },
        ),
      )
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("share the id 'plugin-host/dup'")),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
