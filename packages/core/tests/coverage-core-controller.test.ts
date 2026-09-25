import { describe, expect, test, vi } from 'vitest'
import {
  createForm,
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  defineQuery,
  defineScope,
  type ErrorContext,
  type OlasPlugin,
  queryEngine,
  type Root,
  signal,
} from '../src'
import { fakeField } from '../src/testing'

type Call = [message: string, kind: ErrorContext['kind']]
const summarize = (onError: ReturnType<typeof vi.fn>): Call[] =>
  onError.mock.calls.map(([err, context]) => [
    (err as Error).message,
    (context as ErrorContext).kind,
  ])

describe('scopes', () => {
  test('ctx.inject memoizes per scope and re-resolves after an ancestor provides again', () => {
    const Theme = defineScope<string>({ name: 'theme' })
    const Locale = defineScope<string>({ name: 'locale', default: 'en' })
    const Child = defineController((ctx) => ({
      theme: () => ctx.inject(Theme),
      locale: () => ctx.inject(Locale),
    }))
    const root = createRoot(
      defineController((ctx) => {
        ctx.provide(Theme, 'light')
        return {
          child: ctx.child(Child, undefined),
          setTheme: (theme: string) => ctx.provide(Theme, theme),
        }
      }),
      { deps: {} },
    )
    const { child, setTheme } = root.api
    expect(child.theme()).toBe('light')
    expect(child.theme()).toBe('light')
    expect(child.locale()).toBe('en')
    // A second provide on the same controller invalidates every cached lookup.
    setTheme('dark')
    expect(child.theme()).toBe('dark')
    expect(child.locale()).toBe('en')
    root.dispose()
  })
})

describe('lifecycle hooks that throw', () => {
  test('onSuspend, onResume and onDispose throws reach onError; sibling hooks still run', () => {
    const onError = vi.fn()
    const calls: string[] = []
    const root = createRoot(
      defineController((ctx) => {
        ctx.onSuspend(() => calls.push('suspend'))
        ctx.onSuspend(() => {
          throw new Error('suspend boom')
        })
        ctx.onResume(() => {
          throw new Error('resume boom')
        })
        ctx.onResume(() => calls.push('resume'))
        ctx.onDispose(() => calls.push('dispose'))
        ctx.onDispose(() => {
          throw new Error('dispose boom')
        })
        return {}
      }),
      { deps: {}, onError },
    )
    root.suspend()
    root.resume()
    root.dispose()
    expect(calls).toEqual(['suspend', 'resume', 'dispose'])
    expect(summarize(onError)).toEqual([
      ['suspend boom', 'effect'],
      ['resume boom', 'effect'],
      ['dispose boom', 'effect'],
    ])
    expect(onError.mock.calls.every(([, c]) => c.controllerPath.join('/') === 'root')).toBe(true)
  })

  test('a teardown that throws during dispose reaches onError; later teardown still runs', () => {
    const onError = vi.fn()
    const after = vi.fn()
    const root = createRoot(
      defineController((ctx) => {
        // Registered first, so it runs last in the reverse-order teardown.
        ctx.onDispose(after)
        const broken = fakeField('v', {
          dispose: () => {
            throw new Error('fake dispose boom')
          },
        })
        return { form: createForm(ctx, { broken }) }
      }),
      { deps: {}, onError },
    )
    root.dispose()
    expect(after).toHaveBeenCalledTimes(1)
    expect(summarize(onError)).toEqual([['fake dispose boom', 'effect']])
  })

  test('a teardown that throws while rolling back a failed factory reaches onError; the factory error still propagates', () => {
    const onError = vi.fn()
    const rolledBack = vi.fn()
    const failing = defineController((ctx) => {
      ctx.onDispose(rolledBack)
      createForm(ctx, {
        broken: fakeField('v', {
          dispose: () => {
            throw new Error('rollback teardown boom')
          },
        }),
      })
      throw new Error('factory boom')
    })
    expect(() => createRoot(failing, { deps: {}, onError })).toThrow('factory boom')
    expect(rolledBack).toHaveBeenCalledTimes(1)
    expect(summarize(onError)).toEqual([['rollback teardown boom', 'effect']])
  })

  test('a subscription whose key throws on resume reaches onError; the tree still resumes', async () => {
    const q = defineQuery({
      id: 'coverage-core/resume-key',
      key: (n: number) => ['n', n],
      fetcher: async (_ctx, n: number) => n,
    })
    let explode = false
    const onError = vi.fn()
    const resumed = vi.fn()
    const root = createRoot(
      defineController((ctx) => {
        const value = createQuery(ctx, q, () => {
          if (explode) throw new Error('key boom')
          return [1] as [number]
        })
        ctx.onResume(resumed)
        return { value }
      }),
      { deps: {}, queries: queryEngine(), onError },
    )
    await root.waitForIdle()
    expect(root.api.value.data.value).toBe(1)
    root.suspend()
    explode = true
    root.resume()
    expect(resumed).toHaveBeenCalledTimes(1)
    expect(summarize(onError)).toEqual([['key boom', 'effect']])
    root.dispose()
  })

  test('a throwing handler on a ctx.emitter reaches onError as kind emitter', () => {
    const onError = vi.fn()
    const root = createRoot(
      defineController((ctx) => ({ events: ctx.emitter<number>() })),
      { deps: {}, onError },
    )
    const seen: number[] = []
    root.api.events.on(() => {
      throw new Error('handler boom')
    })
    root.api.events.on((n) => seen.push(n))
    root.api.events.emit(7)
    expect(seen).toEqual([7])
    expect(summarize(onError)).toEqual([['handler boom', 'emitter']])
    root.dispose()
  })
})

describe('ctx.attach', () => {
  test('a handle disposed after its parent tore down does not tear the child down twice', () => {
    const onDispose = vi.fn()
    const Child = defineController((ctx) => {
      ctx.onDispose(onDispose)
      return {}
    })
    const root = createRoot(
      defineController((ctx) => ({ handle: ctx.attach(Child, undefined) })),
      { deps: {} },
    )
    const { handle } = root.api
    root.dispose()
    expect(onDispose).toHaveBeenCalledTimes(1)
    handle.dispose()
    expect(onDispose).toHaveBeenCalledTimes(1)
  })
})

describe('ctx.collection', () => {
  type Row = { id: string; n?: number }
  const Item = defineController((ctx, props: Row) => ({
    id: props.id,
    n: props.n,
    tag: ctx.deps.tag,
  }))

  test('deps overrides reach every item', () => {
    const source = signal<Row[]>([{ id: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        list: ctx.collection({
          source,
          keyOf: (row) => row.id,
          controller: Item,
          propsOf: (row) => row,
          deps: { tag: 'override' },
        }),
      })),
      { deps: { tag: 'root' } },
    )
    expect(root.api.list.get('a')?.tag).toBe('override')
    root.dispose()
  })

  test('a duplicate key keeps the first occurrence and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const source = signal<Row[]>([
        { id: 'a', n: 1 },
        { id: 'a', n: 2 },
        { id: 'b', n: 3 },
      ])
      const root = createRoot(
        defineController((ctx) => ({
          list: ctx.collection({
            source,
            keyOf: (row) => row.id,
            controller: Item,
            propsOf: (row) => row,
          }),
        })),
        { deps: {} },
      )
      expect(root.api.list.items.value.map((i) => [i.key, i.api.n])).toEqual([
        ['a', 1],
        ['b', 3],
      ])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate key a'))
      root.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  test('a keyOf that throws reaches onError and leaves the items as they were', () => {
    const onError = vi.fn()
    const source = signal<Row[]>([{ id: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        list: ctx.collection({
          source,
          keyOf: (row) => {
            if (row.id === 'boom') throw new Error('keyOf boom')
            return row.id
          },
          controller: Item,
          propsOf: (row) => row,
        }),
      })),
      { deps: {}, onError },
    )
    source.set([{ id: 'a' }, { id: 'boom' }])
    expect(root.api.list.items.value.map((i) => i.key)).toEqual(['a'])
    expect(summarize(onError)).toEqual([['keyOf boom', 'effect']])
    root.dispose()
  })

  test('factory form keeps a child whose controller did not change; a failed rebuild drops it', () => {
    const onError = vi.fn()
    const A = defineController((_ctx, props: { id: string }) => ({ kind: 'a' as const, ...props }))
    const B = defineController((_ctx, props: { id: string }): { kind: 'b'; id: string } => {
      throw new Error(`B cannot build ${props.id}`)
    })
    type Tagged = { id: string; kind: 'a' | 'b' }
    const source = signal<Tagged[]>([{ id: 'x', kind: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        list: ctx.collection({
          source,
          keyOf: (row: Tagged) => row.id,
          factory: (row: Tagged) =>
            row.kind === 'a'
              ? { controller: A, props: { id: row.id } }
              : { controller: B, props: { id: row.id } },
        }),
      })),
      { deps: {}, onError },
    )
    const list = root.api.list
    const first = list.get('x')
    // A fresh array with the same key and the same controller: no rebuild.
    source.set([{ id: 'x', kind: 'a' }])
    expect(list.get('x')).toBe(first)

    // The controller changes and the new one fails to construct: the item goes.
    source.set([{ id: 'x', kind: 'b' }])
    expect(list.has('x')).toBe(false)
    expect(list.items.value).toEqual([])
    expect(summarize(onError)).toEqual([['B cannot build x', 'construction']])
    root.dispose()
  })

  test('item suspend controls ignore unknown keys; resumeItem under a suspended parent defers', () => {
    const source = signal<Row[]>([{ id: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        list: ctx.collection({
          source,
          keyOf: (row) => row.id,
          controller: Item,
          propsOf: (row) => row,
        }),
      })),
      { deps: {} },
    )
    const list = root.api.list
    list.suspendItem('nope')
    list.resumeItem('nope')
    expect(list.isItemSuspended('nope')).toBe(false)

    // Under an active parent, resumeItem wakes the item at once.
    list.suspendItem('a')
    expect(list.isItemSuspended('a')).toBe(true)
    list.resumeItem('a')
    expect(list.isItemSuspended('a')).toBe(false)

    list.suspendItem('a')
    expect(list.isItemSuspended('a')).toBe(true)
    root.suspend()
    list.resumeItem('a')
    // The parent is frozen, so the item waits for the parent's resume.
    expect(list.isItemSuspended('a')).toBe(true)
    root.resume()
    expect(list.isItemSuspended('a')).toBe(false)
    root.dispose()
  })
})

describe('ctx.lazyChild', () => {
  const Lazy = defineController((ctx) => ({ tag: ctx.deps.tag }))

  test('deps overrides reach the loaded child', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        lazy: ctx.lazyChild(async () => Lazy, undefined, { deps: { tag: 'lazy' } }),
      })),
      { deps: { tag: 'root' } },
    )
    await expect(root.api.lazy.load()).resolves.toEqual({ tag: 'lazy' })
    expect(root.api.lazy.status.value).toBe('ready')
    root.dispose()
  })

  test('load() after dispose() rejects; dispose() is idempotent', async () => {
    const loader = vi.fn(async () => Lazy)
    const root = createRoot(
      defineController((ctx) => ({ lazy: ctx.lazyChild(loader, undefined) })),
      { deps: {} },
    )
    const lazy = root.api.lazy
    lazy.dispose()
    lazy.dispose()
    await expect(lazy.load()).rejects.toThrow('cannot load after dispose')
    expect(loader).not.toHaveBeenCalled()
    expect(lazy.status.value).toBe('idle')
    root.dispose()
  })

  test('a loader that rejects after dispose rejects load() without reporting', async () => {
    const onError = vi.fn()
    let reject!: (err: unknown) => void
    const root = createRoot(
      defineController((ctx) => ({
        lazy: ctx.lazyChild(
          () =>
            new Promise<typeof Lazy>((_, r) => {
              reject = r
            }),
          undefined,
        ),
      })),
      { deps: {}, onError },
    )
    const lazy = root.api.lazy
    const pending = lazy.load()
    lazy.dispose()
    reject(new Error('chunk failed'))
    await expect(pending).rejects.toThrow('chunk failed')
    expect(onError).not.toHaveBeenCalled()
    expect(lazy.error.value).toBeUndefined()
    root.dispose()
  })
})

describe('root handle without a query engine', () => {
  const q = defineQuery({
    id: 'coverage-core/root-no-engine',
    key: (n: number) => ['n', n],
    fetcher: async (_ctx, n: number) => n,
  })
  const empty = defineController(() => ({}))

  test('bindQuery throws a message naming the fix', () => {
    const root = createRoot(empty, { deps: {} })
    expect(() => root.bindQuery(q)).toThrow(/root\.bindQuery needs a query engine/)
    root.dispose()
  })

  test('hydrate warns about a non-empty payload, summarizing past three ids, and ignores an empty one', async () => {
    const server = createRoot(empty, { deps: {}, queries: queryEngine() })
    const handle = server.bindQuery(q)
    await Promise.all([1, 2, 3, 4, 5].map((n) => handle.prefetch(n)))
    const state = server.dehydrate()
    expect(state.entries).toHaveLength(5)
    server.dispose()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = createRoot(empty, { deps: {} })
      client.hydrate({ version: 1, entries: [] })
      expect(warn).not.toHaveBeenCalled()
      client.hydrate(state)
      expect(warn).toHaveBeenCalledTimes(1)
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain("'coverage-core/root-no-engine'")
      expect(message).toContain('and 2 more')
      expect(message).toContain('no query engine')
      client.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  test('waitForIdle gives up when plugin work keeps restarting', async () => {
    let stop = false
    let generations = 0
    const restless: OlasPlugin = {
      name: 'restless',
      setup(host) {
        const again = (): void => {
          generations += 1
          if (stop || generations > 100_000) return
          host.track(Promise.resolve().then(again))
        }
        again()
      },
    }
    const root = createRoot(empty, { deps: {}, plugins: [restless] })
    await expect(root.waitForIdle()).rejects.toThrow(/kept restarting for 100 rounds/)
    stop = true
    expect(generations).toBeGreaterThan(100)
    root.dispose()
  })
})

describe('devtools replay', () => {
  test('a late subscriber sees each live controller constructed, then suspended if it is', () => {
    const Leaf = defineController(() => ({}), { name: 'Leaf' })
    const root = createRoot(
      defineController((ctx) => ({ leaf: ctx.child(Leaf, undefined) })),
      { deps: {} },
    )
    root.suspend()
    const events: DebugEvent[] = []
    const off = root.debug.subscribe((e) => events.push(e))
    expect(
      events.map((e) => [e.type, 'path' in e ? (e.path as readonly string[]).join('/') : '']),
    ).toEqual([
      ['controller:constructed', 'root/Leaf[0]'],
      ['controller:suspended', 'root/Leaf[0]'],
      ['controller:constructed', 'root'],
      ['controller:suspended', 'root'],
    ])
    // Replayed events are stamped in order, like live ones.
    const seqs = events.map((e) => e.seq ?? -1)
    expect(seqs.every((s) => s > 0)).toBe(true)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    off()
    root.dispose()
  })

  test('a root disposed from its own onSuspend or onResume handler is not replayed as live', () => {
    const lateEvents = (root: Root<unknown>): DebugEvent[] => {
      const events: DebugEvent[] = []
      root.debug.subscribe((e) => events.push(e))
      return events
    }

    let bySuspend: Root<unknown> | undefined
    bySuspend = createRoot(
      defineController((ctx) => {
        ctx.onSuspend(() => bySuspend?.dispose())
        return {}
      }),
      { deps: {} },
    )
    bySuspend.suspend()
    expect(lateEvents(bySuspend)).toEqual([])

    let byResume: Root<unknown> | undefined
    byResume = createRoot(
      defineController((ctx) => {
        ctx.onResume(() => byResume?.dispose())
        return {}
      }),
      { deps: {} },
    )
    byResume.suspend()
    byResume.resume()
    expect(lateEvents(byResume)).toEqual([])
  })
})
