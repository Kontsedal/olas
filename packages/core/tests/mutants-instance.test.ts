/**
 * Controller-instance behaviour at the edges of its lifecycle: an attached
 * child sleeps and wakes with its parent, every earlier entry stays reachable
 * after an attached child is dropped, suspended effects
 * tear down quietly, a throwing suspend hook is contained, resume only acts on
 * a suspended controller, a failed factory's captured `ctx` is dead, the
 * `controller:*` devtools stream (resumed, disposed once, no premature debug,
 * path segments), scope seeding and repeated provides, collections created
 * while suspended, factory-form rebuilds, and lazyChild retry and teardown.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type Ctx,
  createRoot,
  type DebugEvent,
  defineController,
  defineScope,
  type ErrorContext,
  type OlasPlugin,
  type Root,
  signal,
} from '../src'
import { ctxInternals } from '../src/controller/internals'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose()
})
const keep = <T extends { dispose(): void }>(root: T): T => {
  roots.push(root)
  return root
}

type Call = [message: string, kind: ErrorContext['kind']]
const summarize = (onError: ReturnType<typeof vi.fn>): Call[] =>
  onError.mock.calls.map(([err, context]) => [
    (err as Error).message,
    (context as ErrorContext).kind,
  ])

const pathOf = (e: DebugEvent): string =>
  'path' in e ? (e.path as readonly string[]).join('/') : ''

describe('ctx.attach', () => {
  test('an attached child sleeps and wakes with its parent', () => {
    const count = signal(0)
    const runs: number[] = []
    const Child = defineController((ctx) => {
      ctx.effect(() => {
        runs.push(count.value)
      })
      return {}
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ handle: ctx.attach(Child, undefined) })),
        { deps: {} },
      ),
    )
    root.suspend()
    count.set(1)
    expect(runs).toEqual([0])
    root.resume()
    count.set(2)
    expect(runs).toEqual([0, 1, 2])
  })

  test('an effect and a resume hook registered before a disposed child still wake on resume', () => {
    const count = signal(0)
    const runs: number[] = []
    const resumed = vi.fn()
    const Child = defineController(() => ({}))
    const root = keep(
      createRoot(
        defineController((ctx) => {
          ctx.effect(() => {
            runs.push(count.value)
          })
          ctx.onResume(resumed)
          return { handle: ctx.attach(Child, undefined) }
        }),
        { deps: {} },
      ),
    )
    root.api.handle.dispose()
    root.suspend()
    root.resume()
    expect(resumed).toHaveBeenCalledTimes(1)
    count.set(1)
    expect(runs).toEqual([0, 0, 1])
  })
})

describe('effects and suspension', () => {
  test('disposing a suspended controller tears its effects down without reporting an error', () => {
    const onError = vi.fn()
    const count = signal(0)
    const runs: number[] = []
    const root = keep(
      createRoot(
        defineController((ctx) => {
          ctx.effect(() => {
            runs.push(count.value)
          })
          return {}
        }),
        { deps: {}, onError },
      ),
    )
    root.suspend()
    root.dispose()
    count.set(1)
    expect(runs).toEqual([0])
    expect(onError).not.toHaveBeenCalled()
  })

  test('an effect that returns nothing reports no error when it re-runs or is disposed', () => {
    const onError = vi.fn()
    const count = signal(0)
    const runs: number[] = []
    const root = keep(
      createRoot(
        defineController((ctx) => {
          ctx.effect(() => {
            runs.push(count.value)
          })
          return {}
        }),
        { deps: {}, onError },
      ),
    )
    count.set(1)
    root.dispose()
    expect(runs).toEqual([0, 1])
    expect(onError).not.toHaveBeenCalled()
  })

  test('suspending again from an onResume handler reports no error', () => {
    const onError = vi.fn()
    const count = signal(0)
    let root: Root<unknown> | undefined
    root = keep(
      createRoot(
        defineController((ctx) => {
          // Registered before the effect, so it runs while the effect is still
          // waiting to be re-activated by the same resume.
          ctx.onResume(() => root?.suspend())
          ctx.effect(() => {
            count.value
          })
          return {}
        }),
        { deps: {}, onError },
      ),
    )
    root.suspend()
    root.resume()
    expect(onError).not.toHaveBeenCalled()
  })

  test('a suspend hook that throws reaches onError as kind effect; the rest still suspends', () => {
    const onError = vi.fn()
    const suspended = vi.fn()
    const root = keep(
      createRoot(
        defineController((ctx) => {
          ctx.onSuspend(suspended)
          // Registered last, so the reverse-order suspend reaches it first.
          ctxInternals(ctx, 'test').register({
            kind: 'subscription-cache',
            dispose: () => {},
            suspend: () => {
              throw new Error('suspend hook boom')
            },
            resume: () => {},
          })
          return {}
        }),
        { deps: {}, onError },
      ),
    )
    root.suspend()
    expect(suspended).toHaveBeenCalledTimes(1)
    expect(summarize(onError)).toEqual([['suspend hook boom', 'effect']])
    expect((onError.mock.calls[0]?.[1] as ErrorContext | undefined)?.controllerPath).toEqual([
      'root',
    ])
  })
})

describe('resume', () => {
  test('resume does nothing to a controller that is active or disposed', () => {
    const resumed = vi.fn()
    const count = signal(0)
    const runs: number[] = []
    const root = keep(
      createRoot(
        defineController((ctx) => {
          ctx.onResume(resumed)
          ctx.effect(() => {
            runs.push(count.value)
          })
          return {}
        }),
        { deps: {} },
      ),
    )
    root.resume()
    expect(resumed).not.toHaveBeenCalled()
    expect(runs).toEqual([0])

    root.dispose()
    root.resume()
    count.set(1)
    expect(resumed).not.toHaveBeenCalled()
    expect(runs).toEqual([0])
  })
})

describe('construction rollback', () => {
  test('a ctx captured by a factory that threw refuses new entries', () => {
    let captured!: Ctx
    const Failing = defineController((ctx) => {
      captured = ctx
      throw new Error('factory boom')
    })
    expect(() => createRoot(Failing, { deps: {} })).toThrow('factory boom')
    const body = vi.fn()
    expect(() => captured.effect(body)).toThrow(
      /effect\(\) called after the controller was disposed/,
    )
    expect(body).not.toHaveBeenCalled()
  })
})

describe('controller devtools events', () => {
  test('resume emits controller:resumed, so a late subscriber replays the tree as active', () => {
    const Leaf = defineController(() => ({}), { name: 'Leaf' })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ leaf: ctx.child(Leaf, undefined) })),
        { deps: {} },
      ),
    )
    const live: DebugEvent[] = []
    const off = root.debug.subscribe((e) => live.push(e))
    live.length = 0
    root.suspend()
    root.resume()
    off()
    expect(live.map((e) => [e.type, pathOf(e)])).toEqual([
      ['controller:suspended', 'root/Leaf[0]'],
      ['controller:suspended', 'root'],
      ['controller:resumed', 'root/Leaf[0]'],
      ['controller:resumed', 'root'],
    ])

    const late: DebugEvent[] = []
    root.debug.subscribe((e) => late.push(e))
    expect(late.map((e) => [e.type, pathOf(e)])).toEqual([
      ['controller:constructed', 'root/Leaf[0]'],
      ['controller:constructed', 'root'],
    ])
  })

  test('disposing an attached child after its parent tore it down emits controller:disposed once', () => {
    const Child = defineController(() => ({}), { name: 'Child' })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ handle: ctx.attach(Child, undefined) })),
        { deps: {} },
      ),
    )
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))
    root.dispose()
    root.api.handle.dispose()
    expect(events.filter((e) => e.type === 'controller:disposed').map(pathOf)).toEqual([
      'root/Child[0]',
      'root',
    ])
  })

  test('a child attached after the root exists emits one controller:constructed; debug rides only when registered', () => {
    const count = signal(0)
    const Plain = defineController(() => ({}), { name: 'Plain' })
    const Debugged = defineController(
      (ctx) => {
        ctx.debug({ count })
        return {}
      },
      { name: 'Debugged' },
    )
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          attachPlain: () => ctx.attach(Plain, undefined),
          attachDebugged: () => ctx.attach(Debugged, undefined),
        })),
        { deps: {} },
      ),
    )
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))
    events.length = 0
    root.api.attachPlain()
    root.api.attachDebugged()
    expect(events.map((e) => [e.type, pathOf(e)])).toEqual([
      ['controller:constructed', 'root/Plain[0]'],
      ['controller:constructed', 'root/Debugged[1]'],
    ])
    const [plain, debugged] = events as Array<
      Extract<DebugEvent, { type: 'controller:constructed' }>
    >
    expect(Object.keys(plain ?? {})).not.toContain('debug')
    expect(debugged?.debug?.count).toBe(count)
  })

  test('child path segments count up per parent and fall back to the factory name, then anonymous', () => {
    function Sidebar(): Record<string, never> {
      return {}
    }
    const Named = defineController(() => ({}), { name: 'Named' })
    const ByFunctionName = defineController(Sidebar)
    const Anonymous = defineController(() => ({}))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          a: ctx.child(Named, undefined),
          b: ctx.child(ByFunctionName, undefined),
          c: ctx.child(Anonymous, undefined),
          d: ctx.child(Named, undefined),
        })),
        { deps: {} },
      ),
    )
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))
    expect(events.map(pathOf)).toEqual([
      'root/Named[0]',
      'root/Sidebar[1]',
      'root/anonymous[2]',
      'root/Named[3]',
      'root',
    ])
  })
})

describe('scopes', () => {
  test('a plugin scope and a RootOptions scope on different keys are both visible', () => {
    const Plugged = defineScope<string>({ name: 'plugged' })
    const Seeded = defineScope<string>({ name: 'seeded' })
    const plugin: OlasPlugin = {
      name: 'provider',
      setup: (host) => host.provide(Plugged, 'from plugin'),
    }
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { deps: {}, plugins: [plugin], scopes: [[Seeded, 'from options']] },
      ),
    )
    expect(root.inject(Plugged)).toBe('from plugin')
    expect(root.inject(Seeded)).toBe('from options')
  })

  test('each provide on one controller adds to what it already provides, seeded scopes included', () => {
    const Seeded = defineScope<string>({ name: 'seeded' })
    const Theme = defineScope<string>({ name: 'theme' })
    const Locale = defineScope<string>({ name: 'locale' })
    const Reader = defineController((ctx) => ({
      seeded: ctx.inject(Seeded),
      theme: ctx.inject(Theme),
      locale: ctx.inject(Locale),
    }))
    const root = keep(
      createRoot(
        defineController((ctx) => {
          ctx.provide(Theme, 'dark')
          ctx.provide(Locale, 'uk')
          return ctx.child(Reader, undefined)
        }),
        { deps: {}, scopes: [[Seeded, 'seed']] },
      ),
    )
    expect(root.api).toEqual({ seeded: 'seed', theme: 'dark', locale: 'uk' })
  })
})

describe('ctx.collection', () => {
  type Row = { id: string }

  test('a collection created while its owner is suspended stays empty until resume', () => {
    const built = vi.fn()
    const Item = defineController((_ctx, props: Row) => {
      built(props.id)
      return { id: props.id }
    })
    const source = signal<Row[]>([{ id: 'a' }])
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          open: () =>
            ctx.collection({
              source,
              keyOf: (row) => row.id,
              controller: Item,
              propsOf: (row) => row,
            }),
        })),
        { deps: {} },
      ),
    )
    root.suspend()
    const list = root.api.open()
    expect(list.items.value).toEqual([])
    expect(list.size.value).toBe(0)
    expect(built).not.toHaveBeenCalled()

    root.resume()
    expect(list.items.value).toEqual([{ key: 'a', api: { id: 'a' } }])
    expect(built).toHaveBeenCalledTimes(1)
  })

  test('get() of a key that is not in the collection returns undefined', () => {
    const Item = defineController((_ctx, props: Row) => ({ id: props.id }))
    const source = signal<Row[]>([{ id: 'a' }])
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          list: ctx.collection({
            source,
            keyOf: (row) => row.id,
            controller: Item,
            propsOf: (row) => row,
          }),
        })),
        { deps: {} },
      ),
    )
    expect(root.api.list.get('missing')).toBeUndefined()
    expect(root.api.list.get('a')).toEqual({ id: 'a' })
  })

  test('factory form: an item rebuilt for a new controller is exposed, then disposed with its parent', () => {
    const log: string[] = []
    const Text = defineController((ctx, props: { id: string }) => {
      ctx.onDispose(() => log.push(`text:${props.id}`))
      return { kind: 'text' as const }
    })
    const Code = defineController((ctx, props: { id: string }) => {
      ctx.onDispose(() => log.push(`code:${props.id}`))
      return { kind: 'code' as const }
    })
    type Block = { id: string; kind: 'text' | 'code' }
    const source = signal<Block[]>([{ id: 'a', kind: 'text' }])
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          blocks: ctx.collection({
            source,
            keyOf: (b: Block) => b.id,
            factory: (b: Block) =>
              b.kind === 'text'
                ? { controller: Text, props: { id: b.id } }
                : { controller: Code, props: { id: b.id } },
          }),
        })),
        { deps: {} },
      ),
    )
    const blocks = root.api.blocks
    source.set([{ id: 'a', kind: 'code' }])
    expect(log).toEqual(['text:a'])
    expect(blocks.get('a')).toEqual({ kind: 'code' })
    expect(blocks.items.value).toEqual([{ key: 'a', api: { kind: 'code' } }])

    root.dispose()
    expect(log).toEqual(['text:a', 'code:a'])
  })
})

describe('ctx.lazyChild', () => {
  test('load() calls the loader again after a rejected attempt', async () => {
    const Lazy = defineController(() => ({ ok: true }))
    let attempts = 0
    const loader = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('chunk failed')
      return Lazy
    }
    const root = keep(
      createRoot(
        defineController((ctx) => ({ lazy: ctx.lazyChild(loader, undefined) })),
        { deps: {}, onError: vi.fn() },
      ),
    )
    const { lazy } = root.api
    await expect(lazy.load()).rejects.toThrow('chunk failed')
    expect(lazy.status.value).toBe('error')
    await expect(lazy.load()).resolves.toEqual({ ok: true })
    expect(attempts).toBe(2)
    expect(lazy.status.value).toBe('ready')
  })

  test('a loaded child is suspended and disposed with its parent', async () => {
    const log: string[] = []
    const Lazy = defineController((ctx) => {
      ctx.onSuspend(() => log.push('suspend'))
      ctx.onDispose(() => log.push('dispose'))
      return {}
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ lazy: ctx.lazyChild(async () => Lazy, undefined) })),
        { deps: {} },
      ),
    )
    await root.api.lazy.load()
    root.suspend()
    root.dispose()
    expect(log).toEqual(['suspend', 'dispose'])
  })
})
