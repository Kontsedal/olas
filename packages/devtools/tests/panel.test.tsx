// @vitest-environment jsdom

import { createRoot, defineController, defineQuery, signal } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'

const raf = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

afterEach(() => {
  cleanup()
})

describe('<DevtoolsPanel>', () => {
  test('tree shows the pre-existing controller snapshot on mount + dynamic children appear post-mount', async () => {
    // The bus replays the live-controller snapshot to new subscribers, so the
    // root constructed before mount IS visible immediately. Dynamic children
    // added after mount also appear.
    const leaf = defineController(() => ({}), { name: 'leaf' })
    const def = defineController(
      (ctx) => ({
        addLeaf: () => ctx.child(leaf, undefined),
      }),
      { name: 'app' },
    )
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="tree" />)
    // The root (path = ['root']) is already in the tree.
    expect(screen.getByRole('tabpanel').textContent).toContain('root')

    await act(async () => {
      root.addLeaf()
    })
    const treePanel = await screen.findByRole('tabpanel')
    expect(treePanel.textContent).toMatch(/leaf/)

    root.dispose()
  })

  test('renders cache events as they arrive', async () => {
    const usersQuery = defineQuery({
      key: () => [],
      fetcher: async () => 'data',
    })
    const def = defineController((ctx) => ({ users: ctx.use(usersQuery) }))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="cache" />)

    // The initial fetch fired before the panel subscribed, so trigger a fresh
    // cycle to exercise the live-event path.
    await act(async () => {
      await root.users.refetch()
    })

    // Panel uses rAF-coalesced writes — wait one frame for the pending
    // events to land in the displayed log.
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve())
        }),
    )

    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toContain('fetch-start')
    expect(panel.textContent).toContain('fetch-success')

    root.dispose()
  })

  test('Clear button empties the cache log', async () => {
    const q = defineQuery({ key: () => [], fetcher: async () => 'x' })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="cache" />)

    await act(async () => {
      await root.x.refetch()
    })
    // Panel coalesces via rAF — wait one frame so the pending events land.
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve())
        }),
    )
    expect(screen.getByRole('tabpanel').textContent).toContain('fetch-success')

    act(() => {
      fireEvent.click(screen.getByText('Clear'))
    })
    expect(screen.getByRole('tabpanel').textContent).toContain('No cache events yet')

    root.dispose()
  })

  test('tabs switch the rendered view', () => {
    const def = defineController(() => ({ value: signal(0) }))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} />)
    // Timeline is the default tab (the headline view).
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')

    act(() => {
      fireEvent.click(screen.getByRole('tab', { name: 'Mutations' }))
    })
    expect(screen.getByRole('tab', { name: 'Mutations' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('tabpanel').textContent).toContain('No mutations yet')

    act(() => {
      fireEvent.click(screen.getByRole('tab', { name: 'Fields' }))
    })
    expect(screen.getByRole('tabpanel').textContent).toContain('No field validations yet')

    // The Tree tab is populated via the snapshot replay — the root is
    // already visible without waiting for the next event.
    act(() => {
      fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    })
    expect(screen.getByRole('tabpanel').textContent).toContain('root')

    root.dispose()
  })

  test('suspended controllers show their state in the tree', () => {
    // Construct a dynamic child after mount, then suspend/resume the root to
    // exercise the tree state transitions. The post-mount path is the
    // production case — see the test above for why.
    const leaf = defineController(() => ({}))
    const def = defineController((ctx) => ({
      addLeaf: () => ctx.child(leaf, undefined),
    }))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="tree" />)
    act(() => {
      root.addLeaf()
    })
    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toMatch(/active/)

    act(() => root.suspend())
    expect(panel.textContent).toContain('suspended')

    act(() => root.resume())
    expect(panel.textContent).toContain('active')

    root.dispose()
  })

  test('the filter input is debounced before it filters the view — T6.3', async () => {
    const q = defineQuery({ key: () => [], fetcher: async () => 'x' })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="cache" />)
    await act(async () => {
      await root.x.refetch()
    })
    await raf()
    expect(screen.getByRole('tabpanel').textContent).toContain('fetch-success')

    // Type a non-matching filter. WITHOUT the debounce this filters instantly
    // (JSON.stringify per entry per keystroke); WITH it, the view still shows
    // the entry until the debounce window elapses.
    act(() => {
      fireEvent.change(screen.getByPlaceholderText(/Filter cache/i), {
        target: { value: 'zzz-no-match' },
      })
    })
    expect(screen.getByRole('tabpanel').textContent).toContain('fetch-success')

    await wait(200) // past the debounce
    expect(screen.getByRole('tabpanel').textContent).toContain('No matches')

    root.dispose()
  })

  test('respects defaultTab prop', () => {
    const def = defineController(() => ({}))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="fields" />)
    expect(screen.getByRole('tab', { name: 'Fields' }).getAttribute('aria-selected')).toBe('true')

    root.dispose()
  })

  test('timeline groups a failing mutation + its optimistic write + rollback as one cause-chain', async () => {
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_c, id) => `server-${id}`,
    })
    const def = defineController((ctx) => ({
      cur: ctx.use(q, () => ['1']),
      save: ctx.mutation({
        name: 'save',
        mutate: async () => {
          throw new Error('boom')
        },
        onMutate: () => q.setData('1', () => 'optimistic'),
        retry: 0,
      }),
    }))
    const root = createRoot(def, { deps: {}, onError: () => {} })
    await act(async () => {
      await root.cur.firstValue()
    })

    render(<DevtoolsPanel root={root} />) // Timeline is the default tab

    await act(async () => {
      await root.save.run(undefined as void).catch(() => undefined)
    })
    await raf()

    const panel = screen.getByRole('tabpanel')
    // The whole chain groups under one header titled by the mutation name.
    expect(panel.textContent).toContain('save')
    // Optimistic write + its rollback are visible in the chain.
    expect(panel.textContent).toContain('set-data')
    expect(panel.textContent).toContain('rollback')

    root.dispose()
  })

  test('a cache:set-data row expands to a structural before/after diff', async () => {
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_c, _id) => ({ name: 'Ada', age: 36 }),
    })
    const def = defineController((ctx) => ({
      cur: ctx.use(q, () => ['1']),
      bump: ctx.mutation({
        name: 'bump',
        mutate: async () => 'ok',
        onMutate: () =>
          q.setData('1', (p) => ({ ...(p as { name: string; age: number }), age: 37 })),
      }),
    }))
    const root = createRoot(def, { deps: {} })
    await act(async () => {
      await root.cur.firstValue()
    })

    render(<DevtoolsPanel root={root} />)
    await act(async () => {
      await root.bump.run(undefined as void)
    })
    await raf()

    // Expand the optimistic set-data row.
    act(() => {
      fireEvent.click(screen.getAllByText('set-data')[0]!)
    })
    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toContain('age') // changed key
    expect(panel.textContent).toContain('37') // new value
    expect(panel.textContent).toContain('unchanged') // name collapsed as unchanged

    root.dispose()
  })

  test('Tree shows ctx.debug variables and updates them reactively', async () => {
    const count = signal(0)
    const def = defineController((ctx) => {
      ctx.debug({ count })
      return { inc: () => count.set(count.peek() + 1) }
    })
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="tree" />)
    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toContain('count') // variable name
    expect(panel.textContent).toContain('0') // live value

    await act(async () => {
      root.inc()
    })
    expect(panel.textContent).toContain('1') // updated reactively — no poll

    root.dispose()
  })

  test('the cache inspector updates from events (no poll)', async () => {
    const q = defineQuery({ key: (id: string) => [id], fetcher: async (_c, id) => `data-${id}` })
    const def = defineController((ctx) => ({ x: ctx.use(q, () => ['u1']) }))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="inspector" />)
    await act(async () => {
      await root.x.refetch()
    })
    await raf()

    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toContain('u1') // query key shown
    expect(panel.textContent).toContain('success') // event-driven status update

    root.dispose()
  })
})
