// @vitest-environment jsdom

import { createRoot, defineController, defineQuery, signal } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'

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

    render(<DevtoolsPanel root={root} />)
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
    // start on tree tab
    expect(screen.getByRole('tab', { name: 'Tree' }).getAttribute('aria-selected')).toBe('true')

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

    render(<DevtoolsPanel root={root} />)
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

  test('respects defaultTab prop', () => {
    const def = defineController(() => ({}))
    const root = createRoot(def, { deps: {} })

    render(<DevtoolsPanel root={root} defaultTab="fields" />)
    expect(screen.getByRole('tab', { name: 'Fields' }).getAttribute('aria-selected')).toBe('true')

    root.dispose()
  })
})
