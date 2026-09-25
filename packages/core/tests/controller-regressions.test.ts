import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type ControllerDef,
  createQuery,
  createRoot,
  defineController,
  definePlugin,
  defineQuery,
  queryEngine,
  type Root,
  signal,
} from '../src'

afterEach(() => {
  vi.useRealTimers()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A child whose effect counts its runs against `source`. */
function countingChild(source: { value: number }, runs: { count: number }) {
  return defineController((ctx) => {
    ctx.effect(() => {
      void source.value
      runs.count++
    })
    return {}
  })
}

describe('a child built while its parent is suspended starts suspended', () => {
  test('lazyChild: a load that settles during suspension does not run the child', async () => {
    const source = signal(0)
    const runs = { count: 0 }
    const child = countingChild(source, runs)
    let settle: (def: typeof child) => void = () => {}
    const root = createRoot(
      defineController((ctx) => ({
        lazy: ctx.lazyChild(
          () =>
            new Promise<typeof child>((resolve) => {
              settle = resolve
            }),
          undefined,
        ),
      })),
      { deps: {} },
    )
    const loaded = root.api.lazy.load()
    root.suspend()
    settle(child)
    await loaded
    const afterConstruct = runs.count
    source.set(1)
    source.set(2)
    expect(runs.count).toBe(afterConstruct)
    root.resume()
    expect(runs.count).toBe(afterConstruct + 1)
    source.set(3)
    expect(runs.count).toBe(afterConstruct + 2)
    root.dispose()
  })

  test('attach from a ctx.on handler while suspended joins the next resume', () => {
    const source = signal(0)
    const runs = { count: 0 }
    const child = countingChild(source, runs)
    let handle: { resume: () => void } | undefined
    const root = createRoot(
      defineController((ctx) => {
        const open = ctx.emitter<void>()
        ctx.on(open, () => {
          handle = ctx.attach(child, undefined)
        })
        return { open: () => open.emit() }
      }),
      { deps: {} },
    )
    root.suspend()
    root.api.open()
    const afterConstruct = runs.count
    source.set(1)
    expect(runs.count).toBe(afterConstruct)
    // The handle's resume() under a suspended parent still waits for the parent.
    handle?.resume()
    source.set(2)
    expect(runs.count).toBe(afterConstruct)
    root.resume()
    expect(runs.count).toBe(afterConstruct + 1)
    source.set(3)
    expect(runs.count).toBe(afterConstruct + 2)
    root.dispose()
  })

  test('ctx.child from a ctx.on handler while suspended joins the next resume', () => {
    const source = signal(0)
    const runs = { count: 0 }
    const child = countingChild(source, runs)
    const root = createRoot(
      defineController((ctx) => {
        const open = ctx.emitter<void>()
        ctx.on(open, () => {
          ctx.child(child, undefined)
        })
        return { open: () => open.emit() }
      }),
      { deps: {} },
    )
    root.suspend()
    root.api.open()
    const afterConstruct = runs.count
    source.set(1)
    expect(runs.count).toBe(afterConstruct)
    root.resume()
    expect(runs.count).toBe(afterConstruct + 1)
    root.dispose()
  })
})

describe("a child factory does not run in the caller's tracking scope", () => {
  const readsUser = (user: { value: string }, built: { count: number }) =>
    defineController(() => {
      built.count++
      const name = user.value
      return { name }
    })

  test('attach inside an effect: the child reading a signal does not re-run the effect', () => {
    const user = signal('ann')
    const built = { count: 0 }
    const modal = readsUser(user, built)
    let effectRuns = 0
    const root = createRoot(
      defineController((ctx) => {
        ctx.effect(() => {
          effectRuns++
          const handle = ctx.attach(modal, undefined)
          return () => handle.dispose()
        })
        return {}
      }),
      { deps: {} },
    )
    user.set('bob')
    expect(effectRuns).toBe(1)
    expect(built.count).toBe(1)
    root.dispose()
  })

  test('ctx.child inside an effect: the child reading a signal does not re-run the effect', () => {
    const user = signal('ann')
    const built = { count: 0 }
    const child = readsUser(user, built)
    let effectRuns = 0
    const trigger = signal(0)
    const root = createRoot(
      defineController((ctx) => {
        ctx.effect(() => {
          void trigger.value
          effectRuns++
          if (effectRuns === 1) ctx.child(child, undefined)
        })
        return {}
      }),
      { deps: {} },
    )
    user.set('bob')
    expect(effectRuns).toBe(1)
    root.dispose()
  })
})

describe('an effect whose first run disposes its owner', () => {
  test('ctx.effect registered after construction does not outlive the owner', () => {
    const source = signal(0)
    let runs = 0
    let root: Root<{ start: () => void }> | undefined
    root = createRoot(
      defineController((ctx) => ({
        start: () =>
          ctx.effect(() => {
            void source.value
            runs++
            root?.dispose()
          }),
      })),
      { deps: {} },
    )
    root.api.start()
    expect(runs).toBe(1)
    source.set(1)
    expect(runs).toBe(1)
  })

  test('an effect whose first run suspends its owner waits for resume', () => {
    const source = signal(0)
    let runs = 0
    let root: Root<{ start: () => void }> | undefined
    root = createRoot(
      defineController((ctx) => ({
        start: () =>
          ctx.effect(() => {
            void source.value
            runs++
            if (runs === 1) root?.suspend()
          }),
      })),
      { deps: {} },
    )
    root.api.start()
    source.set(1)
    expect(runs).toBe(1)
    root.resume()
    expect(runs).toBe(2)
    root.dispose()
  })

  test('a collection created after construction does not reconcile once its owner is gone', () => {
    const source = signal<string[]>(['a'])
    let built = 0
    let root: Root<{ start: () => void }> | undefined
    const item = defineController((_ctx, _props: { id: string }) => {
      built++
      if (built === 1) root?.dispose()
      return {}
    })
    root = createRoot(
      defineController((ctx) => ({
        start: () => {
          ctx.collection({
            source,
            keyOf: (id) => id,
            controller: item,
            propsOf: (id) => ({ id }),
          })
        },
      })),
      { deps: {} },
    )
    root.api.start()
    expect(built).toBe(1)
    source.set(['a', 'b'])
    expect(built).toBe(1)
  })
})

describe('a parent disposed while a child is constructing', () => {
  /** A child that disposes `root` from inside its own factory. */
  const selfOrphaning = (getRoot: () => Root<unknown> | undefined, disposed: string[]) =>
    defineController((ctx, props: { id: string }) => {
      ctx.onDispose(() => disposed.push(props.id))
      getRoot()?.dispose()
      return {}
    })

  test('ctx.child: the child is disposed rather than left in a dead parent', () => {
    const disposed: string[] = []
    let root: Root<{ open: () => void }> | undefined
    const child = selfOrphaning(() => root, disposed)
    root = createRoot(
      defineController((ctx) => ({ open: () => void ctx.child(child, { id: 'child' }) })),
      { deps: {} },
    )
    root.api.open()
    expect(disposed).toEqual(['child'])
  })

  test('ctx.attach: the child is disposed rather than left in a dead parent', () => {
    const disposed: string[] = []
    let root: Root<{ open: () => void }> | undefined
    const child = selfOrphaning(() => root, disposed)
    root = createRoot(
      defineController((ctx) => ({ open: () => void ctx.attach(child, { id: 'attached' }) })),
      { deps: {} },
    )
    root.api.open()
    expect(disposed).toEqual(['attached'])
  })

  test('ctx.collection: the item is disposed rather than left in a dead parent', () => {
    const disposed: string[] = []
    let root: Root<unknown> | undefined
    const item = selfOrphaning(() => root, disposed)
    const source = signal<string[]>([])
    root = createRoot(
      defineController((ctx) => ({
        rows: ctx.collection({
          source,
          keyOf: (id) => id,
          controller: item as ControllerDef<{ id: string }, object>,
          propsOf: (id) => ({ id }),
        }),
      })),
      { deps: {} },
    )
    source.set(['row'])
    expect(disposed).toEqual(['row'])
  })

  test('ctx.lazyChild: a load whose child disposes the parent disposes the child', async () => {
    const disposed: string[] = []
    let root: Root<{ load: () => Promise<unknown> }> | undefined
    const child = selfOrphaning(() => root, disposed)
    root = createRoot(
      defineController((ctx) => {
        const lazy = ctx.lazyChild(async () => child, { id: 'lazy' })
        return { load: () => lazy.load() }
      }),
      { deps: {} },
    )
    await expect(root.api.load()).rejects.toThrow('disposed during load')
    expect(disposed).toEqual(['lazy'])
  })
})

describe('root.suspend and maxIdleTime', () => {
  test('a second plain suspend() keeps the armed auto-dispose', () => {
    vi.useFakeTimers()
    const disposed = vi.fn()
    const root = createRoot(
      defineController((ctx) => {
        ctx.onDispose(disposed)
        return {}
      }),
      { deps: {} },
    )
    root.suspend({ maxIdleTime: 1000 })
    vi.advanceTimersByTime(500)
    root.suspend()
    vi.advanceTimersByTime(500)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  test('a second suspend({ maxIdleTime }) restarts the timer', () => {
    vi.useFakeTimers()
    const disposed = vi.fn()
    const root = createRoot(
      defineController((ctx) => {
        ctx.onDispose(disposed)
        return {}
      }),
      { deps: {} },
    )
    root.suspend({ maxIdleTime: 1000 })
    vi.advanceTimersByTime(500)
    root.suspend({ maxIdleTime: 1000 })
    vi.advanceTimersByTime(500)
    expect(disposed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(disposed).toHaveBeenCalledTimes(1)
  })
})

describe('a failed bootstrap tears down in the normal order', () => {
  const recorder = (seen: string[]) =>
    definePlugin({
      name: 'bootstrap-recorder',
      setup: () => ({
        onDeactivate: (e) => seen.push(`deactivate:${e.query.id}`),
        dispose: () => seen.push('dispose'),
      }),
    })

  test('plugins stop hearing events before the rollback, as they do on dispose', async () => {
    const q = defineQuery({
      id: 'controller-regressions/bootstrap',
      key: () => ['k'],
      fetcher: async () => 1,
    })

    const normal: string[] = []
    const root = createRoot(
      defineController((ctx) => ({ sub: createQuery(ctx, q, () => []) })),
      { deps: {}, queries: queryEngine(), plugins: [recorder(normal)] },
    )
    await flush()
    root.dispose()
    expect(normal).toEqual(['dispose'])

    const failed: string[] = []
    expect(() =>
      createRoot(
        defineController((ctx) => {
          createQuery(ctx, q, () => [])
          throw new Error('factory boom')
        }),
        { deps: {}, queries: queryEngine(), plugins: [recorder(failed)] },
      ),
    ).toThrow('factory boom')
    expect(failed).toEqual(['dispose'])
  })
})
