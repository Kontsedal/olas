# Migrating to Olas

Notes for users coming from TanStack Query, Redux Toolkit, or "hooks at the top of a page". Not meant as a complete tutorial — this is a Rosetta Stone that maps familiar concepts to Olas equivalents.

`SPEC.md §1–3` covers the philosophy in depth; the spec is the source of truth for the type-level shape.

---

## From TanStack Query (React Query)

### Mental model shift

TanStack: each component calls `useQuery(['user', id], fetchUser)` at the top of its render and lets the QueryClient hash the key.

Olas: each *controller* declares `ctx.use(userQuery, () => [id])`. The query is defined once at module scope (`defineQuery`), and consumers point at it. The QueryClient still hashes — it lives on the root.

Why: in TanStack, the "subscriber" is a component; component lifetime drives subscription lifetime. In Olas, the "subscriber" is a controller; controller lifetime drives subscription lifetime. Components are just renderers. This separates "who's reading the data" from "who's drawing it on screen."

### Concept-by-concept

| TanStack Query                            | Olas                                                                  |
|-------------------------------------------|-----------------------------------------------------------------------|
| `useQuery({ queryKey, queryFn })`         | `defineQuery({ key, fetcher })` once + `ctx.use(q, keyFn)` per subscriber |
| `useInfiniteQuery`                        | `defineInfiniteQuery` + `ctx.use(infiniteQ)`                          |
| `useMutation`                             | `ctx.mutation({ mutate, onMutate, onSuccess, onError, onSettled })`   |
| `queryClient.invalidateQueries({...})`    | `userQuery.invalidate(...args)` or `userQuery.invalidateAll()`         |
| `queryClient.setQueryData(key, updater)`  | `userQuery.setData(...args, updater)`                                  |
| `queryClient.prefetchQuery(...)`          | `userQuery.prefetch(...args)`                                          |
| `QueryClientProvider`                     | `OlasProvider` (provides the root, which owns the QueryClient)        |
| `useIsFetching`                           | Subscribe to `subscription.isFetching` directly via `use()`           |
| Optimistic update with rollback           | `mutation.onMutate` returns `query.setData(...).rollback` for context |
| `keepPreviousData: true`                  | `ctx.use(q, { key, ... })` with `keepPreviousData` on the query def   |
| `staleTime` / `gcTime`                    | Same names — declared per query in `defineQuery`                       |
| `refetchOnWindowFocus`                    | Per-query option in `defineQuery` (off by default)                    |
| `useQueries` for parallel queries         | Multiple `ctx.use(...)` calls in the same controller                  |
| `useSuspenseQuery`                        | Not a built-in concept; use `subscription.firstValue()` then render   |

### The Provider story

```ts
// TanStack
<QueryClientProvider client={queryClient}>
  <App />
</QueryClientProvider>

// Olas
const root = createRoot(appController, { deps })
<OlasProvider root={root}>
  <App />
</OlasProvider>
```

The Olas root owns its own QueryClient (one per root). Two roots have isolated caches — useful for tests and for unrelated sub-apps.

### Patterns that don't translate one-to-one

- **TanStack `useQuery` returns the same `data | undefined` and you handle both.** Olas `ctx.use(q)` returns an `AsyncState<T>` with eight signals (`data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`) plus `refetch` / `reset` / `firstValue`. In React, `useQuery(subscription)` bundles them into one render trigger.
- **Suspense.** TanStack has `useSuspenseQuery`. Olas doesn't ship a Suspense integration — use `subscription.firstValue()` to await first data, or render `isLoading ? <Spinner /> : <View />`.
- **DevTools.** TanStack devtools is mature; Olas ships `@olas/devtools` — `<DevtoolsLauncher root={root} />` gives you a floating panel with controller-tree, cache timeline, and mutation log. No separate browser extension (yet — tracked in `BACKLOG.md`).

---

## From Redux Toolkit (RTK / RTK Query)

### Mental model shift

RTK: one global store, slices own reducers, components select via `useSelector`. RTK Query layers `endpoints` over a slice.

Olas: no global store. The root controller is your "store" but it's a tree, and every subtree owns its state. There are no actions, no reducers, no selectors — methods on the controller's api directly mutate signals (or call mutations).

Why: actions and reducers are useful for time-travel debugging and replayable history; the cost is the indirection of `dispatch(action) → reducer → state`. Olas trades that for direct mutation of typed reactive primitives. You still get devtools-level introspection via `root.__debug.subscribe(...)` (controller, cache, and mutation events).

### Concept-by-concept

| Redux Toolkit                                 | Olas                                                            |
|-----------------------------------------------|-----------------------------------------------------------------|
| `createSlice({ name, initialState, reducers })` | `defineController((ctx) => ({ signals + methods }))`            |
| `useSelector(selectFoo)`                       | `use(api.foo)` (signal) or `computed(() => /* derive */)`        |
| `useDispatch()` + `dispatch(slice.actions.x())` | Call methods on the controller api directly: `api.x()`         |
| `createAsyncThunk`                             | `ctx.mutation({ mutate, onSuccess, onError })`                  |
| `createSelector` (memoized derivation)         | `computed(() => …)` (memoized automatically by signals runtime) |
| RTK Query `createApi({ endpoints })`           | `defineQuery({ key, fetcher })` per endpoint                    |
| RTK Query `useGetXQuery(id)`                   | `ctx.use(getXQuery, () => [id])`                                |
| Middleware (logger, thunk, etc.)               | `root.__debug.subscribe(handler)` for events; mutations replace thunks |
| `combineReducers` / module separation          | Controller tree — each subtree is its own "slice"               |
| `useStore()`                                   | `useRoot<Api>()` (returns the root's API)                       |
| Persist via redux-persist                      | `usePersisted(ctx, key, source)` from `@olas/persist`           |

### Selectors vs computed

```ts
// Redux Toolkit
const selectActiveTodos = (s: State) => s.todos.filter(t => !t.done)
const selectVisibleCount = createSelector(selectActiveTodos, ts => ts.length)
const count = useSelector(selectVisibleCount)

// Olas
const activeTodos = computed(() => todos.value.filter(t => !t.done))
const visibleCount = computed(() => activeTodos.value.length)
// in React:
const count = use(visibleCount)
```

`computed` is the same idea as `createSelector` — memoized derivation — but it's reactive (re-evaluates when dependencies change) instead of being driven by selector calls.

### Where actions help: they help less here

If you genuinely need actions (replayable history, time-travel, action logs), you can fire devtools events from mutation `onSuccess` / `onError` and reconstruct externally. But for the typical "form submit fires a mutation, optimistic update, server confirms or rolls back" loop, RTK's `createAsyncThunk` is replaced by `ctx.mutation` with `onMutate` returning the rollback context — same data flow, less boilerplate.

---

## From "hooks at the top of the page"

The path many React projects take: every feature is a `useFoo()` hook that calls `useState` / `useQuery` / `useEffect` at the top of a component, and the component renders.

This works until:
- The same logic is needed in two components.
- A "feature" has a lifecycle longer than one component mount.
- You want to test the logic without rendering.
- The `useEffect` cleanup story gets non-trivial.

Olas's answer is: extract the hook's body into a controller, expose its API, and have the component call `useRoot()` (or a feature-specific hook returning `useRoot<X>().feature`) to read the signals.

```ts
// Before
function MyPage() {
  const [editing, setEditing] = useState(false)
  const { data: user } = useQuery(['user'], fetchUser)
  // … logic …
  return /* … */
}

// After
const myPageController = defineController((ctx) => {
  const editing = signal(false)
  const user = ctx.use(userQuery)
  return { editing, user, toggleEdit: () => editing.update(v => !v) }
})

function MyPage() {
  const page = useRoot<MyPageApi>()
  const editing = use(page.editing)
  const { data: user } = useQuery(page.user)
  return /* … */
}
```

Trade-offs: more files, more types, more setup. Payoff: lifecycle is explicit, tests don't render components, and the same controller can be driven from another framework or a CLI.

---

## When NOT to migrate

- Small apps with a few screens, no shared logic, no testable business rules. Hooks-at-the-top-of-pages is fine; don't pay the abstraction cost for nothing.
- Pure design systems / component libraries. Olas is for app logic, not UI primitives.
- Heavy mutable performance loops (canvas, animation). Signals are fast but not zero-cost; raw mutable refs win for tight inner loops. Keep them in components and commit to controllers at gesture boundaries (spec §16.5 "Gesture / transient UI state").

---

## Common confusions

**"Where does state go?"** — In a controller, as a `Signal` or `Field`. Controllers compose via `ctx.child(...)`.

**"Where does fetching go?"** — In `defineQuery` (shared across the tree) or `ctx.cache` (private to one controller).

**"How do siblings talk?"** — Parent owns both, passes refs/signals down. No implicit lookups; spec §11.

**"Where are routes?"** — Bring your own router. Put it behind a `RouterService` in deps. Spec §16.5.

**"Can I test without rendering?"** — Yes. `createTestController` builds a root in isolation. No DOM, no React.

---

## Further reading

- [`SPEC.md`](SPEC.md) — the authoritative design.
- [`.wiki/overview.md`](.wiki/overview.md) — one-page architecture.
- [`.wiki/decisions/`](.wiki/decisions/) — why-this-not-that.
