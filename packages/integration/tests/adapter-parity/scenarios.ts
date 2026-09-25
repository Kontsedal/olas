/**
 * One controller tree per scenario, one set of DOM assertions, and a
 * `Harness` per framework adapter. Every adapter renders the same markup for a
 * scenario (the views live next to each harness), so `runParity` can drive
 * any of them with the same clicks and keystrokes and expect the same text.
 *
 * What a pass shows: each adapter reads the same signals, re-renders on the
 * same writes, passes the same actions through, and lets go of its
 * subscriptions on unmount. What it does not show: that the adapters render
 * equally fast, or that the markup is idiomatic for each framework.
 */
import {
  createField,
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  type Field,
  type InfiniteQuerySubscription,
  type Mutation,
  type QuerySubscription,
  queryEngine,
  type ReadSignal,
  type Root,
  required,
  signal,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test } from 'vitest'

export type CounterApi = { count: ReadSignal<number>; inc: () => void }
export type UserApi = { user: QuerySubscription<string> }
export type NameApi = { name: Field<string> }
export type SaveApi = { save: Mutation<number, number> }
export type FeedApi = { feed: InfiniteQuerySubscription<number[], number> }
export type User = { id: number; name: string }
export type EqualApi = { user: ReadSignal<User>; tick: ReadSignal<number> }

/** The `isEqual` the `equal` view reads `user` with: one user per id. */
export const sameId = (a: User, b: User): boolean => a.id === b.id

/** The scenarios, by the view each harness renders for them. */
export type ViewName = 'counter' | 'user' | 'name' | 'save' | 'feed' | 'equal'

/**
 * What a framework adapter provides. `mount` renders the named view under a
 * provider for `root` and returns the container. `settle` lets the framework
 * flush whatever it scheduled. `lacks` names the views whose API the adapter
 * does not have, and their scenarios are skipped for it.
 */
export type Harness = {
  name: string
  mount(view: ViewName, root: Root<unknown>): HTMLElement
  unmount(): void
  settle(): Promise<void>
  lacks?: readonly ViewName[]
}

/** A signal that counts its live subscriptions, of both kinds. */
function countedSignal(initial: number) {
  const inner = signal(initial)
  let live = 0
  const track = (stop: () => void) => {
    live += 1
    return () => {
      live -= 1
      stop()
    }
  }
  const counted: ReadSignal<number> & { set(v: number): void } = {
    get value() {
      return inner.value
    },
    peek: () => inner.peek(),
    subscribe: (handler) => track(inner.subscribe(handler)),
    subscribeChanges: (handler) => track(inner.subscribeChanges(handler)),
    set: (v) => inner.set(v),
  }
  return { counted, live: () => live }
}

const counterRoot = () => {
  const { counted, live } = countedSignal(1)
  const root = createRoot(
    defineController(
      (): CounterApi => ({ count: counted, inc: () => counted.set(counted.peek() + 1) }),
    ),
    { deps: {} },
  )
  return { root, live, counted }
}

const userQuery = (id: string) => {
  let n = 0
  return defineQuery({ id, key: () => [], fetcher: async () => `v${++n}` })
}

const feedQuery = (id: string) =>
  defineInfiniteQuery({
    id,
    key: () => [],
    fetcher: async ({ pageParam }: { pageParam: number }) => [pageParam],
    initialPageParam: 0,
    getNextPageParam: (_last: number[], all: number[][]) => (all.length < 3 ? all.length : null),
    itemsOf: (page: number[]) => page,
  })

const text = (el: HTMLElement, id: string): string | null =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent ?? null

const click = (el: HTMLElement, id: string): void => {
  ;(el.querySelector(`[data-testid="${id}"]`) as HTMLElement).click()
}

/**
 * Type into an input the way a user does. The native setter runs first, so a
 * framework that tracks the input's value (React) sees a real change.
 */
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Leave an input. React listens for `focusout`; Vue and Svelte for `blur`. */
const leave = (input: HTMLInputElement): void => {
  input.dispatchEvent(new Event('blur'))
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

export function runParity(harness: Harness): void {
  const roots: Array<{ dispose(): void }> = []
  const keep = <R extends { dispose(): void }>(root: R): R => {
    roots.push(root)
    return root
  }
  afterEach(() => {
    harness.unmount()
    for (const root of roots.splice(0)) root.dispose()
  })
  const id = (name: string) => `parity/${harness.name}/${name}`

  describe(`adapter parity: ${harness.name}`, () => {
    test('a signal renders, a click writes through the api, and a write re-renders', async () => {
      const { root, counted } = counterRoot()
      keep(root)
      const el = harness.mount('counter', root)
      expect(text(el, 'count')).toBe('1')
      click(el, 'count')
      await harness.settle()
      expect(text(el, 'count')).toBe('2')
      counted.set(10)
      await harness.settle()
      expect(text(el, 'count')).toBe('10')
    })

    test('unmounting lets go of every subscription', async () => {
      const { root, live } = counterRoot()
      keep(root)
      harness.mount('counter', root)
      await harness.settle()
      expect(live()).toBeGreaterThan(0)
      harness.unmount()
      await harness.settle()
      expect(live()).toBe(0)
    })

    test('a query shows loading, then data, then refetches from the view', async () => {
      const q = userQuery(id('user'))
      const root = keep(
        createRoot(
          defineController((ctx): UserApi => ({ user: createQuery(ctx, q) })),
          {
            queries: queryEngine(),
            deps: {},
          },
        ),
      )
      const el = harness.mount('user', root)
      expect(text(el, 'user')).toBe('loading')
      await root.waitForIdle()
      await harness.settle()
      expect(text(el, 'user')).toBe('v1')
      click(el, 'refetch')
      await root.waitForIdle()
      await harness.settle()
      expect(text(el, 'user')).toBe('v2')
    })

    test('an infinite query pages from the view', async () => {
      const feed = feedQuery(id('feed'))
      const root = keep(
        createRoot(
          defineController((ctx): FeedApi => ({ feed: createQuery(ctx, feed) })),
          {
            queries: queryEngine(),
            deps: {},
          },
        ),
      )
      const el = harness.mount('feed', root)
      await root.waitForIdle()
      await harness.settle()
      expect(text(el, 'feed')).toBe('0|true')
      click(el, 'more')
      await root.waitForIdle()
      await harness.settle()
      click(el, 'more')
      await root.waitForIdle()
      await harness.settle()
      expect(text(el, 'feed')).toBe('0,1,2|false')
    })

    test('typing writes the field, validation follows, and leaving touches it', async () => {
      const root = keep(
        createRoot(
          defineController(
            (ctx): NameApi => ({
              name: createField<string>(ctx, '', { validators: [required('Required')] }),
            }),
          ),
          { deps: {} },
        ),
      )
      const el = harness.mount('name', root)
      const input = el.querySelector('[data-testid="input"]') as HTMLInputElement
      expect(text(el, 'state')).toBe('Required|false|false')
      type(input, 'Ada')
      await harness.settle()
      expect(root.api.name.value).toBe('Ada')
      expect(text(el, 'state')).toBe('|true|false')
      leave(input)
      await harness.settle()
      expect(text(el, 'state')).toBe('|true|true')
      root.api.name.set('Grace')
      await harness.settle()
      expect(input.value).toBe('Grace')
    })

    // Svelte reads a signal as a store and has no `isEqual` option to compare.
    test.skipIf(harness.lacks?.includes('equal') === true)(
      'a value isEqual calls equal keeps the one shown when the view re-renders for another reason',
      async () => {
        const user = signal<User>({ id: 1, name: 'A' })
        const tick = signal(0)
        const root = keep(
          createRoot(
            defineController((): EqualApi => ({ user, tick })),
            { deps: {} },
          ),
        )
        const el = harness.mount('equal', root)
        expect(text(el, 'equal')).toBe('A:0')
        user.set({ id: 1, name: 'B' })
        await harness.settle()
        expect(text(el, 'equal')).toBe('A:0')
        // An unrelated write re-renders the view, which still shows A.
        tick.set(1)
        await harness.settle()
        expect(text(el, 'equal')).toBe('A:1')
        user.set({ id: 2, name: 'C' })
        await harness.settle()
        expect(text(el, 'equal')).toBe('C:1')
      },
    )

    test('mutate is fire-and-forget: success and failure both land on the view', async () => {
      const root = keep(
        createRoot(
          defineController(
            (ctx): SaveApi => ({
              save: createMutation(ctx, {
                mutate: async (v: number) => {
                  if (v < 0) throw new Error('negative')
                  return v * 2
                },
              }),
            }),
          ),
          { queries: queryEngine(), deps: {}, onError: () => {} },
        ),
      )
      const el = harness.mount('save', root)
      expect(text(el, 'save')).toBe('idle|')
      click(el, 'ok')
      await root.waitForIdle()
      await harness.settle()
      expect(text(el, 'save')).toBe('success|42')
      // Rejects inside the adapter; an unhandled rejection would fail the run.
      click(el, 'fail')
      await root.waitForIdle()
      await harness.settle()
      expect(text(el, 'save')).toBe('error|42')
    })
  })
}
