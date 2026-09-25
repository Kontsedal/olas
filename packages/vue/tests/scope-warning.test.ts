// @vitest-environment jsdom
// The development warning for a hook called outside an effect scope. It has a
// file of its own: the once-per-hook memory is module state, and each vitest
// file gets a fresh copy of the module.
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
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest'
import { createApp, defineComponent, effectScope, h } from 'vue'
import { useField, useInfiniteQuery, useMutation, useQuery, useValue } from '../src'

const q = defineQuery({ id: 'vue-scope/q', key: () => [], fetcher: async () => 1 })
const feed = defineInfiniteQuery({
  id: 'vue-scope/feed',
  key: () => [],
  fetcher: async ({ pageParam }: { pageParam: number }) => [pageParam],
  initialPageParam: 0,
  getNextPageParam: () => null,
})

const build = () =>
  createRoot(
    defineController((ctx) => ({
      count: signal(0),
      q: createQuery(ctx, q),
      feed: createQuery(ctx, feed),
      name: createField<string>(ctx, 'a'),
      save: createMutation(ctx, { mutate: async (v: number) => v }),
    })),
    { queries: queryEngine(), deps: {} },
  )

type Api = ReturnType<typeof build>['api']

/** Every hook, once each, in the order the warnings are expected. */
const callAll = (api: Api) => {
  useValue(api.count)
  useQuery(api.q)
  useInfiniteQuery(api.feed)
  useField(api.name)
  useMutation(api.save)
}

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

const warnings = (): string[] => warn.mock.calls.map((args) => String(args[0]))

describe('a hook outside an effect scope (development build)', () => {
  // Runs first: a call inside a scope must not use up a hook's one warning.
  test('inside a component setup or an effectScope, nothing warns', () => {
    const root = build()
    const scope = effectScope()
    scope.run(() => callAll(root.api))
    scope.stop()

    const el = document.createElement('div')
    const app = createApp(
      defineComponent({
        setup() {
          callAll(root.api)
          return () => h('p')
        },
      }),
    )
    app.mount(el)
    app.unmount()

    expect(warn).not.toHaveBeenCalled()
    root.dispose()
  })

  test('each hook warns once, under its own name, and names the leak', () => {
    const root = build()
    callAll(root.api)

    // One warning per hook. `useQuery` builds on `useValue` and
    // `useInfiniteQuery` on `useQuery`, and neither warns under the inner name.
    const messages = warnings()
    expect(messages.map((m) => /\[olas\] (\w+)\(\)/.exec(m)?.[1])).toEqual([
      'useValue',
      'useQuery',
      'useInfiniteQuery',
      'useField',
      'useMutation',
    ])
    for (const message of messages) {
      expect(message).toContain('outside a Vue effect scope')
      expect(message).toContain('nothing will unsubscribe it')
      expect(message).toContain('effectScope().run()')
    }

    // A second round warns no more.
    callAll(root.api)
    expect(warn).toHaveBeenCalledTimes(5)
    root.dispose()
  })

  test('outside a scope the ref still follows its signal', () => {
    const count = signal(1)
    const ref = useValue(count)
    count.set(2)
    expect(ref.value).toBe(2)
    // `useValue` already warned in the previous test.
    expect(warn).not.toHaveBeenCalled()
  })
})
