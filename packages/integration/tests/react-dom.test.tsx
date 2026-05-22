// @vitest-environment jsdom

/**
 * Scenario: a real "card list" component, with React + JSDOM driving:
 *   - useQuery — re-renders when the cache changes
 *   - useMutation — pending / success / error states
 *   - useField — controlled input round-trip
 *   - Suspense fallback via useSuspenseQuery — pending → resolved
 *
 * Uses the same shape the kanban example uses internally, so a
 * regression here is also a regression in the example app.
 */

import { createRoot, defineController, defineQuery } from '@kontsedal/olas-core'
import {
  OlasProvider,
  useField,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from '@kontsedal/olas-react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, describe, expect, test } from 'vitest'

afterEach(() => {
  cleanup()
})

type Card = { id: string; title: string; likes: number }

const seedCards = (): Card[] => [
  { id: 'c1', title: 'First', likes: 0 },
  { id: 'c2', title: 'Second', likes: 0 },
]

describe('react integration: card list', () => {
  test('useQuery re-renders when a mutation succeeds and writes to the cache', async () => {
    const cardsQuery = defineQuery({
      queryId: 'int/react/cards-mutate',
      key: () => [],
      fetcher: async () => seedCards(),
      staleTime: 60_000,
    })

    const def = defineController((ctx) => {
      const cards = ctx.use(cardsQuery, () => [])
      const like = ctx.mutation<string, void>({
        mutate: async (id) => {
          cardsQuery.setData(() => {
            const prev = cards.data.peek() ?? []
            return prev.map((c) => (c.id === id ? { ...c, likes: c.likes + 1 } : c))
          })
        },
      })
      return { cards, like }
    })

    const root = createRoot(def, { deps: {} })

    function CardList() {
      const { data, isLoading } = useQuery(root.cards)
      const m = useMutation(root.like)
      if (isLoading) return <div data-testid="status">loading</div>
      return (
        <div>
          <ul>
            {(data ?? []).map((c) => (
              <li key={c.id} data-testid={`card-${c.id}`}>
                {c.title}: {c.likes}
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="like-c1"
            onClick={() => {
              void m.mutate('c1')
            }}
          >
            Like c1
          </button>
          <span data-testid="pending">{m.isPending ? 'yes' : 'no'}</span>
        </div>
      )
    }

    render(
      <OlasProvider root={root}>
        <CardList />
      </OlasProvider>,
    )

    // Initial: query is loading.
    await waitFor(() => expect(screen.getByTestId('card-c1').textContent).toBe('First: 0'))
    expect(screen.getByTestId('card-c2').textContent).toBe('Second: 0')

    await act(async () => {
      fireEvent.click(screen.getByTestId('like-c1'))
    })
    expect(screen.getByTestId('card-c1').textContent).toBe('First: 1')
    expect(screen.getByTestId('card-c2').textContent).toBe('Second: 0')
    expect(screen.getByTestId('pending').textContent).toBe('no')

    root.dispose()
  })

  test('useSuspenseQuery shows the fallback then resolves', async () => {
    let resolveFetch: ((v: { who: string }) => void) | null = null
    const slowQuery = defineQuery({
      queryId: 'int/react/slow',
      key: () => [],
      fetcher: () =>
        new Promise<{ who: string }>((r) => {
          resolveFetch = r
        }),
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({ slow: ctx.use(slowQuery, () => []) }))
    const root = createRoot(def, { deps: {} })

    function SlowView() {
      const { data } = useSuspenseQuery(root.slow)
      return <span data-testid="who">{data.who}</span>
    }

    render(
      <OlasProvider root={root}>
        <Suspense fallback={<span data-testid="fallback">loading…</span>}>
          <SlowView />
        </Suspense>
      </OlasProvider>,
    )

    expect(screen.getByTestId('fallback').textContent).toBe('loading…')

    await act(async () => {
      resolveFetch?.({ who: 'world' })
      await root.slow.firstValue()
    })
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('who').textContent).toBe('world')

    root.dispose()
  })

  test('useField round-trip with a controlled <input>', async () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>(''),
    }))
    const root = createRoot(def, { deps: {} })

    function NameInput() {
      const { value, set, isDirty } = useField(root.name)
      return (
        <div>
          <input data-testid="name" value={value} onChange={(e) => set(e.target.value)} />
          <span data-testid="dirty">{isDirty ? 'yes' : 'no'}</span>
        </div>
      )
    }

    render(
      <OlasProvider root={root}>
        <NameInput />
      </OlasProvider>,
    )

    expect(screen.getByTestId('dirty').textContent).toBe('no')
    await act(async () => {
      fireEvent.change(screen.getByTestId('name'), { target: { value: 'Alice' } })
    })
    expect((screen.getByTestId('name') as HTMLInputElement).value).toBe('Alice')
    expect(screen.getByTestId('dirty').textContent).toBe('yes')
    expect(root.name.peek()).toBe('Alice')

    root.dispose()
  })

  test('useMutation surfaces error state from a failing mutate', async () => {
    const def = defineController((ctx) => ({
      save: ctx.mutation<void, void>({
        mutate: async () => {
          throw new Error('boom')
        },
      }),
    }))
    const root = createRoot(def, { deps: {}, onError: () => {} })

    function SaveButton() {
      const m = useMutation(root.save)
      return (
        <div>
          <button
            type="button"
            data-testid="save"
            onClick={() => {
              m.mutate().catch(() => {})
            }}
          >
            Save
          </button>
          <span data-testid="err">{m.isError ? (m.error as Error).message : 'none'}</span>
        </div>
      )
    }

    render(
      <OlasProvider root={root}>
        <SaveButton />
      </OlasProvider>,
    )

    expect(screen.getByTestId('err').textContent).toBe('none')
    await act(async () => {
      fireEvent.click(screen.getByTestId('save'))
    })
    await waitFor(() => expect(screen.getByTestId('err').textContent).toBe('boom'))

    root.dispose()
  })
})
