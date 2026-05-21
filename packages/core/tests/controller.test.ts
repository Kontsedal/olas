import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { createEmitter } from '../src/emitter'
import { computed, signal } from '../src/signals'
import { createTestController } from '../src/testing'

type AppDeps = {
  api: { fetch: (k: string) => Promise<string> }
  logger: { log: (msg: string) => void }
}

const noopApi = {
  api: { fetch: async (k: string) => `value-of-${k}` },
  logger: { log: () => {} },
}

describe('defineController + createRoot', () => {
  test('returns the controller api merged with root controls', () => {
    const root = createRoot(
      defineController(() => ({ count: signal(0) })),
      { deps: noopApi },
    )
    expect(typeof root.count.value).toBe('number')
    expect(typeof root.dispose).toBe('function')
    expect(typeof root.suspend).toBe('function')
    expect(typeof root.resume).toBe('function')
    expect(typeof root.__debug.subscribe).toBe('function')
    root.dispose()
  })

  test('deps are available via ctx.deps and inherited by children', () => {
    let observed: typeof noopApi | undefined
    const child = defineController((ctx) => {
      observed = ctx.deps as typeof noopApi
      return { ok: true }
    })
    const root = createRoot(
      defineController((ctx) => ({ child: ctx.child(child, undefined) })),
      { deps: noopApi },
    )
    expect(observed).toBe(noopApi)
    expect(root.child.ok).toBe(true)
    root.dispose()
  })

  test('a child can override deps for itself and descendants', () => {
    const seen: string[] = []
    const otherApi = { fetch: async (k: string) => `OVERRIDDEN-${k}` }

    const leaf = defineController((ctx) => {
      seen.push((ctx.deps as AppDeps).api.fetch.name) // capture identity indirectly
      seen.push((ctx.deps as AppDeps).api === otherApi ? 'override' : 'original')
      return {}
    })
    const middle = defineController((ctx) => ({
      leaf: ctx.child(leaf, undefined),
    }))
    const root = defineController((ctx) => ({
      leafDirect: ctx.child(leaf, undefined),
      middle: ctx.child(middle, undefined, { deps: { api: otherApi } }),
    }))

    const r = createRoot(root, { deps: noopApi })
    expect(seen).toEqual(['fetch', 'original', 'fetch', 'override'])
    r.dispose()
  })
})

describe('ctx.effect', () => {
  test('runs once immediately and re-runs on signal change', () => {
    const observed: number[] = []
    const def = defineController((ctx) => {
      const a = signal(1)
      ctx.effect(() => {
        observed.push(a.value)
      })
      return { a }
    })
    const root = createRoot(def, { deps: noopApi })
    expect(observed).toEqual([1])
    root.a.set(2)
    expect(observed).toEqual([1, 2])
    root.dispose()
  })

  test('cleanup function runs on dispose', () => {
    const cleanups: string[] = []
    const def = defineController((ctx) => {
      ctx.effect(() => {
        cleanups.push('setup')
        return () => cleanups.push('teardown')
      })
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    expect(cleanups).toEqual(['setup'])
    root.dispose()
    expect(cleanups).toEqual(['setup', 'teardown'])
  })

  test('a thrown effect routes through onError; the tree survives', () => {
    const onError = vi.fn()
    const def = defineController((ctx) => {
      ctx.effect(() => {
        throw new Error('effect boom')
      })
      return { ok: true }
    })
    const root = createRoot(def, { deps: noopApi, onError })
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as Error).message).toBe('effect boom')
    expect(onError.mock.calls[0]![1].kind).toBe('effect')
    expect(root.ok).toBe(true)
    root.dispose()
  })
})

describe('ctx.emitter / ctx.on', () => {
  test('emitter inside a controller is disposed with the controller', () => {
    const def = defineController((ctx) => {
      const emitter = ctx.emitter<number>()
      return { emitter }
    })
    const root = createRoot(def, { deps: noopApi })
    const handler = vi.fn()
    root.emitter.on(handler)
    root.emitter.emit(1)
    expect(handler).toHaveBeenCalledWith(1)
    root.dispose()
    // After dispose, emits are no-ops.
    root.emitter.emit(2)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('ctx.on(...) auto-unsubscribes on dispose', () => {
    const external = createEmitter<string>()
    const seen: string[] = []
    const def = defineController((ctx) => {
      ctx.on(external, (v) => seen.push(v))
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    external.emit('a')
    expect(seen).toEqual(['a'])
    root.dispose()
    external.emit('b')
    expect(seen).toEqual(['a'])
  })

  test('a throwing on() handler routes through onError', () => {
    const onError = vi.fn()
    const external = createEmitter<string>()
    const def = defineController((ctx) => {
      ctx.on(external, () => {
        throw new Error('handler boom')
      })
      return {}
    })
    const root = createRoot(def, { deps: noopApi, onError })
    external.emit('x')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('emitter')
    root.dispose()
  })
})

describe('ctx.field — sync validators', () => {
  test('initial errors reflect the initial value', () => {
    const def = defineController((ctx) => ({
      name: ctx.field('', [(v) => (v.length === 0 ? 'required' : null)]),
    }))
    const root = createRoot(def, { deps: noopApi })
    expect(root.name.errors.value).toEqual(['required'])
    expect(root.name.isValid.value).toBe(false)
    root.dispose()
  })

  test('set runs validators and updates errors / dirty', () => {
    const def = defineController((ctx) => ({
      n: ctx.field(0, [(v) => (v < 5 ? 'too small' : null)]),
    }))
    const root = createRoot(def, { deps: noopApi })
    expect(root.n.isDirty.value).toBe(false)
    root.n.set(10)
    expect(root.n.value).toBe(10)
    expect(root.n.errors.value).toEqual([])
    expect(root.n.isValid.value).toBe(true)
    expect(root.n.isDirty.value).toBe(true)
    root.dispose()
  })

  test('reset returns to initial and clears dirty/touched/errors', () => {
    const def = defineController((ctx) => ({
      s: ctx.field('init', [(v) => (v === 'init' ? null : 'must equal init')]),
    }))
    const root = createRoot(def, { deps: noopApi })
    root.s.set('other')
    root.s.markTouched()
    expect(root.s.value).toBe('other')
    expect(root.s.touched.value).toBe(true)
    expect(root.s.isDirty.value).toBe(true)
    expect(root.s.errors.value).toEqual(['must equal init'])

    root.s.reset()
    expect(root.s.value).toBe('init')
    expect(root.s.touched.value).toBe(false)
    expect(root.s.isDirty.value).toBe(false)
    expect(root.s.errors.value).toEqual([])
    root.dispose()
  })

  test('a validator that reads another signal re-runs when that signal changes', () => {
    const password = signal('hunter2')
    const def = defineController((ctx) => ({
      confirm: ctx.field('', [(v) => (v === password.value ? null : 'must match')]),
    }))
    const root = createRoot(def, { deps: noopApi })
    expect(root.confirm.errors.value).toEqual(['must match'])
    root.confirm.set('hunter2')
    expect(root.confirm.errors.value).toEqual([])
    password.set('changed')
    expect(root.confirm.errors.value).toEqual(['must match'])
    root.dispose()
  })
})

describe('ctx.field — async validators', () => {
  test('isValidating goes true while pending and false on settle', async () => {
    let resolveValidator: (v: string | null) => void = () => {}
    const def = defineController((ctx) => ({
      name: ctx.field('foo', [
        () =>
          new Promise<string | null>((r) => {
            resolveValidator = r
          }),
      ]),
    }))
    const root = createRoot(def, { deps: noopApi })

    // Wait one microtask so the effect's async branch kicks off.
    await Promise.resolve()
    expect(root.name.isValidating.value).toBe(true)
    expect(root.name.isValid.value).toBe(false)

    resolveValidator(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(root.name.isValidating.value).toBe(false)
    expect(root.name.errors.value).toEqual([])
    expect(root.name.isValid.value).toBe(true)
    root.dispose()
  })

  test('latest value wins — older async result is dropped', async () => {
    const resolvers: Array<(v: string | null) => void> = []
    const def = defineController((ctx) => ({
      n: ctx.field('a', [() => new Promise<string | null>((r) => resolvers.push(r))]),
    }))
    const root = createRoot(def, { deps: noopApi })

    // first run (initial) created resolvers[0]
    await Promise.resolve()
    root.n.set('b') // triggers re-run; resolvers[1] queued
    await Promise.resolve()
    // resolve the second (latest) one first
    resolvers[1]!('only b matters')
    await Promise.resolve()
    await Promise.resolve()
    expect(root.n.errors.value).toEqual(['only b matters'])
    // older one resolves later — should be ignored
    resolvers[0]!('this should NOT win')
    await Promise.resolve()
    await Promise.resolve()
    expect(root.n.errors.value).toEqual(['only b matters'])
    root.dispose()
  })
})

describe('lifecycle — suspend / resume / dispose', () => {
  test('suspend stops effects from re-running on signal changes', () => {
    const observed: number[] = []
    const def = defineController((ctx) => {
      const a = signal(0)
      ctx.effect(() => {
        observed.push(a.value)
      })
      return { a }
    })
    const root = createRoot(def, { deps: noopApi })
    expect(observed).toEqual([0])

    root.suspend()
    root.a.set(1)
    root.a.set(2)
    expect(observed).toEqual([0]) // suspended; no re-runs

    root.resume()
    // Effect re-runs once on resume, picking up the latest value.
    expect(observed).toEqual([0, 2])

    root.a.set(3)
    expect(observed).toEqual([0, 2, 3])
    root.dispose()
  })

  test('onSuspend / onResume / onDispose hooks fire at the right moments', () => {
    const events: string[] = []
    const def = defineController((ctx) => {
      ctx.onSuspend(() => events.push('suspend'))
      ctx.onResume(() => events.push('resume'))
      ctx.onDispose(() => events.push('dispose'))
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    root.suspend()
    root.resume()
    root.dispose()
    expect(events).toEqual(['suspend', 'resume', 'dispose'])
  })

  test('suspend cascades to children; resume cascades back', () => {
    const log: string[] = []
    const leaf = defineController((ctx) => {
      ctx.onSuspend(() => log.push('leaf:suspend'))
      ctx.onResume(() => log.push('leaf:resume'))
      ctx.onDispose(() => log.push('leaf:dispose'))
      return {}
    })
    const middle = defineController((ctx) => {
      ctx.onSuspend(() => log.push('mid:suspend'))
      ctx.onResume(() => log.push('mid:resume'))
      ctx.onDispose(() => log.push('mid:dispose'))
      return { leaf: ctx.child(leaf, undefined) }
    })
    const root = defineController((ctx) => ({
      mid: ctx.child(middle, undefined),
    }))
    const r = createRoot(root, { deps: noopApi })
    r.suspend()
    expect(log).toEqual(['leaf:suspend', 'mid:suspend'])
    r.resume()
    expect(log).toEqual(['leaf:suspend', 'mid:suspend', 'mid:resume', 'leaf:resume'])
    r.dispose()
    // Cleanup runs leaf-first via reverse entry order:
    // root has [mid child]; mid has [leaf child, onDispose]; leaf has [onDispose].
    expect(log).toEqual([
      'leaf:suspend',
      'mid:suspend',
      'mid:resume',
      'leaf:resume',
      'leaf:dispose',
      'mid:dispose',
    ])
  })

  test('dispose is idempotent', () => {
    const cleanups = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(cleanups)
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    root.dispose()
    root.dispose()
    expect(cleanups).toHaveBeenCalledTimes(1)
  })

  test('suspend with maxIdle auto-disposes when the timer fires', () => {
    vi.useFakeTimers()
    const onDispose = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(onDispose)
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    root.suspend({ maxIdle: 1000 })
    vi.advanceTimersByTime(999)
    expect(onDispose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onDispose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('resume cancels a pending maxIdle timer', () => {
    vi.useFakeTimers()
    const onDispose = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(onDispose)
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    root.suspend({ maxIdle: 1000 })
    vi.advanceTimersByTime(500)
    root.resume()
    vi.advanceTimersByTime(10_000)
    expect(onDispose).not.toHaveBeenCalled()
    root.dispose()
    vi.useRealTimers()
  })

  test('dispose clears a pending maxIdle timer (no double-fire)', () => {
    vi.useFakeTimers()
    const onDispose = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(onDispose)
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    root.suspend({ maxIdle: 1000 })
    root.dispose()
    expect(onDispose).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(onDispose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('a second suspend({maxIdle}) restarts the idle timer from zero', () => {
    vi.useFakeTimers()
    const onDispose = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(onDispose)
      return {}
    })
    const root = createRoot(def, { deps: noopApi })
    root.suspend({ maxIdle: 1000 })
    vi.advanceTimersByTime(900)
    // Re-suspend before the first timer fires — the prior timer is cleared
    // and the new 1000ms window starts now.
    root.suspend({ maxIdle: 1000 })
    vi.advanceTimersByTime(200)
    expect(onDispose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(800)
    expect(onDispose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('controller api defining a reserved root key throws on createRoot', () => {
    for (const reserved of ['dispose', 'suspend', 'resume', '__debug'] as const) {
      const def = defineController(() => ({ [reserved]: () => {} }) as Record<string, () => void>)
      expect(() => createRoot(def, { deps: noopApi })).toThrowError(
        /conflicts with the root controls/,
      )
    }
  })
})

describe('construction error rollback (§12.1)', () => {
  test('child factory throw rolls back the child, parent siblings stay alive', () => {
    const siblingDisposed = vi.fn()
    const sibling = defineController((ctx) => {
      ctx.onDispose(siblingDisposed)
      return { ok: true }
    })
    const broken = defineController(() => {
      throw new Error('broken')
    })
    const parent = defineController((ctx) => {
      ctx.child(sibling, undefined)
      ctx.child(broken, undefined) // throws
      return {}
    })

    expect(() => createRoot(parent, { deps: noopApi })).toThrow('broken')
    // The sibling that *was* successfully constructed must be torn down
    // because the parent's factory threw — partial parent rollback.
    expect(siblingDisposed).toHaveBeenCalledTimes(1)
  })

  test('a parent that catches a child throw keeps successful siblings alive', () => {
    const siblingDisposed = vi.fn()
    const sibling = defineController((ctx) => {
      ctx.onDispose(siblingDisposed)
      return { ok: true }
    })
    const broken = defineController(() => {
      throw new Error('broken')
    })
    const parent = defineController((ctx) => {
      const s = ctx.child(sibling, undefined)
      try {
        ctx.child(broken, undefined)
      } catch {
        // swallowed
      }
      return { s }
    })

    const root = createRoot(parent, { deps: noopApi })
    expect(siblingDisposed).not.toHaveBeenCalled()
    expect(root.s.ok).toBe(true)
    root.dispose()
    expect(siblingDisposed).toHaveBeenCalledTimes(1)
  })

  test('root bootstrap failure throws out of createRoot (no onError)', () => {
    const onError = vi.fn()
    const broken = defineController(() => {
      throw new Error('bootstrap fail')
    })
    expect(() => createRoot(broken, { deps: noopApi, onError })).toThrow('bootstrap fail')
    expect(onError).not.toHaveBeenCalled()
  })

  test('root bootstrap failure disposes the QueryClient (plugins / listeners cleaned up)', () => {
    // Regression: the QueryClient + its plugins were created BEFORE the
    // factory ran. If the factory threw, the client (and any plugin-side
    // listeners — window/storage subscribers, transports) leaked.
    const initSpy = vi.fn()
    const disposeSpy = vi.fn()
    const plugin = {
      init: initSpy,
      dispose: disposeSpy,
    }
    const broken = defineController(() => {
      throw new Error('bootstrap fail')
    })
    expect(() =>
      createRoot(broken, {
        deps: noopApi,
        plugins: [plugin],
      }),
    ).toThrow('bootstrap fail')
    expect(initSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('createTestController', () => {
  test('constructs an isolated root from a controller taking props', () => {
    const userController = defineController((_ctx, props: { id: string }) => {
      const greeting = computed(() => `hello ${props.id}`)
      return { id: props.id, greeting }
    })
    const root = createTestController(userController, {
      deps: { whatever: true },
      props: { id: 'u1' },
    })
    expect(root.greeting.value).toBe('hello u1')
    expect(typeof root.dispose).toBe('function')
    root.dispose()
  })
})

describe('three-level tree (root → feature → leaf)', () => {
  test('end-to-end: deps, effects, fields, emitters, suspend/resume/dispose', () => {
    const log: string[] = []

    const leaf = defineController((ctx, props: { name: string }) => {
      const field = ctx.field('', [(v) => (v.length === 0 ? 'required' : null)])
      ctx.onDispose(() => log.push(`leaf:${props.name}:disposed`))
      return { field, name: props.name }
    })

    const feature = defineController((ctx) => {
      const events = ctx.emitter<{ kind: string }>()
      const a = ctx.child(leaf, { name: 'a' })
      const b = ctx.child(leaf, { name: 'b' })
      ctx.effect(() => {
        // Track both fields' validity.
        if (a.field.isValid.value && b.field.isValid.value) {
          events.emit({ kind: 'both-valid' })
        }
      })
      ctx.onSuspend(() => log.push('feature:suspended'))
      ctx.onResume(() => log.push('feature:resumed'))
      return { a, b, events }
    })

    const rootDef = defineController((ctx) => ({
      feature: ctx.child(feature, undefined),
    }))

    const root = createRoot(rootDef, { deps: noopApi })
    const seen: string[] = []
    const off = root.feature.events.on((e) => seen.push(e.kind))

    expect(root.feature.a.field.isValid.value).toBe(false)
    root.feature.a.field.set('x')
    expect(root.feature.a.field.isValid.value).toBe(true)
    root.feature.b.field.set('y')
    expect(seen).toEqual(['both-valid'])

    root.suspend()
    expect(log).toContain('feature:suspended')
    root.resume()
    expect(log).toContain('feature:resumed')
    off()

    root.dispose()
    expect(log).toContain('leaf:a:disposed')
    expect(log).toContain('leaf:b:disposed')
  })
})

describe('ctx.attach — early-dispose child handle', () => {
  test('dispose() tears down the child early; parent survives', () => {
    const teardownLog: string[] = []
    const leaf = defineController(
      (ctx) => {
        ctx.onDispose(() => teardownLog.push('leaf:disposed'))
        return { mark: 'leaf' as const }
      },
      { name: 'leaf' },
    )

    let attached: { api: { mark: 'leaf' }; dispose: () => void } | undefined
    const root = createRoot(
      defineController(
        (ctx) => {
          attached = ctx.attach(leaf, undefined)
          return {}
        },
        { name: 'parent' },
      ),
      { deps: {} },
    )

    expect(attached!.api.mark).toBe('leaf')
    attached!.dispose()
    expect(teardownLog).toEqual(['leaf:disposed'])

    // Re-disposing is idempotent.
    attached!.dispose()
    expect(teardownLog).toEqual(['leaf:disposed'])

    root.dispose()
  })

  test('child still disposes via parent dispose when never explicitly disposed', () => {
    const teardownLog: string[] = []
    const leaf = defineController((ctx) => {
      ctx.onDispose(() => teardownLog.push('leaf:disposed'))
      return {}
    })
    const root = createRoot(
      defineController((ctx) => {
        ctx.attach(leaf, undefined)
        return {}
      }),
      { deps: {} },
    )

    root.dispose()
    expect(teardownLog).toEqual(['leaf:disposed'])
  })

  test('suspend / resume cascade through the attached child', () => {
    const log: string[] = []
    const leaf = defineController(
      (ctx) => {
        ctx.onSuspend(() => log.push('leaf:suspend'))
        ctx.onResume(() => log.push('leaf:resume'))
        ctx.onDispose(() => log.push('leaf:dispose'))
        return {}
      },
      { name: 'leaf' },
    )

    let attached:
      | { api: object; dispose: () => void; suspend: () => void; resume: () => void }
      | undefined
    const root = createRoot(
      defineController((ctx) => {
        attached = ctx.attach(leaf, undefined)
        return {}
      }),
      { deps: {} },
    )

    attached!.suspend()
    expect(log).toEqual(['leaf:suspend'])

    // Idempotent: a second suspend while already suspended is a no-op.
    attached!.suspend()
    expect(log).toEqual(['leaf:suspend'])

    attached!.resume()
    expect(log).toEqual(['leaf:suspend', 'leaf:resume'])

    // After dispose, suspend/resume no-op.
    attached!.dispose()
    expect(log).toEqual(['leaf:suspend', 'leaf:resume', 'leaf:dispose'])
    attached!.suspend()
    attached!.resume()
    expect(log).toEqual(['leaf:suspend', 'leaf:resume', 'leaf:dispose'])

    root.dispose()
  })
})
