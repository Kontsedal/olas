// @vitest-environment jsdom

/**
 * `@kontsedal/olas-react` under `preact/compat`, the way a Preact app aliases
 * `react` to it. Every `react` import this file and the adapter make resolves
 * to compat, and preact renders. React's own renderer never loads here.
 *
 * What it pins, beyond "the hooks run": compat's `useSyncExternalStore` shim
 * still gets the fine-grained `useQuery` (no re-render for a field nobody
 * reads), compat's `Suspense` retries a suspended `useSuspenseQuery` once the
 * data lands, and `SuspendOnUnmount` suspends on unmount.
 */
import {
  createField,
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  queryEngine,
  signal,
} from '@kontsedal/olas-core'
import { render } from 'preact'
import * as compat from 'preact/compat'
import { act } from 'preact/test-utils'
import * as ReactNamespace from 'react'
import { Suspense } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  OlasProvider,
  SuspendOnUnmount,
  useField,
  useFieldInput,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useRoot,
  useSuspenseQuery,
  useValue,
} from '../src'

vi.mock('react', async () => {
  const compat = await import('preact/compat')
  return { ...compat, default: compat.default }
})
vi.mock('react/jsx-runtime', async () => await import('preact/compat/jsx-runtime'))
vi.mock('react/jsx-dev-runtime', async () => await import('preact/compat/jsx-dev-runtime'))

let host: HTMLElement | undefined
const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  if (host !== undefined) render(null, host)
  host?.remove()
  host = undefined
  for (const r of roots.splice(0)) r.dispose()
})

function mount(node: preact.ComponentChild): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    render(node, host as HTMLElement)
  })
  return host
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

type Gate<T> = { promise: Promise<T>; resolve(value: T): void }
const gate = <T,>(): Gate<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('the alias', () => {
  test('every react import in this file and the adapter is preact/compat', () => {
    expect(ReactNamespace.useSyncExternalStore).toBe(compat.useSyncExternalStore)
    expect(ReactNamespace.createContext).toBe(compat.createContext)
  })
})

describe('OlasProvider, useRoot and useValue', () => {
  test('a component reads a signal through the provided root and follows its writes', async () => {
    const root = createRoot(
      defineController(() => {
        const count = signal(1)
        return { count, inc: () => count.set(count.peek() + 1) }
      }),
      { deps: {} },
    )
    roots.push(root)
    function Count() {
      const api = useRoot<typeof root.api>()
      const count = useValue(api.count)
      return (
        <button type="button" onClick={api.inc}>
          {count}
        </button>
      )
    }
    const el = mount(
      <OlasProvider root={root}>
        <Count />
      </OlasProvider>,
    )
    expect(el.textContent).toBe('1')
    act(() => {
      el.querySelector('button')?.click()
    })
    expect(el.textContent).toBe('2')
  })
})

describe('useQuery and useInfiniteQuery', () => {
  test('the fine-grained subscription holds under the compat useSyncExternalStore shim', async () => {
    const gates: Array<Gate<string>> = []
    const q = defineQuery({
      id: 'preact/fine',
      key: () => [],
      fetcher: () => {
        const g = gate<string>()
        gates.push(g)
        return g.promise
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    roots.push(root)
    let renders = 0
    function View() {
      renders += 1
      const { data } = useQuery(root.api.q)
      return <p>{data ?? 'none'}</p>
    }
    const el = mount(<View />)
    expect(el.textContent).toBe('none')
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    expect(el.textContent).toBe('v1')
    const settled = renders
    await act(async () => {
      void root.api.q.refetch()
    })
    expect(root.api.q.isFetching.peek()).toBe(true)
    await act(async () => {
      gates[1]?.resolve('v2')
    })
    await flush()
    expect(el.textContent).toBe('v2')
    // One re-render for the data; none for isFetching going up and down.
    expect(renders).toBe(settled + 1)
  })

  test('an infinite query pages through one hook', async () => {
    const feed = defineInfiniteQuery({
      id: 'preact/feed',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => [pageParam],
      initialPageParam: 0,
      getNextPageParam: (_last: number[], all: number[][]) => (all.length < 2 ? all.length : null),
      itemsOf: (page: number[]) => page,
    })
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    roots.push(root)
    function Feed() {
      const { flat, hasNextPage, fetchNextPage } = useInfiniteQuery(root.api.feed)
      return (
        <button type="button" onClick={() => void fetchNextPage()}>
          {`${flat.join(',')}|${hasNextPage}`}
        </button>
      )
    }
    const el = mount(<Feed />)
    await flush()
    expect(el.textContent).toBe('0|true')
    act(() => {
      el.querySelector('button')?.click()
    })
    await flush()
    expect(el.textContent).toBe('0,1|false')
  })

  test('compat Suspense shows the fallback, then retries once the data lands', async () => {
    const g = gate<string>()
    const q = defineQuery({ id: 'preact/suspense', key: () => [], fetcher: () => g.promise })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    roots.push(root)
    function View() {
      const { data } = useSuspenseQuery(root.api.q)
      return <p>{data}</p>
    }
    const el = mount(
      <Suspense fallback={<p>loading</p>}>
        <View />
      </Suspense>,
    )
    expect(el.textContent).toBe('loading')
    await act(async () => {
      g.resolve('ready')
    })
    await flush()
    expect(el.textContent).toBe('ready')
  })
})

describe('fields and mutations', () => {
  test('useFieldInput binds an input: typing writes the field, blur touches it', async () => {
    const root = createRoot(
      defineController((ctx) => ({ name: createField<string>(ctx, '') })),
      { deps: {} },
    )
    roots.push(root)
    function Name() {
      const input = useFieldInput(root.api.name)
      const { touched } = useField(root.api.name)
      return (
        <>
          <input {...input} />
          <p>{String(touched)}</p>
        </>
      )
    }
    const el = mount(<Name />)
    const input = el.querySelector('input') as HTMLInputElement
    // compat routes `onChange` on a text input to the `input` event.
    act(() => {
      input.value = 'Ada'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(root.api.name.value).toBe('Ada')
    act(() => {
      input.dispatchEvent(new Event('blur'))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(el.querySelector('p')?.textContent).toBe('true')
  })

  test('useMutation: mutate is fire-and-forget; state lands on the hook', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        save: createMutation(ctx, {
          mutate: async (v: number) => {
            if (v < 0) throw new Error('negative')
            return v * 2
          },
        }),
      })),
      { queries: queryEngine(), deps: {}, onError: () => {} },
    )
    roots.push(root)
    function Save() {
      const { mutate, status, data } = useMutation(root.api.save)
      return (
        <>
          <button type="button" onClick={() => mutate(21)}>
            ok
          </button>
          <button type="button" onClick={() => mutate(-1)}>
            fail
          </button>
          <p>{`${status}|${data ?? ''}`}</p>
        </>
      )
    }
    const el = mount(<Save />)
    const [ok, fail] = el.querySelectorAll('button')
    act(() => ok?.click())
    await flush()
    expect(el.querySelector('p')?.textContent).toBe('success|42')
    act(() => fail?.click())
    await flush()
    expect(el.querySelector('p')?.textContent).toBe('error|42')
  })
})

describe('SuspendOnUnmount', () => {
  test('unmounting the wrapper suspends the controller; remounting resumes it', () => {
    const root = createRoot(
      defineController(() => ({})),
      { deps: {} },
    )
    roots.push(root)
    const controller = { suspend: vi.fn(), resume: vi.fn() }
    const el = mount(
      <SuspendOnUnmount controller={controller}>
        <p>child</p>
      </SuspendOnUnmount>,
    )
    expect(el.textContent).toBe('child')
    expect(controller.resume).toHaveBeenCalledTimes(1)
    act(() => {
      render(null, el)
    })
    expect(controller.suspend).toHaveBeenCalledTimes(1)
  })
})
