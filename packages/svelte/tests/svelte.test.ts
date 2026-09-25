/**
 * The Svelte adapter against real Svelte 5 components: the root context,
 * signals as `$store`s, a field bound with `bind:value`, and the store views
 * over queries, infinite queries, fields and mutations.
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
  type ReadSignal,
  type Root,
  required,
  signal,
} from '@kontsedal/olas-core'
import { type Component, flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, test } from 'vitest'
import { fieldStore, mutationStore, queryStore } from '../src'
import Counter from './fixtures/Counter.svelte'
import Feed from './fixtures/Feed.svelte'
import FieldMember from './fixtures/FieldMember.svelte'
import Harness from './fixtures/Harness.svelte'
import NameField from './fixtures/NameField.svelte'
import Orphan from './fixtures/Orphan.svelte'
import Save from './fixtures/Save.svelte'
import User from './fixtures/User.svelte'

const mounted: Array<Record<string, unknown>> = []
const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app)
  for (const root of roots.splice(0)) root.dispose()
  document.body.innerHTML = ''
})

function render(root: Root<unknown>, view: Component): HTMLElement {
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted.push(mount(Harness, { target, props: { root, view } }))
  return target
}

const keep = <R extends Root<unknown>>(root: R): R => {
  roots.push(root)
  return root
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  flushSync()
}

describe('setRoot, getRoot and signals as stores', () => {
  test('a component reads a signal as $store and follows its writes', async () => {
    const root = keep(
      createRoot(
        defineController(() => {
          const count = signal(1)
          return { count, inc: () => count.set(count.peek() + 1) }
        }),
        { deps: {} },
      ),
    )
    const el = render(root, Counter)
    expect(el.textContent).toBe('1')
    el.querySelector('button')?.click()
    flushSync()
    expect(el.textContent).toBe('2')
    root.api.count.set(10)
    flushSync()
    expect(el.textContent).toBe('10')
  })

  test('getRoot without setRoot throws a message naming the fix', () => {
    const target = document.createElement('div')
    expect(() => mount(Orphan, { target })).toThrow(/setRoot\(root\)/)
  })

  test('unmounting a component unsubscribes its stores', () => {
    const inner = signal(0)
    let live = 0
    const counted: ReadSignal<number> = {
      get value() {
        return inner.value
      },
      peek: () => inner.peek(),
      subscribe(handler) {
        live += 1
        const stop = inner.subscribe(handler)
        return () => {
          live -= 1
          stop()
        }
      },
      subscribeChanges: (handler) => inner.subscribeChanges(handler),
    }
    const root = keep(
      createRoot(
        defineController(() => ({ count: counted, inc() {} })),
        { deps: {} },
      ),
    )
    render(root, Counter)
    expect(live).toBe(1)
    for (const app of mounted.splice(0)) unmount(app)
    expect(live).toBe(0)
  })
})

describe('queryStore and infiniteQueryStore', () => {
  test('loading, then data, then a refetch from the component', async () => {
    let n = 0
    const user = defineQuery({ id: 'svelte/user', key: () => [], fetcher: async () => `v${++n}` })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ user: createQuery(ctx, user) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    const el = render(root, User)
    expect(el.querySelector('p')?.textContent).toBe('loading')
    await settle()
    expect(el.querySelector('p')?.textContent).toBe('v1')
    el.querySelector('button')?.click()
    await settle()
    expect(el.querySelector('p')?.textContent).toBe('v2')
  })

  test('an infinite query pages through one store', async () => {
    const feed = defineInfiniteQuery({
      id: 'svelte/feed',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => [pageParam],
      initialPageParam: 0,
      getNextPageParam: (_last: number[], all: number[][]) => (all.length < 3 ? all.length : null),
      itemsOf: (page: number[]) => page,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    const el = render(root, Feed)
    await settle()
    expect(el.querySelector('p')?.textContent).toBe('0|true|false')
    el.querySelector('button')?.click()
    flushSync()
    expect(el.querySelector('p')?.textContent).toBe('0|true|true')
    await settle()
    el.querySelector('button')?.click()
    await settle()
    expect(el.querySelector('p')?.textContent).toBe('0,1,2|false|false')
  })

  test('the query store hands back the subscription actions', async () => {
    let n = 0
    const q = defineQuery({ id: 'svelte/actions', key: () => [], fetcher: async () => ++n })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ q: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    const store = queryStore(root.api.q)
    await root.waitForIdle()
    expect(store.value.data).toBe(1)
    expect(store.peek().status).toBe('success')
    await expect(store.refetch()).resolves.toBe(2)
    const seen: Array<number | undefined> = []
    const stop = store.subscribeChanges((s) => seen.push(s.data))
    store.reset()
    store.cancel()
    await store.refetch()
    stop()
    expect(seen).toContain(3)
  })
})

describe('fields', () => {
  test('bind:value writes through field.set, and fieldStore follows validation', async () => {
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          name: createField<string>(ctx, '', { validators: [required('Required')] }),
        })),
        { deps: {} },
      ),
    )
    const el = render(root, NameField)
    const input = el.querySelector('input') as HTMLInputElement
    expect(el.querySelector('p')?.textContent).toBe('Required|false|false')
    input.value = 'Ada'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(root.api.name.value).toBe('Ada')
    expect(el.querySelector('p')?.textContent).toBe('|true|false')
    input.dispatchEvent(new Event('blur'))
    flushSync()
    expect(el.querySelector('p')?.textContent).toBe('|true|true')
    root.api.name.set('Grace')
    flushSync()
    expect(input.value).toBe('Grace')
  })

  test('bind:value on a fieldStore member writes the value, not the state object', async () => {
    const root = keep(
      createRoot(
        defineController((ctx) => ({ name: createField<string>(ctx, '') })),
        { deps: {} },
      ),
    )
    const el = render(root, FieldMember)
    const input = el.querySelector('input') as HTMLInputElement
    input.value = 'a'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    input.value = 'ab'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(root.api.name.value).toBe('ab')
    expect(el.querySelector('p')?.textContent).toBe('ab|true')
    root.api.name.set('Grace')
    flushSync()
    expect(input.value).toBe('Grace')
  })

  test('a member write leaves the store’s own state object untouched', () => {
    const root = keep(
      createRoot(
        defineController((ctx) => ({ name: createField<string>(ctx, 'a') })),
        { deps: {} },
      ),
    )
    const store = fieldStore(root.api.name)
    const cached = store.peek()
    let handed = cached
    const stop = store.subscribe((s) => {
      handed = s
    })
    // What Svelte does for `bind:value={$store.value}`: assign the member on
    // the value it was handed, then pass that value back to `set`.
    handed.value = 'b'
    expect(cached.value).toBe('a')
    store.set(handed as unknown as string)
    expect(root.api.name.peek()).toBe('b')
    expect(store.peek().value).toBe('b')
    // A plain value still goes straight to the field.
    store.set('c')
    expect(root.api.name.peek()).toBe('c')
    stop()
  })

  test('fieldStore actions reach the field', async () => {
    const root = keep(
      createRoot(
        defineController((ctx) => ({ name: createField<string>(ctx, 'a') })),
        {
          deps: {},
        },
      ),
    )
    const store = fieldStore(root.api.name)
    store.set('b')
    expect(store.value.value).toBe('b')
    expect(store.value.isDirty).toBe(true)
    store.setAsInitial('b')
    expect(store.value.isDirty).toBe(false)
    store.setErrors(['taken'])
    expect(store.value.errors).toEqual(['taken'])
    // Pinned errors stand until the next write, so the field is still invalid.
    await expect(store.revalidate()).resolves.toBe(false)
    store.set('c')
    store.reset()
    expect(store.value.value).toBe('b')
  })
})

describe('mutationStore', () => {
  const saving = () =>
    keep(
      createRoot(
        defineController((ctx) => ({
          save: createMutation(ctx, {
            mutate: async (v: number) => {
              if (v < 0) throw new Error('negative')
              return v * 2
            },
          }),
        })),
        { queries: queryEngine(), deps: {}, onError: () => {} },
      ),
    )

  test('mutate is fire-and-forget; a failure lands on the store, not as a rejection', async () => {
    const root = saving()
    const el = render(root, Save)
    const [ok, fail] = el.querySelectorAll('button')
    expect(el.querySelector('p')?.textContent).toBe('idle||false')
    ok?.click()
    await settle()
    expect(el.querySelector('p')?.textContent).toBe('success|42|false')
    fail?.click() // rejects inside; must not surface as an unhandled rejection
    await settle()
    // A failed run keeps the last success's data; only `error` and `status` move.
    expect(el.querySelector('p')?.textContent).toBe('error|42|false')
  })

  test('run returns the promise, and reset clears the state', async () => {
    const root = saving()
    const store = mutationStore(root.api.save)
    await expect(store.run(2)).resolves.toBe(4)
    await expect(store.run(-1)).rejects.toThrow('negative')
    expect(store.value.status).toBe('error')
    store.reset()
    expect(store.value.status).toBe('idle')
    expect(store.value.data).toBeUndefined()
  })
})
