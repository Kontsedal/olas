// @vitest-environment jsdom
import {
  batch,
  createField,
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  queryEngine,
  type ReadSignal,
  required,
  signal,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type App, createApp, createSSRApp, defineComponent, h, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  olasPlugin,
  useField,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useRoot,
  useValue,
} from '../src'

let app: App | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

function mount(
  root: Parameters<typeof olasPlugin>[0],
  setup: () => () => ReturnType<typeof h> | null,
) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  app = createApp(defineComponent({ setup }))
  app.use(olasPlugin(root))
  app.mount(el)
  return el
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

describe('useRoot and useValue', () => {
  test('a component reads a signal through the provided root and follows its writes', async () => {
    const root = createRoot(
      defineController(() => {
        const count = signal(1)
        return { count, inc: () => count.set(count.peek() + 1) }
      }),
      { deps: {} },
    )
    const el = mount(root, () => {
      const api = useRoot<{ count: typeof root.api.count; inc: () => void }>()
      const count = useValue(api.count)
      return () => h('button', { onClick: api.inc }, String(count.value))
    })
    expect(el.textContent).toBe('1')
    root.api.inc()
    await nextTick()
    expect(el.textContent).toBe('2')
    root.dispose()
  })

  test('useRoot without the plugin throws a message naming the fix', () => {
    const el = document.createElement('div')
    app = createApp(
      defineComponent({
        setup() {
          useRoot()
          return () => null
        },
      }),
    )
    let caught: unknown
    app.config.errorHandler = (err) => {
      caught = err
    }
    app.mount(el)
    expect(String(caught)).toMatch(/app\.use\(olasPlugin\(root\)\)/)
  })

  test("useRoot outside a component's setup throws an olas message, not a TypeError", () => {
    // Outside an injection context Vue's `inject` returns `undefined`, not
    // the default, and warns. The check has to come first.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let caught: unknown
    try {
      useRoot()
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeInstanceOf(TypeError)
    expect(String(caught)).toMatch(/^Error: \[olas\] useRoot\(\) found no root/)
    expect(String(caught)).toMatch(/setup\(\)/)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('unmounting stops the subscription', async () => {
    const count = signal(0)
    const root = createRoot(
      defineController(() => ({ count })),
      { deps: {} },
    )
    let reads = 0
    mount(root, () => {
      const value = useValue(root.api.count)
      return () => {
        reads += 1
        return h('span', String(value.value))
      }
    })
    const before = reads
    app?.unmount()
    app = undefined
    count.set(5)
    await nextTick()
    expect(reads).toBe(before)
    root.dispose()
  })
})

describe('useQuery and useInfiniteQuery', () => {
  test('loading, then data; refetch is passed through', async () => {
    let n = 0
    const q = defineQuery({ id: 'vue/q', key: () => [], fetcher: async () => `v${++n}` })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    let refetch: (() => Promise<string>) | undefined
    const el = mount(root, () => {
      const { data, isLoading, refetch: r } = useQuery(root.api.q)
      refetch = r
      return () => h('p', isLoading.value ? 'loading' : (data.value ?? ''))
    })
    expect(el.textContent).toBe('loading')
    await flush()
    expect(el.textContent).toBe('v1')
    await refetch?.()
    await flush()
    expect(el.textContent).toBe('v2')
    root.dispose()
  })

  test('an infinite query pages through its refs', async () => {
    const feed = defineInfiniteQuery({
      id: 'vue/feed',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => [pageParam],
      initialPageParam: 0,
      getNextPageParam: (_p: number[], all: number[][]) => (all.length < 3 ? all.length : null),
    })
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    let next: (() => Promise<void>) | undefined
    const el = mount(root, () => {
      const { flat, hasNextPage, fetchNextPage } = useInfiniteQuery(root.api.feed)
      next = fetchNextPage
      return () => h('p', `${flat.value.join(',')}|${hasNextPage.value}`)
    })
    await flush()
    expect(el.textContent).toBe('0|true')
    await next?.()
    await next?.()
    await flush()
    expect(el.textContent).toBe('0,1,2|false')
    root.dispose()
  })
})

describe('useField', () => {
  test('value is writable for v-model, and validation state follows', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        name: createField<string>(ctx, '', { validators: [required('Required')] }),
      })),
      { deps: {} },
    )
    let field: ReturnType<typeof useField<string>> | undefined
    const el = mount(root, () => {
      field = useField(root.api.name)
      const f = field
      return () => h('p', `${f.value.value}|${f.errors.value.join(',')}|${f.isDirty.value}`)
    })
    expect(el.textContent).toBe('|Required|false')
    if (field) field.value.value = 'Ada'
    await flush()
    expect(root.api.name.value).toBe('Ada')
    expect(el.textContent).toBe('Ada||true')
    root.dispose()
  })

  test('value reads a write at once, inside a batch too', async () => {
    const root = createRoot(
      defineController((ctx) => ({ name: createField<string>(ctx, 'a') })),
      { deps: {} },
    )
    let field: ReturnType<typeof useField<string>> | undefined
    const el = mount(root, () => {
      field = useField(root.api.name)
      const f = field
      return () => h('p', f.value.value)
    })
    let inside: string | undefined
    batch(() => {
      root.api.name.set('b')
      inside = field?.value.value
    })
    expect(inside).toBe('b')
    await nextTick()
    expect(el.textContent).toBe('b')
    if (field) field.value.value = 'c'
    expect(root.api.name.peek()).toBe('c')
    await nextTick()
    expect(el.textContent).toBe('c')
    root.dispose()
  })
})

describe('useMutation', () => {
  test('mutate is fire-and-forget; state lands on the refs', async () => {
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        mutate: async (v: number) => {
          if (v < 0) throw new Error('negative')
          return v * 2
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })
    let m: ReturnType<typeof useMutation<number, number>> | undefined
    const el = mount(root, () => {
      m = useMutation(root.api.save)
      const mm = m
      return () => h('p', `${mm.status.value}|${mm.data.value ?? ''}`)
    })
    expect(el.textContent).toBe('idle|')
    m?.mutate(21)
    await flush()
    expect(el.textContent).toBe('success|42')
    m?.mutate(-1) // rejects inside; must not surface as an unhandled rejection
    await flush()
    // A failed run keeps the last success's data; only `error` and `status` move.
    expect(el.textContent).toBe('error|42')
    await expect(m?.run(2)).resolves.toBe(4)
    root.dispose()
  })
})

describe('useValue details', () => {
  test('isEqual decides when a write triggers the component', async () => {
    const tags = signal(['a'])
    const root = createRoot(
      defineController(() => ({ tags })),
      { deps: {} },
    )
    let renders = 0
    const el = mount(root, () => {
      const value = useValue(root.api.tags, {
        isEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
      })
      return () => {
        renders += 1
        return h('p', value.value.join(','))
      }
    })
    const before = renders
    tags.set(['a']) // a new array with the same items
    await nextTick()
    expect(renders).toBe(before)
    tags.set(['a', 'b'])
    await nextTick()
    expect(el.textContent).toBe('a,b')
    root.dispose()
  })

  test('a value isEqual calls equal keeps the one shown, when the component re-renders for another reason', async () => {
    // React's semantics: isEqual means "unchanged, keep the previous value".
    const user = signal({ id: 1, name: 'A' })
    const tick = signal(0)
    const root = createRoot(
      defineController(() => ({ user, tick })),
      { deps: {} },
    )
    const el = mount(root, () => {
      const u = useValue(root.api.user, { isEqual: (a, b) => a.id === b.id })
      const t = useValue(root.api.tick)
      return () => h('p', `${u.value.name}:${t.value}`)
    })
    expect(el.textContent).toBe('A:0')
    user.set({ id: 1, name: 'B' })
    await nextTick()
    expect(el.textContent).toBe('A:0')
    tick.set(1)
    await nextTick()
    expect(el.textContent).toBe('A:1')
    user.set({ id: 2, name: 'C' })
    await nextTick()
    expect(el.textContent).toBe('C:1')
    root.dispose()
  })

  test('the ref is read-only, and reads the signal outside a component too', () => {
    // No effect scope: nothing to tie the subscription to, so it warns
    // (scope-warning.test.ts covers the warning).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const count = signal(1)
    const ref = useValue(count)
    ;(ref as { value: number }).value = 5
    expect(count.value).toBe(1)
    count.set(2)
    expect(ref.value).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('server render', () => {
  test('a server render reads each signal and leaves no subscription behind', async () => {
    const inner = signal(1)
    let live = 0
    const counted: ReadSignal<number> = {
      get value() {
        return inner.value
      },
      peek: () => inner.peek(),
      subscribe: (handler) => inner.subscribe(handler),
      subscribeChanges(handler) {
        live += 1
        const stop = inner.subscribeChanges(handler)
        return () => {
          live -= 1
          stop()
        }
      },
    }
    const root = createRoot(
      defineController((ctx) => ({ count: counted, name: createField<string>(ctx, 'Ada') })),
      { deps: {} },
    )
    // Vue never stops a component's effect scope on the server, so a
    // subscription made there would outlive the request.
    for (let i = 0; i < 3; i++) {
      const ssr = createSSRApp(
        defineComponent({
          setup() {
            const count = useValue(root.api.count)
            const { value, isDirty } = useField(root.api.name)
            return () => h('p', `${count.value}|${value.value}|${isDirty.value}`)
          },
        }),
      )
      ssr.use(olasPlugin(root))
      expect(await renderToString(ssr)).toBe('<p>1|Ada|false</p>')
    }
    expect(live).toBe(0)
    root.dispose()
  })
})

describe('action passthroughs', () => {
  test('useField actions reach the field', async () => {
    const root = createRoot(
      defineController((ctx) => ({ name: createField<string>(ctx, 'a') })),
      { deps: {} },
    )
    let field: ReturnType<typeof useField<string>> | undefined
    mount(root, () => {
      field = useField(root.api.name)
      return () => null
    })
    field?.set('b')
    expect(root.api.name.value).toBe('b')
    field?.setAsInitial('b')
    expect(root.api.name.isDirty.value).toBe(false)
    field?.markTouched()
    expect(root.api.name.touched.value).toBe(true)
    field?.setErrors(['taken'])
    expect(root.api.name.errors.value).toEqual(['taken'])
    await expect(field?.revalidate()).resolves.toBe(false)
    field?.set('c')
    field?.reset()
    expect(root.api.name.value).toBe('b')
    root.dispose()
  })

  test('useMutation reset clears the state', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        save: createMutation(ctx, { mutate: async (v: number) => v }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    let m: ReturnType<typeof useMutation<number, number>> | undefined
    mount(root, () => {
      m = useMutation(root.api.save)
      return () => null
    })
    await m?.run(3)
    expect(m?.data.value).toBe(3)
    m?.reset()
    await nextTick()
    expect(m?.status.value).toBe('idle')
    expect(m?.data.value).toBeUndefined()
    root.dispose()
  })

  test('useQuery hands back the subscription actions', () => {
    const q = defineQuery({ id: 'vue/actions', key: () => [], fetcher: async () => 1 })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    let result: ReturnType<typeof useQuery<number>> | undefined
    mount(root, () => {
      result = useQuery(root.api.q)
      return () => null
    })
    expect(result?.refetch).toBe(root.api.q.refetch)
    expect(result?.reset).toBe(root.api.q.reset)
    expect(result?.cancel).toBe(root.api.q.cancel)
    root.dispose()
  })
})
