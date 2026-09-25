// @vitest-environment jsdom

import { createRoot, defineController, queryEngine, type ReadSignal } from '@kontsedal/olas-core'
import { act, cleanup, render } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { createRouterAdapter, RouteParamsScope, RoutePathnameScope, RouteSearchScope } from '../src'

afterEach(() => {
  cleanup()
})

describe('createRouterAdapter — scope wiring', () => {
  test('exposes route params via ctx.inject after the Bridge mounts', async () => {
    const adapter = createRouterAdapter()

    let injected: ReadSignal<Record<string, string | undefined>> | undefined
    const def = defineController((ctx) => {
      injected = ctx.inject(RouteParamsScope)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [adapter.plugin] })

    // Render the bridge with initial params; the Bridge useEffect pushes
    // them into the underlying signal.
    render(<adapter.Bridge params={{ userId: '42' }} />)
    await act(async () => {
      /* let the effect flush */
    })

    expect(injected?.value).toEqual({ userId: '42' })
    root.dispose()
  })

  test('params updates re-publish to the scope signal', async () => {
    const adapter = createRouterAdapter()

    let injected: ReadSignal<Record<string, string | undefined>> | undefined
    const def = defineController((ctx) => {
      injected = ctx.inject(RouteParamsScope)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [adapter.plugin] })

    function Host(): ReactNode {
      const [id, setId] = useState('a')
      return (
        <>
          <button type="button" data-testid="next" onClick={() => setId('b')}>
            next
          </button>
          <adapter.Bridge params={{ id }} />
        </>
      )
    }

    const { getByTestId } = render(<Host />)
    await act(async () => {})
    expect(injected?.value).toEqual({ id: 'a' })

    await act(async () => {
      getByTestId('next').click()
    })
    expect(injected?.value).toEqual({ id: 'b' })

    root.dispose()
  })

  test('search and pathname are wired through the same Bridge', async () => {
    const adapter = createRouterAdapter()

    let params: ReadSignal<Record<string, string | undefined>> | undefined
    let search: ReadSignal<Record<string, unknown>> | undefined
    let pathname: ReadSignal<string> | undefined
    const def = defineController((ctx) => {
      params = ctx.inject(RouteParamsScope)
      search = ctx.inject(RouteSearchScope)
      pathname = ctx.inject(RoutePathnameScope)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [adapter.plugin] })

    render(
      <adapter.Bridge
        params={{ tab: 'profile' }}
        search={{ q: 'foo', sort: 'desc' }}
        pathname="/users/42/profile"
      />,
    )
    await act(async () => {})

    expect(params?.value).toEqual({ tab: 'profile' })
    expect(search?.value).toEqual({ q: 'foo', sort: 'desc' })
    expect(pathname?.value).toBe('/users/42/profile')

    root.dispose()
  })

  test('shallow-equal short-circuits avoid spurious signal writes', async () => {
    const adapter = createRouterAdapter()
    const def = defineController((ctx) => ({
      params: ctx.inject(RouteParamsScope),
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [adapter.plugin],
    })

    let fires = 0
    const unsub = root.api.params.subscribe(() => fires++)
    fires = 0 // subscribe fires synchronously with the current value; reset.

    // Render the bridge with a fresh object literal on every "navigation"
    // but with structurally identical content. Shallow-equal should
    // dedupe and avoid writing the signal a second time.
    const { rerender } = render(<adapter.Bridge params={{ id: 'a' }} />)
    await act(async () => {})
    rerender(<adapter.Bridge params={{ id: 'a' }} />)
    await act(async () => {})

    expect(fires).toBe(1)

    // Genuine change should write through.
    rerender(<adapter.Bridge params={{ id: 'b' }} />)
    await act(async () => {})
    expect(fires).toBe(2)

    unsub()
    root.dispose()
  })

  test('separate adapter instances are isolated (own signal stores)', async () => {
    const a = createRouterAdapter()
    const b = createRouterAdapter()

    let aSeen: ReadSignal<Record<string, string | undefined>> | undefined
    let bSeen: ReadSignal<Record<string, string | undefined>> | undefined

    const defA = defineController((ctx) => {
      aSeen = ctx.inject(RouteParamsScope)
      return {}
    })
    const defB = defineController((ctx) => {
      bSeen = ctx.inject(RouteParamsScope)
      return {}
    })
    const rootA = createRoot(defA, { queries: queryEngine(), deps: {}, plugins: [a.plugin] })
    const rootB = createRoot(defB, { queries: queryEngine(), deps: {}, plugins: [b.plugin] })

    render(
      <>
        <a.Bridge params={{ tag: 'A' }} />
        <b.Bridge params={{ tag: 'B' }} />
      </>,
    )
    await act(async () => {})

    expect(aSeen?.value).toEqual({ tag: 'A' })
    expect(bSeen?.value).toEqual({ tag: 'B' })

    rootA.dispose()
    rootB.dispose()
  })

  test('seeded initial state is visible on first render, no Bridge/effect (SSR)', () => {
    // The server never runs effects, so route scopes must be populated at
    // adapter-construction time. Seed via createRouterAdapter(initial) and
    // read WITHOUT rendering the Bridge — exactly the server-render path.
    const adapter = createRouterAdapter({
      params: { userId: '42' },
      search: { q: 'x' },
      pathname: '/users/42',
    })
    let params: ReadSignal<Record<string, string | undefined>> | undefined
    let search: ReadSignal<Record<string, unknown>> | undefined
    let pathname: ReadSignal<string> | undefined
    const def = defineController((ctx) => {
      params = ctx.inject(RouteParamsScope)
      search = ctx.inject(RouteSearchScope)
      pathname = ctx.inject(RoutePathnameScope)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [adapter.plugin] })
    expect(params?.value).toEqual({ userId: '42' })
    expect(search?.value).toEqual({ q: 'x' })
    expect(pathname?.value).toBe('/users/42')
    root.dispose()
  })

  test('params tolerate undefined values (React Router optional segments)', async () => {
    const adapter = createRouterAdapter()
    let params: ReadSignal<Record<string, string | undefined>> | undefined
    const def = defineController((ctx) => {
      params = ctx.inject(RouteParamsScope)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [adapter.plugin] })
    // `optional` is absent from the URL → undefined, not a string. The widened
    // `Record<string, string | undefined>` type accepts it (typecheck), and it
    // round-trips at runtime.
    render(<adapter.Bridge params={{ id: '1', optional: undefined }} />)
    await act(async () => {})
    expect(params?.value).toEqual({ id: '1', optional: undefined })
    root.dispose()
  })

  test('Bridge with no search/pathname props uses empty defaults', async () => {
    const adapter = createRouterAdapter()
    const def = defineController((ctx) => ({
      search: ctx.inject(RouteSearchScope),
      pathname: ctx.inject(RoutePathnameScope),
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [adapter.plugin],
    })

    render(<adapter.Bridge params={{}} />)
    await act(async () => {})

    expect(root.api.search.value).toEqual({})
    expect(root.api.pathname.value).toBe('')

    root.dispose()
  })
})
