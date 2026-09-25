// The parity views for `@kontsedal/olas-react`. The preact harness renders
// these same components with `react` aliased to `preact/compat`.
import type { Root } from '@kontsedal/olas-core'
import {
  OlasProvider,
  useField,
  useFieldInput,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useRoot,
  useValue,
} from '@kontsedal/olas-react'
import type { ReactElement } from 'react'
import {
  type CounterApi,
  type EqualApi,
  type FeedApi,
  type NameApi,
  type SaveApi,
  sameId,
  type UserApi,
  type ViewName,
} from './scenarios'

function Counter() {
  const api = useRoot<CounterApi>()
  const count = useValue(api.count)
  return (
    <button type="button" data-testid="count" onClick={api.inc}>
      {count}
    </button>
  )
}

function User() {
  const { user } = useRoot<UserApi>()
  const { data, isLoading, refetch } = useQuery(user)
  return (
    <>
      <p data-testid="user">{isLoading ? 'loading' : (data ?? '')}</p>
      <button type="button" data-testid="refetch" onClick={() => void refetch()}>
        refetch
      </button>
    </>
  )
}

function Feed() {
  const { feed } = useRoot<FeedApi>()
  const { flat, hasNextPage, fetchNextPage } = useInfiniteQuery(feed)
  return (
    <>
      <p data-testid="feed">{`${flat.join(',')}|${hasNextPage}`}</p>
      <button type="button" data-testid="more" onClick={() => void fetchNextPage()}>
        more
      </button>
    </>
  )
}

function Name() {
  const { name } = useRoot<NameApi>()
  const input = useFieldInput(name)
  const { errors, isDirty, touched } = useField(name)
  return (
    <>
      <input data-testid="input" {...input} />
      <p data-testid="state">{`${errors.join(',')}|${isDirty}|${touched}`}</p>
    </>
  )
}

function Save() {
  const { save } = useRoot<SaveApi>()
  const { mutate, status, data } = useMutation(save)
  return (
    <>
      <p data-testid="save">{`${status}|${data ?? ''}`}</p>
      <button type="button" data-testid="ok" onClick={() => mutate(21)}>
        ok
      </button>
      <button type="button" data-testid="fail" onClick={() => mutate(-1)}>
        fail
      </button>
    </>
  )
}

function Equal() {
  const { user, tick } = useRoot<EqualApi>()
  const u = useValue(user, { isEqual: sameId })
  const t = useValue(tick)
  return <p data-testid="equal">{`${u.name}:${t}`}</p>
}

const VIEWS: Record<ViewName, () => ReactElement> = {
  counter: Counter,
  user: User,
  feed: Feed,
  name: Name,
  save: Save,
  equal: Equal,
}

export function App({ view, root }: { view: ViewName; root: Root<unknown> }) {
  const View = VIEWS[view]
  return (
    <OlasProvider root={root}>
      <View />
    </OlasProvider>
  )
}
