// @vitest-environment jsdom

/**
 * `useQuery` and `useInfiniteQuery` re-render only for the fields a component
 * reads, and `useValue`'s `isEqual` holds a reference across an inline
 * selector. The rules: a field read during render is tracked; a field read
 * after commit returns its live value; a component that has read nothing yet
 * re-renders on every change.
 */
import {
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  queryEngine,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { Suspense, startTransition, useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { type UseQueryResult, useInfiniteQuery, useQuery, useValue } from '../src'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  cleanup()
  for (const r of roots.splice(0)) r.dispose()
})

type Gate<T> = { promise: Promise<T>; resolve(value: T): void }
const gate = <T,>(): Gate<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

/** A query whose every fetch waits on a gate the test opens. */
function gatedQueryRoot(id: string) {
  const gates: Array<Gate<string>> = []
  const q = defineQuery({
    id,
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
  return { root, gates }
}

describe('useQuery is fine-grained', () => {
  test('a component that renders only data does not re-render when a refetch flips isFetching', async () => {
    const { root, gates } = gatedQueryRoot('fine/data-only')
    let renders = 0
    function View() {
      renders += 1
      const { data } = useQuery(root.api.q)
      return <p>{data ?? 'none'}</p>
    }
    render(<View />)
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    expect(screen.getByText('v1')).toBeTruthy()
    const settled = renders

    // A background refetch: isFetching goes true, then false, and data stays.
    let refetched: Promise<string> | undefined
    await act(async () => {
      refetched = root.api.q.refetch()
    })
    expect(root.api.q.isFetching.peek()).toBe(true)
    await act(async () => {
      gates[1]?.resolve('v1')
      await refetched
    })
    await flush()
    expect(renders).toBe(settled)

    // A data change still re-renders.
    await act(async () => {
      refetched = root.api.q.refetch()
    })
    await act(async () => {
      gates[2]?.resolve('v2')
      await refetched
    })
    await flush()
    expect(screen.getByText('v2')).toBeTruthy()
    expect(renders).toBeGreaterThan(settled)
  })

  test('a component that renders isFetching re-renders for it', async () => {
    const { root, gates } = gatedQueryRoot('fine/fetching')
    function View() {
      const { data, isFetching } = useQuery(root.api.q)
      return <p>{`${data ?? 'none'}|${isFetching}`}</p>
    }
    render(<View />)
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    expect(screen.getByText('v1|false')).toBeTruthy()
    await act(async () => {
      void root.api.q.refetch()
    })
    expect(screen.getByText('v1|true')).toBeTruthy()
    await act(async () => {
      gates[1]?.resolve('v1')
    })
    await flush()
    expect(screen.getByText('v1|false')).toBeTruthy()
  })

  test('a field read after commit returns its live value, then re-renders for it', async () => {
    const { root, gates } = gatedQueryRoot('fine/late-read')
    let result: UseQueryResult<string> | undefined
    let renders = 0
    function View() {
      renders += 1
      const current = useQuery(root.api.q)
      result = current
      return <p>{current.data ?? 'none'}</p>
    }
    render(<View />)
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    const settled = renders
    await act(async () => {
      void root.api.q.refetch()
    })
    // No re-render happened for isFetching, yet a read from a handler is live.
    expect(renders).toBe(settled)
    expect(result?.isFetching).toBe(true)
    // That read tracked the field: the next flip re-renders.
    await act(async () => {
      gates[1]?.resolve('v1')
    })
    await flush()
    expect(renders).toBeGreaterThan(settled)
    expect(result?.isFetching).toBe(false)
  })

  test('a read after commit stays live when a later render is thrown away', async () => {
    // A transition whose sibling suspends renders View and then discards that
    // render. The committed result must still read live values afterwards.
    const { root, gates } = gatedQueryRoot('fine/discarded-render')
    let committed: UseQueryResult<string> | undefined
    let bump: (() => void) | undefined
    const never = new Promise<never>(() => {})
    function View({ n }: { n: number }) {
      const current = useQuery(root.api.q)
      useLayoutEffect(() => {
        committed = current
      })
      return <p>{`${current.data ?? 'none'}|${n}`}</p>
    }
    function Sibling({ n }: { n: number }) {
      if (n > 0) throw never
      return null
    }
    function Parent() {
      const [n, setN] = useState(0)
      bump = () => startTransition(() => setN(1))
      return (
        <Suspense fallback={<p>loading</p>}>
          <View n={n} />
          <Sibling n={n} />
        </Suspense>
      )
    }
    render(<Parent />)
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    expect(screen.getByText('v1|0')).toBeTruthy()

    await act(async () => {
      bump?.()
    })
    await flush()
    // The transition suspended, so the committed tree is still the old one.
    expect(screen.getByText('v1|0')).toBeTruthy()

    await act(async () => {
      void root.api.q.refetch()
    })
    expect(root.api.q.isFetching.peek()).toBe(true)
    expect(committed?.isFetching).toBe(true)
  })

  test('before anything is read, every change re-renders (renderHook reads after the fact)', async () => {
    const { root, gates } = gatedQueryRoot('fine/nothing-read')
    const { result } = renderHook(() => useQuery(root.api.q))
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    expect(result.current.data).toBe('v1')
    expect(result.current.status).toBe('success')
  })

  test('spreading the result tracks every field', async () => {
    const { root, gates } = gatedQueryRoot('fine/spread')
    let renders = 0
    function View() {
      renders += 1
      const state = { ...useQuery(root.api.q) }
      return <p>{state.data ?? 'none'}</p>
    }
    render(<View />)
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    const settled = renders
    await act(async () => {
      void root.api.q.refetch()
    })
    expect(renders).toBeGreaterThan(settled)
  })

  test('suspense tracks data and status whatever the component reads', async () => {
    const { root, gates } = gatedQueryRoot('fine/suspense')
    function View() {
      useQuery(root.api.q, { suspense: true })
      return <p>ready</p>
    }
    render(
      <Suspense fallback={<p>loading</p>}>
        <View />
      </Suspense>,
    )
    expect(screen.getByText('loading')).toBeTruthy()
    await act(async () => {
      gates[0]?.resolve('v1')
    })
    await flush()
    expect(screen.getByText('ready')).toBeTruthy()
  })
})

describe('useInfiniteQuery', () => {
  const feedRoot = (id: string, pageCount = 3) => {
    const gates: Array<Gate<number[]>> = []
    const feed = defineInfiniteQuery({
      id,
      key: () => [],
      initialPageParam: 0,
      fetcher: ({ pageParam }: { pageParam: number }) => {
        const g = gate<number[]>()
        gates.push(g)
        return g.promise.then((items) => items.map((n) => n + pageParam * 10))
      },
      getNextPageParam: (_last: number[], all: number[][]) =>
        all.length < pageCount ? all.length : null,
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
    return { root, gates }
  }

  test('pages through one subscription: flat, hasNextPage, isFetchingNextPage, fetchNextPage', async () => {
    const { root, gates } = feedRoot('fine/feed')
    let next: (() => Promise<void>) | undefined
    function Feed() {
      const { flat, hasNextPage, isFetchingNextPage, fetchNextPage, pages } = useInfiniteQuery(
        root.api.feed,
      )
      next = fetchNextPage
      return <p>{`${flat.join(',')}|${pages.length}|${hasNextPage}|${isFetchingNextPage}`}</p>
    }
    render(<Feed />)
    await act(async () => {
      gates[0]?.resolve([1, 2])
    })
    await flush()
    expect(screen.getByText('1,2|1|true|false')).toBeTruthy()
    await act(async () => {
      void next?.()
    })
    expect(screen.getByText('1,2|1|true|true')).toBeTruthy()
    await act(async () => {
      gates[1]?.resolve([1])
    })
    await flush()
    expect(screen.getByText('1,2,11|2|true|false')).toBeTruthy()
    await act(async () => {
      void next?.()
    })
    await act(async () => {
      gates[2]?.resolve([1])
    })
    await flush()
    expect(screen.getByText('1,2,11,21|3|false|false')).toBeTruthy()
  })

  test('a list that renders only flat does not re-render while a next page is in flight', async () => {
    const { root, gates } = feedRoot('fine/feed-flat')
    let renders = 0
    function Feed() {
      renders += 1
      const { flat } = useInfiniteQuery(root.api.feed)
      return <p>{flat.join(',') || 'empty'}</p>
    }
    render(<Feed />)
    await act(async () => {
      gates[0]?.resolve([1])
    })
    await flush()
    const settled = renders
    await act(async () => {
      void root.api.feed.fetchNextPage()
    })
    expect(root.api.feed.isFetchingNextPage.peek()).toBe(true)
    expect(renders).toBe(settled)
    await act(async () => {
      gates[1]?.resolve([1])
    })
    await flush()
    expect(screen.getByText('1,11')).toBeTruthy()
  })

  test('suspense waits for the first page', async () => {
    const { root, gates } = feedRoot('fine/feed-suspense')
    function Feed() {
      const { data } = useInfiniteQuery(root.api.feed, { suspense: true })
      return <p>{`pages:${data.length}`}</p>
    }
    render(
      <Suspense fallback={<p>loading</p>}>
        <Feed />
      </Suspense>,
    )
    expect(screen.getByText('loading')).toBeTruthy()
    await act(async () => {
      gates[0]?.resolve([1])
    })
    await flush()
    expect(screen.getByText('pages:1')).toBeTruthy()
  })
})

describe('useValue with an inline selector', () => {
  test('isEqual keeps the previous reference across a parent re-render', () => {
    const post = signal({ tags: ['a', 'b'], title: 't' })
    const seen: string[][] = []
    function Tags() {
      const [, setTick] = useState(0)
      const tags = useValue(post, {
        select: (p) => [...p.tags],
        isEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
      })
      seen.push(tags)
      return (
        <button type="button" onClick={() => setTick((n) => n + 1)}>
          {tags.join(',')}
        </button>
      )
    }
    render(<Tags />)
    act(() => {
      screen.getByText('a,b').click()
    })
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(1)
  })
})
