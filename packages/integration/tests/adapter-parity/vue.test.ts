// @vitest-environment jsdom
// The parity views for `@kontsedal/olas-vue`, as render functions so the file
// needs no SFC compiler.
import type { Root } from '@kontsedal/olas-core'
import {
  olasPlugin,
  useField,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useRoot,
  useValue,
} from '@kontsedal/olas-vue'
import { type App, type Component, createApp, defineComponent, h, nextTick } from 'vue'
import {
  type CounterApi,
  type EqualApi,
  type FeedApi,
  type NameApi,
  runParity,
  type SaveApi,
  sameId,
  type UserApi,
  type ViewName,
} from './scenarios'

const Counter = defineComponent(() => {
  const api = useRoot<CounterApi>()
  const count = useValue(api.count)
  return () =>
    h('button', { type: 'button', 'data-testid': 'count', onClick: api.inc }, count.value)
})

const User = defineComponent(() => {
  const { user } = useRoot<UserApi>()
  const { data, isLoading, refetch } = useQuery(user)
  return () => [
    h('p', { 'data-testid': 'user' }, isLoading.value ? 'loading' : (data.value ?? '')),
    h(
      'button',
      { type: 'button', 'data-testid': 'refetch', onClick: () => void refetch() },
      'refetch',
    ),
  ]
})

const Feed = defineComponent(() => {
  const { feed } = useRoot<FeedApi>()
  const { flat, hasNextPage, fetchNextPage } = useInfiniteQuery(feed)
  return () => [
    h('p', { 'data-testid': 'feed' }, `${flat.value.join(',')}|${hasNextPage.value}`),
    h(
      'button',
      { type: 'button', 'data-testid': 'more', onClick: () => void fetchNextPage() },
      'more',
    ),
  ]
})

const Name = defineComponent(() => {
  const { name } = useRoot<NameApi>()
  const { value, errors, isDirty, touched, markTouched } = useField(name)
  // What `v-model="value"` compiles to on a text input.
  return () => [
    h('input', {
      'data-testid': 'input',
      value: value.value,
      onInput: (e: Event) => {
        value.value = (e.target as HTMLInputElement).value
      },
      onBlur: markTouched,
    }),
    h(
      'p',
      { 'data-testid': 'state' },
      `${errors.value.join(',')}|${isDirty.value}|${touched.value}`,
    ),
  ]
})

const Save = defineComponent(() => {
  const { save } = useRoot<SaveApi>()
  const { mutate, status, data } = useMutation(save)
  return () => [
    h('p', { 'data-testid': 'save' }, `${status.value}|${data.value ?? ''}`),
    h('button', { type: 'button', 'data-testid': 'ok', onClick: () => mutate(21) }, 'ok'),
    h('button', { type: 'button', 'data-testid': 'fail', onClick: () => mutate(-1) }, 'fail'),
  ]
})

const Equal = defineComponent(() => {
  const { user, tick } = useRoot<EqualApi>()
  const u = useValue(user, { isEqual: sameId })
  const t = useValue(tick)
  return () => h('p', { 'data-testid': 'equal' }, `${u.value.name}:${t.value}`)
})

const VIEWS: Record<ViewName, Component> = {
  counter: Counter,
  user: User,
  feed: Feed,
  name: Name,
  save: Save,
  equal: Equal,
}

let app: App | undefined
let container: HTMLElement | undefined

runParity({
  name: 'vue',
  mount(view: ViewName, root: Root<unknown>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(VIEWS[view])
    app.use(olasPlugin(root))
    app.mount(container)
    return container
  },
  unmount() {
    app?.unmount()
    app = undefined
    container?.remove()
    container = undefined
  },
  async settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await nextTick()
  },
})
