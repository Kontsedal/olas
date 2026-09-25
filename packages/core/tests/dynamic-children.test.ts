import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const emptyDeps = {}

// ─── ctx.attach ─────────────────────────────────────────────────────────────

describe('ctx.attach', () => {
  test('dispose is idempotent', () => {
    const log: string[] = []
    const editor = defineController(
      (ctx, props: { initial: string }) => {
        ctx.onDispose(() => log.push(`editor:${props.initial}:disposed`))
        return { draft: signal(props.initial) }
      },
      { name: 'editor' },
    )
    let handle: { api: { draft: { value: string } }; dispose: () => void } | undefined
    const root = createRoot(
      defineController((ctx) => {
        handle = ctx.attach(editor, { initial: 'hello' })
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(handle?.api.draft.value).toBe('hello')
    handle?.dispose()
    handle?.dispose()
    expect(log).toEqual(['editor:hello:disposed'])
    root.dispose()
    expect(log).toEqual(['editor:hello:disposed'])
  })

  test('options.deps overrides the parent deps for the attached controller', () => {
    type Deps = { tag: string }
    let seen: string | undefined
    const child = defineController((ctx) => {
      seen = (ctx.deps as Deps).tag
      return {}
    })
    const root = createRoot(
      defineController((ctx) => {
        ctx.attach(child, undefined, { deps: { tag: 'override' } })
        return {}
      }),
      { queries: queryEngine(), deps: { tag: 'parent' } },
    )
    expect(seen).toBe('override')
    root.dispose()
  })
})

// ─── ctx.collection ─────────────────────────────────────────────────────────

describe('ctx.collection — homogeneous', () => {
  const itemController = defineController(
    (ctx, props: { id: string; initialName: string }) => {
      const name = signal(props.initialName)
      ctx.onDispose(() => {
        /* presence verified via outer disposed array */
      })
      return { id: props.id, name }
    },
    { name: 'item' },
  )

  test('initial population matches source order; size + items react', () => {
    const source = signal<ReadonlyArray<{ id: string; name: string }>>([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ])
    const root = createRoot(
      defineController((ctx) => {
        const c = ctx.collection({
          source,
          keyOf: (i) => i.id,
          controller: itemController,
          propsOf: (i) => ({ id: i.id, initialName: i.name }),
        })
        return { c }
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(root.api.c.size.value).toBe(2)
    expect(root.api.c.items.value.map((x) => x.key)).toEqual(['a', 'b'])
    expect(root.api.c.has('a')).toBe(true)
    expect(root.api.c.get('a')?.id).toBe('a')

    source.set([
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
      { id: 'a', name: 'A' },
    ])
    expect(root.api.c.items.value.map((x) => x.key)).toEqual(['b', 'c', 'a'])
    expect(root.api.c.size.value).toBe(3)
    root.dispose()
  })

  test('removed keys dispose their children; added keys construct new ones', () => {
    const disposed: string[] = []
    const constructed: string[] = []
    const tracker = defineController(
      (ctx, props: { id: string }) => {
        constructed.push(props.id)
        ctx.onDispose(() => disposed.push(props.id))
        return { id: props.id }
      },
      { name: 'tracker' },
    )

    const source = signal<ReadonlyArray<{ id: string }>>([{ id: 'a' }, { id: 'b' }])
    const root = createRoot(
      defineController((ctx) => ({
        c: ctx.collection({
          source,
          keyOf: (i) => i.id,
          controller: tracker,
          propsOf: (i) => ({ id: i.id }),
        }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(constructed).toEqual(['a', 'b'])
    expect(disposed).toEqual([])

    source.set([{ id: 'b' }, { id: 'c' }])
    expect(constructed).toEqual(['a', 'b', 'c'])
    expect(disposed).toEqual(['a'])

    root.dispose()
    // Parent dispose tears down remaining live children.
    expect(disposed.sort()).toEqual(['a', 'b', 'c'])
  })

  test('propsOf is NOT re-applied for unchanged keys (factory called once)', () => {
    const propsSeen: Array<string> = []
    const child = defineController((_ctx, props: { id: string; name: string }) => {
      propsSeen.push(`${props.id}/${props.name}`)
      return { id: props.id }
    })

    const source = signal<ReadonlyArray<{ id: string; name: string }>>([{ id: 'x', name: 'first' }])
    const root = createRoot(
      defineController((ctx) => ({
        c: ctx.collection({
          source,
          keyOf: (i) => i.id,
          controller: child,
          propsOf: (i) => ({ id: i.id, name: i.name }),
        }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(propsSeen).toEqual(['x/first'])

    // Mutate the same key's content — child must not be reconstructed.
    source.set([{ id: 'x', name: 'second' }])
    expect(propsSeen).toEqual(['x/first'])
    root.dispose()
  })

  test('parent suspend pauses the diff loop; resume reconciles to current source', () => {
    const constructed: string[] = []
    const disposed: string[] = []
    const child = defineController((ctx, props: { id: string }) => {
      constructed.push(props.id)
      ctx.onDispose(() => disposed.push(props.id))
      return {}
    })
    const source = signal<ReadonlyArray<{ id: string }>>([{ id: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        c: ctx.collection({
          source,
          keyOf: (i) => i.id,
          controller: child,
          propsOf: (i) => ({ id: i.id }),
        }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(constructed).toEqual(['a'])

    root.suspend()
    // Source changes while suspended must NOT touch children — the diff
    // effect is torn down on suspend like any other ctx.effect.
    source.set([{ id: 'b' }])
    expect(constructed).toEqual(['a'])
    expect(disposed).toEqual([])

    root.resume()
    // Reconciliation runs on resume against the current source.
    expect(disposed).toEqual(['a'])
    expect(constructed).toEqual(['a', 'b'])

    root.dispose()
  })

  test('construction throw routes to onError with kind=construction; bad item skipped', () => {
    const onError = vi.fn()
    const broken = defineController((_ctx, props: { id: string }) => {
      if (props.id === 'bad') throw new Error(`bad item ${props.id}`)
      return { id: props.id }
    })
    const source = signal<ReadonlyArray<{ id: string }>>([
      { id: 'good' },
      { id: 'bad' },
      { id: 'also-good' },
    ])
    const root = createRoot(
      defineController((ctx) => ({
        c: ctx.collection({
          source,
          keyOf: (i) => i.id,
          controller: broken,
          propsOf: (i) => ({ id: i.id }),
        }),
      })),
      { queries: queryEngine(), deps: emptyDeps, onError },
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('construction')
    expect(root.api.c.items.value.map((x) => x.key)).toEqual(['good', 'also-good'])
    root.dispose()
  })
})

describe('ctx.collection — factory (heterogeneous) form', () => {
  test('factory picks per-item controller and props; type-discriminant change rebuilds', () => {
    const log: string[] = []
    const textBlock = defineController(
      (ctx, props: { content: string }) => {
        log.push(`text:construct:${props.content}`)
        ctx.onDispose(() => log.push(`text:dispose:${props.content}`))
        return { kind: 'text' as const, content: props.content }
      },
      { name: 'text' },
    )
    const codeBlock = defineController(
      (ctx, props: { code: string }) => {
        log.push(`code:construct:${props.code}`)
        ctx.onDispose(() => log.push(`code:dispose:${props.code}`))
        return { kind: 'code' as const, code: props.code }
      },
      { name: 'code' },
    )

    type Block =
      | { id: string; type: 'text'; content: string }
      | { id: string; type: 'code'; code: string }
    const source = signal<ReadonlyArray<Block>>([{ id: 'a', type: 'text', content: 'hello' }])
    const root = createRoot(
      defineController((ctx) => ({
        blocks: ctx.collection({
          source,
          keyOf: (b) => b.id,
          factory: (b) => {
            if (b.type === 'text') return { controller: textBlock, props: { content: b.content } }
            return { controller: codeBlock, props: { code: b.code } }
          },
        }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )

    expect(log).toEqual(['text:construct:hello'])
    // Same key, different type → rebuild.
    source.set([{ id: 'a', type: 'code', code: 'const x = 1' }])
    expect(log).toEqual([
      'text:construct:hello',
      'text:dispose:hello',
      'code:construct:const x = 1',
    ])

    root.dispose()
  })
})

// ─── ctx.lazyChild ─────────────────────────────────────────────────────────

describe('ctx.lazyChild', () => {
  test('status walks idle → loading → ready; api flips to the controller surface', async () => {
    const loaded = defineController(
      (ctx, props: { content: string }) => {
        ctx.onDispose(() => {})
        return { content: props.content }
      },
      { name: 'editor' },
    )
    let lazy:
      | {
          status: { value: 'idle' | 'loading' | 'ready' | 'error' }
          api: { value: { content: string } | undefined }
          error: { value: unknown | undefined }
          load(): Promise<unknown>
          dispose(): void
        }
      | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(() => Promise.resolve(loaded), { content: 'hi' })
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )

    expect(lazy!.status.value).toBe('idle')
    expect(lazy!.api.value).toBeUndefined()

    const p = lazy!.load()
    expect(lazy!.status.value).toBe('loading')

    await p
    expect(lazy!.status.value).toBe('ready')
    expect(lazy!.api.value).toEqual({ content: 'hi' })
    root.dispose()
  })

  test('load() is idempotent — multiple calls return the same promise', async () => {
    let loaderCalls = 0
    const def = defineController(() => ({ ok: true }))
    let lazy: { load(): Promise<unknown>; dispose(): void } | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(() => {
          loaderCalls++
          return Promise.resolve(def)
        }, undefined)
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const a = lazy!.load()
    const b = lazy!.load()
    expect(a).toBe(b)
    await a
    expect(loaderCalls).toBe(1)
    root.dispose()
  })

  test('loader rejection flips status to error and routes onError(construction)', async () => {
    const onError = vi.fn()
    let lazy:
      | { load(): Promise<unknown>; status: { value: string }; error: { value: unknown } }
      | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(() => Promise.reject(new Error('import failed')), undefined)
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps, onError },
    )
    await expect(lazy!.load()).rejects.toThrow('import failed')
    expect(lazy!.status.value).toBe('error')
    expect((lazy!.error.value as Error).message).toBe('import failed')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('construction')
    root.dispose()
  })

  test('controller-construction throw flips status to error; onError fires once', async () => {
    const onError = vi.fn()
    const broken = defineController(() => {
      throw new Error('factory broken')
    })
    let lazy: { load(): Promise<unknown>; status: { value: string } } | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(() => Promise.resolve(broken), undefined)
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps, onError },
    )
    await expect(lazy!.load()).rejects.toThrow('factory broken')
    expect(lazy!.status.value).toBe('error')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('construction')
    root.dispose()
  })

  test('parent dispose during in-flight load drops the construction on settle', async () => {
    let resolveLoader: (def: unknown) => void = () => {}
    const loaderPromise = new Promise<unknown>((r) => {
      resolveLoader = r
    })
    const constructed = vi.fn()
    const def = defineController(() => {
      constructed()
      return {}
    })
    let lazy: { load(): Promise<unknown> } | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(() => loaderPromise as Promise<typeof def>, undefined)
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const loadPromise = lazy!.load()
    root.dispose()
    resolveLoader(def)
    await expect(loadPromise).rejects.toThrow(/disposed during load/)
    expect(constructed).not.toHaveBeenCalled()
  })

  test('explicit dispose() disposes the loaded child early', async () => {
    const log: string[] = []
    const def = defineController((ctx) => {
      ctx.onDispose(() => log.push('child:disposed'))
      return {}
    })
    let lazy: { load(): Promise<unknown>; dispose(): void } | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(() => Promise.resolve(def), undefined)
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await lazy!.load()
    expect(log).toEqual([])
    lazy!.dispose()
    expect(log).toEqual(['child:disposed'])
    // Parent dispose doesn't re-dispose.
    root.dispose()
    expect(log).toEqual(['child:disposed'])
  })

  test('explicit dispose() then parent.dispose() does not re-fire child cleanup', async () => {
    // Repro for the orphan-flag-entry leak: the parent's reverse-cascade
    // iterates over its lifecycle entries. Even after `lazy.dispose()`, the
    // pre-fix code left an `onDispose` flag entry behind that still ran when
    // the parent eventually disposed. With the fix the flag entry is spliced
    // out alongside the child entry, so parent dispose has nothing to do.
    const log: string[] = []
    const def = defineController((ctx) => {
      ctx.onDispose(() => log.push('child:disposed'))
      return {}
    })
    const lazies: Array<{ load(): Promise<unknown>; dispose(): void }> = []
    const root = createRoot(
      defineController((ctx) => {
        for (let i = 0; i < 3; i++) {
          lazies.push(ctx.lazyChild(() => Promise.resolve(def), undefined))
        }
        return {}
      }),
      { queries: queryEngine(), deps: emptyDeps },
    )
    for (const l of lazies) await l.load()
    for (const l of lazies) l.dispose()
    expect(log).toEqual(['child:disposed', 'child:disposed', 'child:disposed'])
    // Each child fired its own onDispose exactly once. Parent teardown must
    // not re-fire anything — the flag entries were spliced.
    root.dispose()
    expect(log).toEqual(['child:disposed', 'child:disposed', 'child:disposed'])
  })
})

// ─── one bad item, disposal, and rebuilds ──────────────────────────────────

describe('ctx.collection — one bad item does not stop the reconcile', () => {
  const row = defineController(
    (ctx, props: { id: string; log: string[] }) => {
      ctx.onDispose(() => props.log.push(`dispose:${props.id}`))
      return { id: props.id }
    },
    { name: 'row' },
  )
  type Item = { id: string; bad?: boolean }

  test('a throwing propsOf skips that item; the removals and the later items still land', () => {
    const onError = vi.fn()
    const log: string[] = []
    const source = signal<ReadonlyArray<Item>>([{ id: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        rows: ctx.collection({
          source,
          keyOf: (i) => i.id,
          controller: row,
          propsOf: (i) => {
            if (i.bad) throw new Error(`bad ${i.id}`)
            return { id: i.id, log }
          },
        }),
      })),
      { deps: emptyDeps, onError },
    )
    source.set([{ id: 'b', bad: true }, { id: 'c' }])
    expect(root.api.rows.items.value.map((x) => x.key)).toEqual(['c'])
    expect(root.api.rows.has('a')).toBe(false)
    expect(log).toEqual(['dispose:a'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('construction')

    // The next reconcile does not stop at the same item either.
    source.set([{ id: 'b', bad: true }, { id: 'c' }, { id: 'd' }])
    expect(root.api.rows.items.value.map((x) => x.key)).toEqual(['c', 'd'])
    root.dispose()
  })

  test('a throwing factory skips a new item and keeps an existing one', () => {
    const onError = vi.fn()
    const log: string[] = []
    const source = signal<ReadonlyArray<Item>>([{ id: 'a' }])
    const root = createRoot(
      defineController((ctx) => ({
        rows: ctx.collection({
          source,
          keyOf: (i) => i.id,
          factory: (i) => {
            if (i.bad) throw new Error(`bad ${i.id}`)
            return { controller: row, props: { id: i.id, log } }
          },
        }),
      })),
      { deps: emptyDeps, onError },
    )
    // `a` now fails its type check, and `b` fails its build; `c` still builds.
    source.set([{ id: 'a', bad: true }, { id: 'b', bad: true }, { id: 'c' }])
    expect(root.api.rows.items.value.map((x) => x.key)).toEqual(['a', 'c'])
    expect(log).toEqual([])
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls.map((c) => c[1].kind)).toEqual(['construction', 'construction'])
    root.dispose()
  })

  test('a throwing keyOf skips that item', () => {
    const onError = vi.fn()
    const log: string[] = []
    const source = signal<ReadonlyArray<Item>>([{ id: 'a' }, { id: 'b', bad: true }, { id: 'c' }])
    const root = createRoot(
      defineController((ctx) => ({
        rows: ctx.collection({
          source,
          keyOf: (i) => {
            if (i.bad) throw new Error('no key')
            return i.id
          },
          controller: row,
          propsOf: (i) => ({ id: i.id, log }),
        }),
      })),
      { deps: emptyDeps, onError },
    )
    expect(root.api.rows.items.value.map((x) => x.key)).toEqual(['a', 'c'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('construction')
    root.dispose()
  })
})

describe('ctx.collection — after its owner disposes', () => {
  test('a propsOf that disposes the owner builds nothing more, and items ends empty', () => {
    const built: string[] = []
    const child = defineController((_ctx, p: { id: string }) => {
      built.push(p.id)
      return { id: p.id }
    })
    let dispose: () => void = () => {}
    const source = signal<string[]>([])
    const root = createRoot(
      defineController((ctx) => ({
        rows: ctx.collection({
          source,
          keyOf: (id) => id,
          controller: child,
          propsOf: (id) => {
            if (id === 'stop') dispose()
            return { id }
          },
        }),
      })),
      { deps: emptyDeps },
    )
    dispose = () => root.dispose()
    source.set(['a', 'stop', 'b'])
    expect(built).toEqual(['a'])
    expect(root.api.rows.items.value).toEqual([])
  })

  test('items is empty and has() is false', () => {
    const child = defineController((_ctx, p: { id: string }) => ({ id: p.id }))
    const root = createRoot(
      defineController((ctx) => ({
        rows: ctx.collection({
          source: signal([{ id: 'a' }, { id: 'b' }]),
          keyOf: (i) => i.id,
          controller: child,
          propsOf: (i) => ({ id: i.id }),
        }),
      })),
      { deps: emptyDeps },
    )
    const { rows } = root.api
    expect(rows.size.value).toBe(2)
    root.dispose()
    expect(rows.items.value).toEqual([])
    expect(rows.size.value).toBe(0)
    expect(rows.has('a')).toBe(false)
    expect(rows.get('a')).toBeUndefined()
    expect(rows.isItemSuspended('a')).toBe(false)
  })
})

describe('ctx.collection — a type rebuild keeps an explicit suspension', () => {
  test('the rebuilt child starts suspended and a tree resume does not wake it', () => {
    const tick = signal(0)
    const runs: string[] = []
    const make = (name: string) =>
      defineController(
        (ctx) => {
          ctx.effect(() => {
            void tick.value
            runs.push(name)
          })
          return { name }
        },
        { name },
      )
    const text = make('text')
    const code = make('code')
    type Block = { id: string; type: 'text' | 'code' }
    const source = signal<ReadonlyArray<Block>>([{ id: 'x', type: 'text' }])
    const root = createRoot(
      defineController((ctx) => ({
        blocks: ctx.collection({
          source,
          keyOf: (b) => b.id,
          factory: (b) => ({ controller: b.type === 'text' ? text : code, props: undefined }),
        }),
      })),
      { deps: emptyDeps },
    )
    const { blocks } = root.api
    blocks.suspendItem('x')
    source.set([{ id: 'x', type: 'code' }])
    expect(blocks.get('x')).toEqual({ name: 'code' })
    expect(blocks.isItemSuspended('x')).toBe(true)
    runs.length = 0
    tick.set(1)
    expect(runs).toEqual([])
    root.suspend()
    root.resume()
    tick.set(2)
    expect(runs).toEqual([])
    blocks.resumeItem('x')
    tick.set(3)
    expect(runs.at(-1)).toBe('code')
    root.dispose()
  })
})

describe('ctx.lazyChild — the handle follows disposal and loader failures', () => {
  type Handle = {
    status: { value: string }
    api: { value: unknown }
    error: { value: unknown }
    load(): Promise<unknown>
    dispose(): void
  }
  function withLazy(
    loader: () => Promise<unknown>,
    onError?: (err: unknown, context: { kind: string }) => void,
  ) {
    let lazy: Handle | undefined
    const root = createRoot(
      defineController((ctx) => {
        lazy = ctx.lazyChild(loader as never, undefined) as unknown as Handle
        return {}
      }),
      { deps: emptyDeps, onError },
    )
    return { root, lazy: lazy as Handle }
  }
  const leaf = defineController(() => ({ ok: true }))

  test('dispose() after a load returns the handle to idle with no api', async () => {
    const { root, lazy } = withLazy(() => Promise.resolve(leaf))
    await lazy.load()
    expect(lazy.status.value).toBe('ready')
    lazy.dispose()
    expect(lazy.status.value).toBe('idle')
    expect(lazy.api.value).toBeUndefined()
    await expect(lazy.load()).rejects.toThrow(/after dispose/)
    root.dispose()
  })

  test('a parent dispose after a load returns the handle to idle too', async () => {
    const { root, lazy } = withLazy(() => Promise.resolve(leaf))
    await lazy.load()
    root.dispose()
    expect(lazy.status.value).toBe('idle')
    expect(lazy.api.value).toBeUndefined()
  })

  test('disposed mid-load: load() rejects and the status is idle, not loading', async () => {
    let settle: (def: typeof leaf) => void = () => {}
    const { root, lazy } = withLazy(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    const loading = lazy.load()
    expect(lazy.status.value).toBe('loading')
    lazy.dispose()
    settle(leaf)
    await expect(loading).rejects.toThrow(/disposed during load/)
    expect(lazy.status.value).toBe('idle')
    root.dispose()
  })

  test('a loader that throws synchronously sets error, reports, and rejects', async () => {
    const onError = vi.fn()
    const boom = new Error('boom')
    const { root, lazy } = withLazy(() => {
      throw boom
    }, onError)
    let loading: Promise<unknown> | undefined
    expect(() => {
      loading = lazy.load()
    }).not.toThrow()
    await expect(loading).rejects.toBe(boom)
    expect(lazy.status.value).toBe('error')
    expect(lazy.error.value).toBe(boom)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('construction')
    root.dispose()
  })

  test('a loader that returns no promise sets error the same way', async () => {
    const onError = vi.fn()
    const { root, lazy } = withLazy((() => leaf) as never, onError)
    await expect(lazy.load()).rejects.toThrow(/must return a promise/)
    expect(lazy.status.value).toBe('error')
    expect(onError).toHaveBeenCalledTimes(1)
    root.dispose()
  })
})
