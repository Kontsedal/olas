# Olas — Specification

Olas enforces a strict separation: **all business logic lives in a tree of pure TypeScript controllers; the UI is a thin renderer that subscribes to them.**

This isn't a stylistic preference. It's the architectural principle the whole library is designed around, and it shapes every decision in this spec.

## What "all business logic" means concretely

Everything that decides *what happens* belongs in a controller:

- **Data fetching and caching** — every API call, every `fetch`, every WebSocket subscription. The UI never calls the network.
- **State** — both server-derived (cached responses) and client-local (filters, drafts, open/closed flags, selected items, current step in a wizard). All of it.
- **Mutations** — every write to the server, with optimistic updates, rollback, and invalidation.
- **Events** — domain events (`'note saved'`, `'user invited'`) that other parts of the app react to.
- **Validation** — form rules, business invariants, async server-side checks (username taken, etc.).
- **Derived data** — anything computed from server or client state.
- **Workflow / orchestration** — multi-step flows, navigation triggers, conditional logic, "after X happens, do Y."

If it has a *decision* or a *side effect*, it's in a controller. If it can be wrong in a way that matters, it's in a controller.

## What the UI does

The UI:

- Subscribes to signals exposed by controllers.
- Renders that data into the DOM.
- Wires user input (clicks, keystrokes) to methods on controllers.

The UI does **not**:

- Call APIs directly.
- Hold business state (`useState({ items: [], filter: '...' })` is wrong here — that's a controller's job).
- Run effects that aren't pure rendering observers.
- Make decisions about validation, optimistic updates, or which data to fetch.
- Contain branching on business state beyond "render this slice if the controller says so."

The only state that legitimately lives in components is **gesture state** — the in-progress drag rectangle, the hover ring, the focus highlight, the 200ms of keystrokes before a debounced commit. State whose lifetime equals a single user interaction and means nothing to anyone else. On gesture end, you commit to a controller; the controller is the source of truth. (Covered in §16.5.)

## The four practical promises

Once the boundary is mechanical, four things become true:

1. **You write 100% of app logic in plain TypeScript** — no framework hooks, no DOM, no React/Vue/Svelte concepts touch your business code.
2. **You test logic with plain unit tests against mock data** — no JSDOM, no `renderHook`, no `act` wrappers. Construct a controller in Node, call its methods, assert on signal values.
3. **You test UI by injecting fake controllers** — components take controllers as props or pull them from a provider; in tests, you hand them objects with the right signal shape. UI never touches the network.
4. **You can swap frameworks by swapping a thin adapter** — the React / Vue / Svelte adapter is the only code that knows about the UI framework. Everything else is pure TS and runs anywhere.

## Why this is worth the rules

The common shape of a serious browser app today is a sprawl: hooks holding state, effects mutating that state, components calling APIs, contexts threaded through render trees, custom stores glued to query libraries glued to form libraries. The "logic" is everywhere, observable only by rendering, testable only by simulating a DOM, and bound tightly to the framework that owns the components.

Olas inverts this. The controller tree *is* the program; the UI is a presentation layer. The boundary is enforced — controllers cannot import UI code, controllers cannot return components, and the testing story makes it cheaper to do the right thing than the wrong one.

If you've ever written a component test that takes 30 seconds because it spins up a virtual DOM, or refactored a feature only to discover its "logic" lived in three `useState`s across two component trees, this is the answer.

## Who this is for (and who it isn't)

**Olas is for medium-to-large browser apps with serious business logic** — Linear-class B2B SaaS, Notion-class document tools, Datadog-class dashboards, Slack-class collaboration, JIRA-class workflow apps. Apps where:

- Logic is the hard part, not styling.
- Features survive multiple rewrites of the UI shell.
- A QA engineer's bug report includes phrases like "the optimistic update didn't roll back."
- More than one engineer touches the codebase.

If those describe your app, the upfront cost of learning the controller tree pays back many times over in test stability, refactor safety, and onboarding new engineers.

**Olas is the wrong tool for:**

- Marketing sites and landing pages — the content *is* the app.
- 5-screen CRUD tools and internal admin dashboards — the framework overhead exceeds the logic.
- Code-on-server apps using full-page renders or RSC — Olas runs in the browser.
- Tiny side projects where "I just want `useState` to work" — use Zustand or Jotai.

The library is opinionated, the vocabulary is sizable (~20 primitives), and the testing payoff requires actually writing tests. Below a certain size, that's a bad trade.

If you're picking a tool for the next thing, ask: *will this codebase still be alive in three years, and will engineers I haven't hired yet be working on it?* If yes — Olas is built for that horizon. If no — pick something smaller.

---

## 1. Core principles

1. **Logic / UI split is hard.** Logic *cannot* import from UI; UI subscribes to controllers via a tiny adapter.
2. **Composition, not inheritance.** Controllers are factory functions that take a `ctx` and return their public API. No classes, no `this`, no decorators.
3. **Explicit tree.** Parents construct children and pass them whatever they need. No implicit lookup, no global registries, no sibling/ancestor access.
4. **Synchronous construction.** Factories never return a promise. Async work happens inside caches, mutations, or effects. This keeps the tree statically traceable.
5. **Reactivity via signals.** Built on `@preact/signals-core`. Wrapped in our own surface so the underlying runtime can change.
6. **Batteries included, escape hatches preserved.** Caches, mutations, events, fields/validators, throttle/debounce all ship in the box. Each primitive is replaceable.
7. **The return type is the public API.** Anything not returned from the factory is closure-private. TS infers the API — no visibility annotations.

---

## 2. Primitives — overview

| Primitive       | Purpose                                    | Lifecycle bound to     |
| --------------- | ------------------------------------------ | ---------------------- |
| `signal`        | Mutable reactive value                     | None (just a value)    |
| `computed`      | Derived reactive value                     | Tracked automatically  |
| `effect`        | Reactive side effect                       | `ctx` (auto-disposed)  |
| `ctx.cache`     | Anonymous local async cache (no args)      | Controller             |
| `defineQuery`   | Keyed cache, shared via the root client    | Root query client      |
| `ctx.use(q, k)` | Subscribe to a query from a controller     | Controller subscription |
| `ctx.mutation`  | Async write with optimistic + invalidation | Controller             |
| `ctx.emitter`   | One-shot event stream                      | Controller             |
| `ctx.field`     | Form field (signal + validators)           | Controller             |
| `ctx.form`      | Aggregate of fields/sub-forms/arrays       | Controller             |
| `ctx.fieldArray`| Dynamic-length list of fields or sub-forms | Controller             |
| `ctx.child`     | Construct a child controller (static)      | Parent                 |
| `ctx.collection`| Keyed set of child controllers (homogeneous or per-item-typed) | Parent       |
| `ctx.session`   | Ephemeral child controller, manually disposed | Parent                |
| `ctx.lazyChild` | Code-split child loaded on demand          | Parent                 |
| `defineInfiniteQuery` | Cursor/page-accumulating shared cache | Root query client      |
| `defineScope` + `ctx.provide` / `ctx.inject` | Typed cross-tree data slot   | Providing controller   |
| `throttled` / `debounced` | Derived signals with timing      | Inherits source        |

---

## 3. Controllers

### 3.1 Definition

```ts
const userProfile = defineController((ctx, id: string) => {
  const user = ctx.use(userQuery, () => [id])
  const page = signal(1)
  const posts = ctx.use(userPostsQuery, () => [id, page.value]) // userPostsQuery defined module-scope

  const isEditing = signal(false)
  const draft = ctx.field('', [required(), maxLength(200)])

  const save = ctx.mutation({
    mutate: (data: Draft, signal) => api.updateUser(id, data, { signal }),
    onMutate: (data) => userQuery.setData(id, (u) => ({ ...u, ...data })),
    onError: (_e, _vars, snap) => snap?.rollback(),
    onSettled: () => userQuery.invalidate(id),
  })

  const onSaved = ctx.emitter<{ userId: string }>()

  const comments = ctx.child(commentsController, {
    userId: id,
    currentUser: user.data,
  })

  ctx.onDispose(() => {
    /* extra cleanup */
  })

  return { user, posts, isEditing, draft, save, onSaved, comments }
})
```

### 3.2 The `ctx` object

`ctx` exposes every primitive a controller can construct (cache, use, mutation, emitter, field, form, fieldArray, child, attach, collection, session, lazyChild, effect, on, provide, inject), the lifecycle hooks (`onDispose`, `onSuspend`, `onResume`), and `deps`. The full canonical type signature lives in **§20.2** — refer there for the authoritative shape; this section sticks to usage patterns.

At a glance, the primitives split into four groups:

- **Reactive state & async data:** `cache`, `use`, `mutation`, `effect`.
- **Forms & input:** `field`, `form`, `fieldArray`.
- **Events & communication:** `emitter`, `on`, `provide`, `inject`.
- **Tree composition:** `child`, `attach`, `collection`, `dynamicCollection`, `session`.
- **Lifecycle & DI:** `onDispose`, `onSuspend`, `onResume`, `deps`.

**On `ctx`'s breadth.** `ctx` is intentionally broad — it's the single source of "things bound to this controller's lifetime." That's a coherent responsibility, but the surface is large (~19 methods). Two consequences worth knowing upfront:

1. **Helpers that take `ctx`.** Reusable composables that need lifecycle-bound primitives must take `ctx: Ctx` as their first parameter (`useUser(ctx, id)`, `useSubmit(ctx, form, mutate)`). That's "prop-drilling at the logic layer" — but it's explicit, grep-able, and surfaces exactly what binds to a lifecycle.

2. **What's not on `ctx`.** Anything that doesn't need lifecycle binding is a standalone function: `signal`, `computed`, `effect` (standalone), `batch`, `createEmitter`, `defineQuery`, `defineInfiniteQuery`, `defineScope`, `selection`, `debounced`, `throttled`, `debouncedValidator`, `isAbortError`, `createTestController`. Most utility code never sees `ctx`.

We considered splitting `ctx` into `CtxQuery` / `CtxForm` / `CtxLifecycle` and rejected it: most helpers mix concerns, three parameters is worse than one, and there's no clean axis to split along. The trade-off is intentional.

### 3.3 Reusable composables

Composables are just functions that take a `ctx`. No special framework concept.

```ts
function usePagination(ctx: Ctx, opts: { pageSize: number }) {
  const page = signal(1)
  const next = () => (page.value += 1)
  const prev = () => (page.value = Math.max(1, page.value - 1))
  return { page, next, prev }
}

function useUser(ctx: Ctx, id: () => string) {
  const user = ctx.use(userQuery, () => [id()])
  const isMe = computed(() => user.data.value?.id === ctx.deps.session.userId)
  return { ...user, isMe }
}
```

### 3.4 When can `ctx.*` be called?

All `ctx` primitives — `cache`, `mutation`, `emitter`, `field`, `form`, `fieldArray`, `child`, `attach`, `collection`, `session`, `lazyChild`, `effect`, `use`, `on`, `provide` — are callable **any time during the controller's active lifetime**, not only during the initial factory run. Everything you create through `ctx` is owned by that controller and disposed when it disposes.

This makes runtime-driven shapes natural:

```ts
const dynamicFormController = defineController((ctx) => {
  const schema = ctx.use(schemaQuery)
  const fields = new Map<string, Field<string>>()

  ctx.effect(() => {
    const wanted = new Set((schema.data.value ?? []).map(d => d.name))

    // dispose fields no longer in the schema — avoids unbounded growth
    for (const [name, field] of fields) {
      if (!wanted.has(name)) {
        field.dispose()
        fields.delete(name)
      }
    }

    // create fields for new schema entries
    for (const def of schema.data.value ?? []) {
      if (!fields.has(def.name)) {
        fields.set(def.name, ctx.field(def.default ?? '', def.validators))
      }
    }
  })

  return { fields }
})
```

**Individual disposal.** Every controller-bound primitive (`Field`, `Form`, `FieldArray`, `LocalCache`, `Mutation`, `Emitter`) exposes `.dispose()`. Calling it:
- Tears down the primitive's signals, subscriptions, and any in-flight work (`AbortSignal` fires).
- Is idempotent — safe to call twice; second call is a no-op.
- Doesn't affect the parent controller. Disposing one field doesn't disturb other fields, caches, mutations, or the controller's lifecycle.

When the controller itself disposes, it disposes every primitive it owns (including the ones you already disposed — idempotent). So static factory primitives never need explicit `.dispose()` calls; only dynamically-created ones that need to come and go during the controller's life.

Caveats:
- Things created after construction count toward `path` and devtools events, but their `path` ends with an auto-generated slot index (no name).
- For *child controllers* that come and go, prefer `ctx.collection` / `ctx.dynamicCollection` / `ctx.session` over hand-rolling Maps of `ctx.child` — those handle the diff and lifecycle for you. The Map-of-primitives pattern shown above is for non-controller primitives (fields, caches, mutations).

---

## 4. Lifecycle

Most controllers have two states: **active** and **disposed**. Construction happens once, disposal happens once, and that's the whole lifecycle for 80% of apps.

| Transition       | Triggers                                 | Effect                                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------- |
| construct        | `ctx.child(...)` or `createRoot(...)`    | Runs factory, sets up effects/caches/children                 |
| dispose          | parent disposes, or `controller.dispose()` | Cleanup runs bottom-up: children → caches/effects → `onDispose` hooks |

**Memory.** Disposal is always recursive and synchronous. After dispose, all signals owned by the controller are dropped; subscribers receive a final `disposed` notification and unsubscribe.

**For "user navigated away, might come back."** Dispose. The query client's `gcTime` retains shared data for ~5 min by default; re-construction finds it warm and skips the network. This is the right tool for route caches, closed tabs, hidden panels you might re-open.

### 4.1 Advanced — suspend & resume

Some controllers also support `suspend()` / `resume()`. This is for "definitely coming back, definitely soon" cases — tab UIs where you're switching between two visible tabs, modals you minimize and re-open in seconds. Suspending preserves state and subscriptions; resuming is faster than dispose-and-reconstruct.

| Transition | Triggers                                 | Effect                                                        |
| ---------- | ---------------------------------------- | ------------------------------------------------------------- |
| suspend    | `controller.suspend(options?)`           | Effects paused; caches keep data but stop refetching          |
| resume     | `controller.resume()`                    | Effects re-run; stale caches refetch                          |

**Suspension and caches:**

- Suspended controllers still count as subscribers (no immediate gc), but they don't trigger background refetches.
- `refetchInterval` timers are paused while suspended.
- A fetch that was already in flight when suspend was called continues to completion (we don't abort, since the result may be immediately useful on resume).
- On resume, any cache past its `staleTime` refetches.

### 4.2 Suspend vs dispose — picking the right one

Two states preserve a controller's identity past "not currently active." Pick deliberately, because they have very different memory profiles:

| Use case | Right tool | Why |
|---|---|---|
| Tab UI where the user is *very likely* coming back within seconds | `suspend()` | State preserved, subscriptions stay live, no re-fetch on return |
| Modal in the background while you peek at something else briefly | `suspend()` | Same |
| Route navigation away — user *might* come back in 5 minutes, *might* not | `dispose()` | Drops subscriptions; query client's `gcTime` retains shared data for ~5 min; return navigation re-constructs the controller and finds data warm (no network) |
| Closing a tab / panel for good | `dispose()` | Terminal |

**The pitfall to avoid.** Using `suspend()` for "user navigated away" cases is a memory leak in disguise. The controller and its subscriptions stay alive for the rest of the session, holding query-client entries alive past their `gcTime`. Over a long session you accumulate dozens of suspended subtrees consuming memory.

**Disposal preserves data via `gcTime`.** When the last subscriber to a query entry goes away (because a controller disposed), the entry isn't dropped immediately — it stays for `gcTime` (default 5 min). If the user returns within that window, re-construction re-subscribes and the data is already there. This is the right mechanism for "maybe coming back" caching; suspend isn't.

### 4.3 `controller.suspend(options?)` — optional auto-dispose

For cases where you legitimately want suspension but don't want to baby-sit it, pass `maxIdle`:

```ts
ctrl.suspend({ maxIdle: 5 * 60_000 }) // dispose self after 5 minutes suspended
```

Semantics:
- A timer starts at `suspend()` time.
- `resume()` cancels the timer.
- If the timer fires, the controller transitions directly from `suspended` → `disposed`.
- Default `maxIdle` is `Infinity` — current behavior preserved.

Use this for back/forward navigation caches, hidden tabs that *might* be reopened, etc. It bounds memory without forcing you to write the cleanup yourself.

---

## 5. Caches & queries

### 5.1 Two flavors, one engine

- **Local cache** (`ctx.cache`): anonymous, scoped to controller. Disposed with the controller.
- **Query** (`defineQuery` + `ctx.use`): named, keyed, shared across the tree, lives on the root's query client.

Both go through the same internal machinery. Local caches just get an opaque internal key.

**Request deduplication.** Two (or twenty) subscribers to the same query key share **one** cache entry and **one** in-flight fetch. The fetcher runs once per distinct key, regardless of how many `ctx.use(...)` subscriptions exist. This is implicit from the keyed-entry design and applies equally to `Query`, `ParamCache`, and `InfiniteQuery`.

### 5.2 Query definition

```ts
export const userQuery = defineQuery({
  key: (id: string) => ['user', id],
  fetcher: (id, signal: AbortSignal) => api.getUser(id, { signal }),
  staleTime: 30_000,                    // ms; default 0
  gcTime: 5 * 60_000,                   // ms; default 5min
  keepPreviousData: true,               // default false

  // retry on failure
  retry: 3,                             // number | (attempt, err) => boolean; default 0
  retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),  // exponential, capped; default 1000

  // optional plugin fields — only matter when a QueryClientPlugin is installed
  queryId: 'user',                      // stable identifier for cross-tab sync (§13.2)
  crossTab: true,                       // opt this query into cross-tab cache sync (§13.2)
})
```

**Retry semantics.**
- `retry: false | 0` (default) — never retry.
- `retry: number` — retry up to N times.
- `retry: (attempt, err) => boolean` — decide per-attempt; lets you skip retries on 4xx errors.
- `retryDelay: number | (attempt) => number` — ms between attempts; default `1000`.
- Retries respect `AbortSignal` — controller dispose / key change cancels the whole retry chain.
- A retried fetch counts as one logical fetch for `isFetching` / race protection / inflight counter; only the final outcome (success after retries, or final error) reaches consumers.
- Mutations support the same `retry` / `retryDelay` fields on `MutationSpec`.

**Resetting.** `subscription.reset()` clears `error` and `status` back to `'idle'` without dropping `data` (useful to dismiss an error toast without forcing a refetch). `subscription.refetch()` re-fetches regardless of stale-state. To both clear and re-fetch: `reset(); refetch();`.

When `keepPreviousData: true` and the key changes (e.g. id signal flips from `'a'` to `'b'`), the subscription keeps showing the previous entry's `data` until the new entry's first fetch resolves. `isFetching` is true, `isLoading` is false (we already have *some* data). Without this, key transitions briefly show `data === undefined`, causing UI flashes in tab and pagination UIs.

**Conditional / disabled queries.** Bootstrap flows often need "fetch X only once Y is available" (e.g. fetch the news feed once `session.currentUser` resolves). `ctx.use` accepts an `enabled` thunk that runs in a tracking scope:

```ts
const session = ctx.use(sessionQuery)

const feed = ctx.use(newsfeedQuery, {
  key: () => [session.data.value!.id, 'top-stories'],
  enabled: () => session.data.value !== undefined,
})
```

While `enabled` returns `false`, the subscription holds `status: 'idle'`, `data: undefined`, no network fetch fires, and `isLoading` stays `false`. When `enabled` flips to `true`, the key is evaluated and fetching starts normally. Flipping back to `false` does **not** dispose the entry — subsequent re-enables reuse the cached data subject to `staleTime`.

For the common case (no `enabled`), continue to pass a bare thunk: `ctx.use(query, () => [id])`. The options object form is only needed when you want `enabled`.

### 5.3 Subscription state shape

All fields are signals:

```ts
type QuerySubscription<T> = {
  data: Signal<T | undefined>
  error: Signal<unknown | undefined>
  status: Signal<'idle' | 'pending' | 'success' | 'error'>
  isLoading: Signal<boolean>          // first load, no data yet
  isFetching: Signal<boolean>         // any fetch in flight, including background
  isStale: Signal<boolean>
  lastUpdatedAt: Signal<number | undefined>
  hasPendingMutations: Signal<boolean> // ≥ 1 optimistic write applied via setData, not yet settled

  refetch: () => Promise<T>
  reset: () => void                   // clear error+status, keep data; no fetch
  firstValue: () => Promise<T>        // resolves on first success — for SSR / navigation guards
}
```

The `isLoading` vs `isFetching` split is intentional: spinners typically gate on `isLoading`, but progress indicators want `isFetching`.

**`hasPendingMutations`** is true while any `setData`-produced `Snapshot` is alive and unrolled-back for this entry. It flips back to `false` when the last outstanding mutation either succeeds (its `onSuccess` finalizes and the snapshot is discarded) or rolls back (via `snapshot.rollback()`). UI uses this to render "saving…" indicators on individual records without inventing a `pending: true` flag in the data shape.

### 5.4 Keys — a single thunk returning an array

`ctx.use` takes **one function that returns the args tuple**. Earlier drafts used variadic functions (one per arg), but that broke spread, dynamic-length keys, and conditional args. A single thunk is uniform across all cases.

```ts
// arity 1
const user = ctx.use(userQuery, () => [idSignal.value])

// arity 2+
const reviews = ctx.use(reviewsQuery, () => [productId, page.value])

// arity 0
const todos = ctx.use(todosQuery)                       // no key function needed

// dynamic / spread
const tagged = ctx.use(taggedQuery, () => [...tags.value])

// conditional
const maybeUser = ctx.use(userQuery, () => [enabled.value ? id : 'guest'])
```

**No `as const` ceremony.** The signature uses TypeScript's `<const Args>` generic so `() => [id]` infers as `[string]` rather than `string[]`:

```ts
ctx.use<const Args extends readonly unknown[], T>(
  source: Query<Args, T> | ParamCache<Args, T>,
  key?: () => Args,
): QuerySubscription<T>
```

The thunk runs inside an auto-tracking scope. When any signal read inside changes, the subscription swaps to a different cache entry. Accepting "value or signal or function" makes the API ambiguous — always require the function form (no inline values).

### 5.5 Cancellation

Every fetcher receives an `AbortSignal` as its last argument. The cache aborts an in-flight fetch when:

- The cache is disposed (controller disposal).
- The key changes (subscription swaps to a different entry).
- `refetch()` is called while a previous fetch is still pending — the previous one is aborted.
- The subscriber count drops to 0 *and* `gcTime` is `0` (immediate gc).

Fetchers are responsible for passing the signal to their I/O (`fetch(url, { signal })`, axios cancel tokens, etc.). If a fetcher ignores it, the cache will simply discard the eventual result.

### 5.6 Race conditions

Only the **latest** fetch's result is applied to a cache entry. If `refetch` is called three times in quick succession, results from the first two are discarded even if they resolve after the third. Errors from outdated fetches are also dropped.

This applies to both local caches and queries.

### 5.7 Invalidation & mutation

Invalidation and write methods hang directly off the query value (no DI needed):

```ts
userQuery.invalidate(id) // mark stale + refetch if subscribed
userQuery.invalidateAll() // mark stale + refetch every entry for this query (TanStack-style)
userQuery.setData(id, (u) => ({ ...u, name: 'X' })) // optimistic write, returns snapshot
userQuery.prefetch(id) // fire-and-forget warmup
```

Internally these all dispatch to the root's query client.

**Deep updates.** `setData` returns the new value; you build it however you want. Two canonical patterns:

```ts
// 1. Immer (recommended for nested / large data — ~3 kb, structural sharing, O(touched path))
import { produce } from 'immer'
commentsQuery.setData(postId, (prev) =>
  produce(prev ?? [], (draft) => {
    const c = draft.flatMap(t => t.comments).find(c => c.id === id)
    if (c) c.text = newText
  }),
)

// 2. structuredClone + mutate (fine for small / shallow data)
commentsQuery.setData(postId, (prev) => {
  if (!prev) return []
  const next = structuredClone(prev)
  const c = next.flatMap(t => t.comments).find(c => c.id === id)
  if (c) c.text = newText
  return next
})
```

**Perf note.** `structuredClone` is O(*total nodes in the tree*), every call — it deep-copies everything to enforce immutability. On a thread of 10,000 comments, each like flips the whole tree; that's tens of milliseconds and can produce visible UI stutter. Immer (`produce`) is O(*touched path*) via structural sharing — only the nodes you mutated, and their ancestors up to the root, are new objects; the rest is shared with the previous value. For any cache holding more than a few hundred nodes, or any update path that runs on hot input (typing, scrolling, dragging), prefer Immer.

We deliberately don't bundle Immer — users who want it import it themselves, others stay slim.

### 5.8 GC

- Each cache entry tracks its subscriber count.
- When it hits 0, start a `gcTime` timer.
- If a new subscriber arrives before the timer fires, cancel and keep the data.
- Otherwise drop the entry entirely on timer fire.

### 5.9 Refetch triggers

- `staleTime` — on subscribe / access, refetch if older than this.
- `refetchInterval` — periodic background refetch while subscribed (paused while suspended).
- `refetchOnWindowFocus` — **off by default.** Opt-in per query or root-wide.
- `refetchOnReconnect` — **off by default.** Same.

The defaults are deliberately quieter than TanStack — surprise refetches are a common source of bugs.

### 5.10 Picking the right cache flavor

| Use case | Primitive |
|---|---|
| One-off async load, no args (only this controller cares) | `ctx.cache(fetcher)` |
| Keyed cache (args vary), used by one or many controllers | `defineQuery({ key, fetcher })` |
| Paginated / cursored accumulation | `defineInfiniteQuery({...})` |

**A note on "local" parameterized caches.** Earlier drafts shipped a `ctx.paramCache` primitive — a controller-scoped keyed cache — to cover "I need pagination state but no other module needs this data." That use case is fully covered by `defineQuery`: define the query at module scope, never import it elsewhere, and it's effectively local. Sharing across controllers is opportunistic, not required, and entries gc cleanly via `gcTime`. The extra primitive added vocabulary without adding capability, so it's gone. If you genuinely want zero leakage into the global query client, set `gcTime: 0` and the entry drops the instant the last subscriber leaves.

### 5.11 Infinite / cursor pagination

For accumulating pages (chat history, infinite feeds), use `defineInfiniteQuery`:

```ts
export const messagesQuery = defineInfiniteQuery({
  key: (conversationId: string) => ['messages', conversationId],
  fetcher: async (
    { pageParam, signal }: { pageParam: string | null; signal: AbortSignal },
    conversationId: string,
  ) => api.getMessages(conversationId, { cursor: pageParam, signal }),
  initialPageParam: null as string | null,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
  getPreviousPageParam: (firstPage) => firstPage.prevCursor ?? null, // optional, for bidirectional
})
```

Subscribing returns an extended `AsyncState`:

```ts
type InfiniteQuerySubscription<TPage, TItem> = AsyncState<TPage[]> & {
  pages: ReadSignal<TPage[]>          // raw pages array
  flat: ReadSignal<TItem[]>           // helper: pages.flatMap(p => p.items) — uses an `itemsOf` selector
  hasNextPage: ReadSignal<boolean>
  hasPreviousPage: ReadSignal<boolean>
  isFetchingNextPage: ReadSignal<boolean>
  isFetchingPreviousPage: ReadSignal<boolean>
  fetchNextPage: () => Promise<void>
  fetchPreviousPage: () => Promise<void>
}
```

The `flat` selector is configurable per-query via an `itemsOf: (page) => page.items` field. If omitted, `flat` equals `pages`.

Cache invalidation drops accumulated pages and re-fetches from `initialPageParam` — explicit, no "partial invalidate". For "refetch only the most recent N pages", users can call `setData` to keep what they want.

---

## 6. Mutations

A mutation is a controller-scoped async function with first-class loading state, optimistic updates, and invalidation.

```ts
type MutationSpec<V, R> = {
  name?: string                                          // appears in devtools logs
  mutate: (vars: V, signal: AbortSignal) => Promise<R>
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (err: unknown, vars: V, snapshot: Snapshot | undefined) => void
  onSettled?: (result: R | undefined, err: unknown | undefined, vars: V) => void
  concurrency?: 'parallel' | 'latest-wins' | 'serial'    // default: 'parallel'
  retry?: RetryPolicy                                    // see §5.2
  retryDelay?: RetryDelay                                // see §5.2
}

type Mutation<V, R> = {
  run: (vars: V) => Promise<R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  lastVariables: ReadSignal<V | undefined>
  reset(): void
  dispose(): void
}
```

### 6.1 Concurrency modes

- **`parallel`** *(default)* — every `run()` is independent. `isPending` is true if *any* run is in flight. Use for distinct operations that don't conflict (e.g. "save this item", "delete that one").
- **`latest-wins`** — calling `run()` aborts the previous in-flight call via its `AbortSignal`. Use for typeahead-style mutations or anything debounced.
- **`serial`** — calls are queued and executed one at a time in order. Use when ordering matters and you can't drop intermediates.

**Promise semantics for `latest-wins`.** When a `run()` is superseded by a newer call, its returned promise rejects with a `DOMException` whose `name === 'AbortError'`. `mutation.error` is **not** populated with this error (it's reserved for genuine failures). Callers awaiting `run()` should swallow abort errors:

```ts
import { isAbortError } from '@kontsedal/olas-core'

try {
  await mutation.run(vars)
} catch (e) {
  if (isAbortError(e)) return // superseded — not a real failure
  throw e
}
```

`isAbortError(err)` is exported from `@kontsedal/olas-core` — checks for `err instanceof DOMException && err.name === 'AbortError'`. Mode `serial` never aborts queued calls. Mode `parallel` never aborts.

**Lifecycle callbacks on supersede.** When a `latest-wins` run is superseded:
- `onError` is **not** invoked with the AbortError. It's reserved for genuine failures.
- `onSettled` is **not** invoked either. A superseded run never "settles" — its work was deliberately replaced. Calling it with `(undefined, undefined, vars)` was the previous spec and led to confusing branches in user code; we now skip it. If you need cleanup that fires even on supersede, put it in a `try/finally` inside `mutate`.
- `onMutate`'s snapshot, if any, is rolled back automatically before the new run starts (so the new optimistic update doesn't stack on top of the superseded one).

### 6.2 Cancellation

Each `mutate` receives an `AbortSignal`. It's triggered when:

- Controller is disposed.
- `mutation.reset()` is called.
- `concurrency: 'latest-wins'` and a new `run()` supersedes this one.

### 6.3 Optimistic updates

`onMutate` returns a `Snapshot`. Typical shape:

```ts
{
  rollback: () => void  // called on error
}
```

The rollback closure typically calls `query.setData(...)` with the pre-mutation value.

### 6.4 Optimistic rollback under concurrency

Rollback snapshots are **positional in the update queue**, not absolute. When mutation A and B both optimistically update the same query, and B fails:

- B's rollback reverts to the state observed **after A's update**, not the original value.
- If A also fails later, A's rollback reverts to the original pre-A value.

This is the correct behavior for non-conflicting optimistic updates. For conflicting updates (both mutations writing the same field), users should prefer `concurrency: 'serial'` or implement explicit conflict resolution in their `onMutate`.

---

## 7. Emitter

Some things are events, not state: "navigate to X", "toast triggered", "form submitted." Signals model "current value" — awkward for one-shots.

```ts
type Emitter<T> = {
  emit: (value: T) => void
  on: (handler: (value: T) => void) => () => void // returns unsubscribe
  once: (handler: (value: T) => void) => () => void
}
```

Emitters created via `ctx.emitter()` auto-unsubscribe all handlers on dispose. Handlers registered via `ctx.on(emitter, handler)` (when subscribing across controllers) are also disposed with `ctx`.

---

## 8. Fields, forms & validators

Three primitives cover the entire form story: `Field<T>` (one value), `Form<S>` (nested aggregate), `FieldArray<I>` (dynamic-length list).

### 8.1 Field

```ts
const draft = ctx.field('', [required(), maxLength(200)])

draft.value          // T — current value (Field<T> IS a ReadSignal<T>; .value is unwrapped)
draft.errors         // ReadSignal<string[]>
draft.isValid        // ReadSignal<boolean>
draft.isDirty        // ReadSignal<boolean>
draft.touched        // ReadSignal<boolean>
draft.isValidating   // ReadSignal<boolean>
draft.set(value)              // writes value, runs validators, marks dirty
draft.reset()                 // restore initial value, clear dirty/touched/errors
draft.markTouched()
draft.revalidate()            // re-run validators; resolves to post-run isValid
draft.setAsInitial(value)     // bump the "initial" baseline (form-from-server pattern, §8.4)
draft.dispose()               // explicit teardown when owned outside a ctx (rare)
```

See §8.4 for when to reach for `setAsInitial`. See `pitfalls/field-value-shape.md` for the `field.value` vs `form.value` shape gotcha.

`Validator<T>` signature:

```ts
type Validator<T> = (
  value: T,
  signal: AbortSignal,
) => string | null | Promise<string | null>
```

The `AbortSignal` is triggered when the value changes again before the validator resolves (or the field is disposed) — async validators should pass it through to their I/O.

**Validators run in a tracking scope.** Reading any signal inside a validator causes the validator to re-run automatically when that signal changes:

```ts
const password = ctx.field('', [minLength(8)])
const confirm = ctx.field('', [
  (v) => (v === password.value ? null : 'Passwords must match'),
])
// editing password re-runs confirm's validator
```

Sync validators run first and short-circuit; async validators only run after all syncs pass.

### 8.2 Debounced async validators

For server-side checks (username taken, email exists), use `debouncedValidator`:

```ts
import { debouncedValidator } from '@kontsedal/olas-core'

const username = ctx.field('', [
  required(),
  debouncedValidator(async (v, signal) => {
    const taken = await ctx.deps.api.checkUsername(v, { signal })
    return taken ? 'Username taken' : null
  }, 500),
])
```

While debouncing or the request is in flight, `isValidating` is `true` and `isValid` is `false` (treat-as-invalid-until-proven-valid).

### 8.3 Form — aggregate of fields & nested forms

`ctx.form(schema, options?)` builds a `Form<S>` whose fields are addressable, whose aggregate value/errors/isValid/touched/dirty are signals, and whose schema can nest arbitrarily.

```ts
type UserProfile = {
  name: string
  address: { street: string; city: string }
  preferences: { theme: 'light' | 'dark' }
}

const form = ctx.form({
  name: ctx.field('', [required()]),
  address: ctx.form({
    street: ctx.field('', [required()]),
    city: ctx.field('', [required()]),
  }),
  preferences: ctx.form({
    theme: ctx.field<'light' | 'dark'>('light'),
  }),
})

form.value        // ReadSignal<UserProfile>
form.errors       // ReadSignal<FormErrors<...>>  — same shape as value, leaves are string[] | undefined
form.isValid      // ReadSignal<boolean>  — all leaves valid
form.isDirty      // ReadSignal<boolean>  — any leaf dirty
form.touched      // ReadSignal<boolean>  — any leaf touched
form.isValidating // ReadSignal<boolean>

form.fields.name.set('Bob')
form.fields.address.fields.street.set('1 Main St')
form.fields.address.fields.city.set('Springfield')

// ops
form.set({ name: 'New', address: { street: 'X' } })  // deep merge — partial OK
form.reset()
form.markAllTouched()
await form.validate()  // run everything; returns overall isValid
```

`form.value` is typed exactly as the schema's nested value type — no manual `FormData` interface required.

**`form.set` is batched.** Updating multiple leaves through `form.set(partial)` fires one notification pass, not one per leaf — same `batch()` semantics signals already provide.

**Form-level validators.** Cross-field rules ("endDate > startDate", "password === confirm") that don't belong to any one field go in `options.validators`:

```ts
const form = ctx.form({
  password: ctx.field('', [minLength(8)]),
  confirm: ctx.field(''),
}, {
  validators: [
    (value) => value.password === value.confirm ? null : 'Passwords must match',
  ],
})

form.topLevelErrors // ReadSignal<string[]> — errors from form-level validators only
form.isValid    // false when ANY leaf is invalid OR topLevelErrors is non-empty
```

`topLevelErrors` is separate from `errors` because the latter mirrors the schema shape; form-level errors don't belong to a specific leaf. UI typically shows `topLevelErrors` at the top of the form.

**Flat error summary.** For a11y "X errors at top of form" displays:

```ts
form.flatErrors // ReadSignal<Array<{ path: string; errors: string[] }>>
// e.g. [
//   { path: 'name', errors: ['Required'] },
//   { path: 'address.city', errors: ['Required'] },
//   { path: '', errors: ['Passwords must match'] },  // form-level errors, empty path
// ]
```

**Async validator restart.** When a tracked signal inside an async validator changes while it's pending, the in-flight validator's `AbortSignal` fires and the validator re-runs with the new value. The previous result is dropped.

### 8.4 Reactive initial values (form-from-server)

The standard pattern of "fetch user, edit a copy of it" gets a first-class option:

```ts
const profile = ctx.use(profileQuery, () => props.id)

const form = ctx.form({
  name: ctx.field('', [required()]),
  email: ctx.field('', [required(), email()]),
}, {
  initial: () => profile.data.value, // DeepPartial of form value, or undefined
})
```

Semantics:

- `initial()` runs in a tracking scope; when its tracked signals change, the form re-applies the new initial values **only if the form is not dirty**. Once the user touches anything, auto-sync stops to avoid clobbering edits.
- `form.reset()` always re-reads `initial()` to get the latest baseline.
- Setting `initial` to a fixed object (not a function) is also accepted — equivalent to a one-shot constructor initial.

### 8.5 FieldArray — dynamic lists

```ts
const order = ctx.form({
  customer: ctx.field('', [required()]),
  items: ctx.fieldArray(
    () => ctx.form({
      sku: ctx.field('', [required()]),
      qty: ctx.field(1, [min(1)]),
      price: ctx.field(0, [min(0)]),
    }),
    { initial: [{ sku: '', qty: 1, price: 0 }] },
  ),
})

order.fields.items.add({ sku: 'X', qty: 2, price: 9.99 })
order.fields.items.remove(0)
order.fields.items.move(0, 2)
order.fields.items.insert(1, { sku: 'Y' })

order.fields.items.at(0)         // Form<{ sku, qty, price }> | undefined
order.fields.items.size          // ReadSignal<number>
order.fields.items.items         // ReadSignal<Form<...>[]>
order.fields.items.value         // ReadSignal<Array<{ sku, qty, price }>>
order.fields.items.errors        // ReadSignal<Array<FormErrors | undefined>>
order.fields.items.isValid       // ReadSignal<boolean>

order.value.value
// { customer: string; items: Array<{ sku: string; qty: number; price: number }> }
```

The factory passed to `fieldArray` runs once per `add()` / `insert()` to construct a fresh sub-form (or sub-field). Each item is owned by the array; removing it disposes the underlying form.

For arrays of simple fields (no sub-form), the factory returns a single field:

```ts
const tags = ctx.fieldArray(() => ctx.field('', [required()]))
tags.add('hello')
tags.value.value  // string[]
```

**Array-level validators** ("min 1 item", "max 5 tags", "unique skus") go in `options.validators`:

```ts
const tags = ctx.fieldArray(() => ctx.field('', [required()]), {
  validators: [
    (items) => items.length >= 1 ? null : 'At least one tag',
    (items) => new Set(items).size === items.length ? null : 'Tags must be unique',
  ],
})

tags.topLevelErrors // ReadSignal<string[]> — errors from array-level validators
```

Same shape as `Form.topLevelErrors` — surfaced separately from per-item errors.

### 8.6 Submitting a form

A small composable handles the boilerplate of validate-then-mutate:

```ts
function useSubmit<T, R>(
  ctx: Ctx,
  form: Form<any> & { value: ReadSignal<T> },
  mutate: (data: T, signal: AbortSignal) => Promise<R>,
) {
  return ctx.mutation({
    mutate: async (_: void, signal) => {
      form.markAllTouched()
      const valid = await form.validate()
      if (!valid) throw new Error('Form invalid')
      return mutate(form.value.value, signal)
    },
    onSuccess: () => form.reset(),
  })
}
```

This is *not* a primitive — just a typical user-written helper. Shown here so the submission flow is obvious.

### 8.7 Zod integration (`@kontsedal/olas-zod`)

Zod is the de facto schema library; we ship a small adapter rather than baking Zod into core (Zod is ~13 kb, opt-in). `@kontsedal/olas-zod` exports two helpers:

```ts
import { z } from 'zod'
import { zodValidator, formFromZod } from '@kontsedal/olas-zod'

// 1. Single-field validator
const email = ctx.field('', [zodValidator(z.string().email())])

// 2. Whole form inferred from schema — types, structure, validators all from one source
const form = formFromZod(ctx, z.object({
  name: z.string().min(1),
  age: z.number().int().min(0),
  address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
  }),
  tags: z.array(z.string().min(1)),
}))

form.value.value
// { name: string; age: number; address: { street: string; city: string }; tags: string[] }
```

`formFromZod` walks the Zod schema:
- `z.object(...)` → `Form<...>` (recurses).
- `z.array(...)` → `FieldArray<...>` (recurses on element).
- Anything else → `Field<...>` with `zodValidator(elementSchema)` attached.

Each leaf field's initial is the Zod schema's default if present, otherwise an empty value for that type (`''` for string, `0` for number, etc.). Override per-field via the `initials` option, or use `form.set(...)` after construction.

`zodValidator(schema)` returns a `Validator<T>` that runs `schema.safeParse(value)` and reports the first `ZodIssue`'s `message` as the error. Async (`.refine(async ...)`) schemas are awaited.

Olas core stays Zod-free; `@kontsedal/olas-zod` has a peer dep on `zod ^3` and `@kontsedal/olas-core ^1`.

---

## 9. Throttle, debounce, and timing

Pure derived signals — no special lifecycle, no `ctx` needed:

```ts
const query = signal('')
const debouncedQuery = debounced(query, 300) // Signal<string>, lags by 300ms
const throttledScroll = throttled(scrollY, 100)
```

For method-level throttling inside a controller, just wrap a function with `debounce(fn, 300)`.

---

## 10. Dependency injection

```ts
const root = createRoot(rootController, {
  deps: {
    api: realApiClient,
    session: sessionStore,
    logger: console,
  },
})
```

Inside any controller in the tree:

```ts
ctx.deps.api.getUser(id)
```

Any subtree can override deps for itself + descendants:

```ts
const child = ctx.child(featureController, props, {
  deps: { api: featureSpecificApi },
})
```

For tests, `ctx.withDeps({ api: mockApi })` at the root gives you a fully mocked tree.

**Rule:** controllers never import singletons directly. All shared services come in through `ctx.deps`. This is the property that makes tests trivial.

### 10.1 Deps can hold reactive services

`deps` is *immutable per root* in the sense that the deps object itself doesn't change. But its values can absolutely be **reactive services** — objects that expose signals and methods that mutate them. This is how cross-cutting state (current user, feature flags, theme, online/offline) reaches any controller:

```ts
type SessionService = {
  currentUser: ReadSignal<User | null>
  signIn(creds: Credentials): Promise<void>
  signOut(): void
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    session: SessionService
    theme: ReadSignal<'light' | 'dark'>
    flags: ReadSignal<FeatureFlags>
  }
}

// in any controller
const greeting = computed(() => `Hello, ${ctx.deps.session.currentUser.value?.name ?? 'guest'}`)
```

Services can be plain objects, Olas roots themselves, or anything else with a `.value` signal-like surface. The point is: **deps is the right home for app-wide state**, not just stateless API clients.

### 10.2 Deps as the cross-cutting bus

`deps` is the right place for app-wide services that *any* controller might need: API clients, session, logger, analytics, toasts, navigation, feature flags. Two flavors:

**Stateless services** — plain objects with methods. `ctx.deps.analytics.track('event')`.

**Cross-cutting events** — emitters that exist outside the controller tree, declared in deps. A separate controller (often near the root) can subscribe and turn them into reactive state:

```ts
import { createEmitter } from '@kontsedal/olas-core'

// declared in deps
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    toast: Emitter<{ message: string; level: 'info' | 'error' }>
  }
}

// constructed before createRoot
const toastBus = createEmitter<{ message: string; level: 'info' | 'error' }>()

const root = createRoot(myApp, {
  deps: { api, session, toast: toastBus },
})

// any controller can fire — no plumbing needed
ctx.deps.toast.emit({ message: 'Saved!', level: 'info' })

// a Toast controller in the tree subscribes and exposes state
const toastController = defineController((ctx) => {
  const current = signal<Toast | null>(null)
  ctx.on(ctx.deps.toast, (t) => {
    current.set(t)
    setTimeout(() => current.set(null), 3000)
  })
  return { current }
})
```

`createEmitter<T>()` is the standalone counterpart to `ctx.emitter<T>()` — same interface, but no controller binding, so handlers don't auto-clean. Use it for emitters that live longer than any single controller (typically in deps).

This is the blessed escape hatch: when "hoist to common ancestor" would mean threading something through five layers, route it via a deps-bound emitter.

### 10.3 Scopes — typed cross-tree data

Deps + props handle the common cases (app-wide services, immediate parent-child data). But large apps have *domain-scoped* data that flows through many levels: `orgId` known at the org level, needed by tasks five layers down. Prop-drilling through every intermediate controller is real pain.

**`Scope`** is a typed, named slot of data provided by an ancestor and consumed anywhere in its subtree:

```ts
import { defineScope } from '@kontsedal/olas-core'

// declared once, at module scope — the scope is a typed value, not a string
export const orgScope = defineScope<{ orgId: string; orgName: string }>()

// at the org level, provide
const orgController = defineController((ctx, props: { id: string }) => {
  ctx.provide(orgScope, { orgId: props.id, orgName: 'Acme' })
  const workspaces = ctx.child(workspacesController, props)
  return { workspaces }
})

// anywhere below — read
const taskController = defineController((ctx, props: { taskId: string }) => {
  const org = ctx.inject(orgScope) // typed { orgId: string; orgName: string }
  // ...
})
```

Semantics:
- A scope is consumed by `ctx.inject(scope)`. If no ancestor provides it and the scope has no `default`, it throws synchronously during construction.
- `defineScope<T>({ default })` accepts a default that's used when no provider exists.
- Providing the same scope at a deeper level *shadows* the ancestor's value for that sub-tree.
- The provided value is a snapshot — re-providing with a new object replaces it (and notifies signal-aware consumers).
- For a reactive scope value, provide a signal-bearing object: `ctx.provide(orgScope, { orgId, orgName })` where these are signals.

Why scopes vs deps:
- **Deps** is for app-wide services that are stable for a root's lifetime.
- **Scopes** is for hierarchical data that varies by subtree and is provided/consumed at specific layers.

Scopes are slightly weaker than props for static traceability (a consumer's signature doesn't tell you who provides it), but they're **typed and named** — `grep "provide(orgScope"` finds every provider. Use them for true domain-scoped concerns, not as a general bypass for props.

#### When to use a scope — and when not to

Scopes are the most easily abused primitive in the library. Used well, they remove painful prop-drilling for genuinely hierarchical data. Used carelessly, they turn into React Context 2.0: invisible coupling, hard-to-trace dependencies, provider spaghetti.

**Use a scope when:**

- The data is **truly domain-hierarchical** — there's a level in your controller tree where it's introduced, and every controller below that level conceptually exists *within* that domain. Classic examples: `orgId`, `workspaceId`, `documentId`, `experimentBucket`.
- More than **three intermediate layers** would otherwise have to thread the same prop unchanged. (Three is roughly the patience threshold — beyond that, prop-drilling becomes refactoring tax.)
- The consuming controllers don't need to declare the dependency in their *external* props (the dependency is contextual, not parameterized).
- You have **fewer than ~10 scopes** in the whole app. If your app has 30 scopes, you've recreated implicit DI by other means.

**Use props (or a child controller's `ctx.deps` override) when:**

- The data is local to one parent-child relationship.
- The consumer takes the data as part of its parameterization (`taskController` *needs* a `taskId`; that should be in props, not a scope).
- You only have one or two layers of nesting.
- The consumer might run outside the providing controller's subtree (tests, isolated reuse).

**Use deps when:**

- The data is **app-wide** and stable for the root's lifetime — services, API clients, session, logger.
- Multiple unrelated subtrees need it.

**The litmus test:** if a junior engineer reading your controller can't answer "where does this value come from?" in 10 seconds, you've overused scopes. Scopes are a memory-and-typing convenience, not a substitute for explicit parameterization. The default move is props; reach for a scope when the prop-drilling cost is real and the data is genuinely hierarchical.

---

## 11. Cross-controller communication

No implicit lookup. Three permitted patterns:

1. **Parent passes signals/refs to children** at construction.
2. **Children expose their public API back to the parent** via return values; the parent wires siblings together.
3. **Emitters** for one-shot events that need to cross controller boundaries — passed in via props, never resolved by name.

This means no `ctx.get(OtherController)`, no service locator, no event bus that anyone can publish to globally. Painful occasionally; makes the whole tree statically traceable.

### 11.1 Dynamic children — `ctx.collection`

`ctx.child` is for statically known children (constructed during the factory's first run, fixed for the controller's lifetime). For dynamic children — a controller per item in a list of unknown size that changes over time — use `ctx.collection`:

```ts
const conversations = ctx.collection({
  controller: conversationController,
  source: computed(() => conversationsQuery.data.value ?? []),
  keyOf: (c) => c.id,
  propsOf: (c) => ({ id: c.id, initialName: c.name }),
})

// reactive surface
conversations.items // ReadSignal<Array<{ key, api }>>
conversations.size // ReadSignal<number>
conversations.get(id) // current api for that key, or undefined
conversations.has(id) // boolean

// iteration in UI
const items = use(conversations.items)
items.map(({ key, api }) => <ConversationView key={key} api={api} />)
```

The collection subscribes to `source`. On each change it diffs by `keyOf`:

- **New keys** → construct a child controller via `controller` with `propsOf(item)`.
- **Removed keys** → dispose that child controller (recursive disposal, same as parent-driven).
- **Unchanged keys** → leave the child in place; its props **are not** re-applied. Controllers own their state past construction.

If item *content* changes (same key, new fields) and a child needs to react, the child should consume that data through a signal passed in `propsOf` — not by expecting `propsOf` to be re-invoked.

Collections solve two problems at once: dynamic lifecycles, and **per-item subscription performance**. Each child controller owns its own signals, so UI items can subscribe only to *their* signals — the parent list re-renders only when items are added/removed, item internals re-render only when their signals change.

For non-controller-worthy items (just data), a `computed(() => list.value.find(...))` is fine — accept the linear search up to a few thousand items.

**Heterogeneous items — same primitive, factory form.** When item types vary (Notion blocks, Datadog widgets, Slack channel types), pass a `factory` instead of `controller` + `propsOf`:

```ts
type Block =
  | { id: string; type: 'text'; content: string }
  | { id: string; type: 'code'; code: string; language: string }
  | { id: string; type: 'chart'; query: string }

const blocks = ctx.collection({
  source: computed(() => doc.data.value?.blocks ?? []),
  keyOf: (b) => b.id,
  factory: (b: Block) => {
    switch (b.type) {
      case 'text':  return { controller: textBlockController,  props: { content: b.content } }
      case 'code':  return { controller: codeBlockController,  props: { code: b.code, language: b.language } }
      case 'chart': return { controller: chartBlockController, props: { query: b.query } }
    }
  },
})

// items signal — each entry carries the source item for narrowing in UI
blocks.items.value
// Array<{ key, api: TextBlockApi | CodeBlockApi | ChartBlockApi }>
```

`ctx.collection` accepts **either** the homogeneous form (`controller` + `propsOf`) **or** the factory form (`factory: (item) => { controller, props }`), never both. The factory form is called once per new key; type-discriminant changes for an existing key dispose and reconstruct the child.

This makes `ctx.collection` the single primitive for plugin / block / widget containers. Document editors, dashboards, page builders, IDE panels — anywhere the children are typed-per-item.

**Ephemeral controllers — `ctx.session`.** When a child controller exists only for a transient interaction (modal, edit session, tooltip, command palette open), `ctx.child` is the wrong primitive — it lives until the parent disposes. Use `ctx.session`:

```ts
const [editor, dispose] = ctx.session(richEditorController, { initial: content })

// use editor
await editor.save.run({ content: editor.draft.value })

// dispose explicitly when done
dispose()
```

Lifetime is bounded by either (a) the explicit `dispose()` you call, or (b) the parent's disposal — whichever comes first. The api shape is exactly the controller's return type; there's no extra wrapper to unpack.

Use cases: modal forms (open, edit, save/cancel, dispose), inline edit sessions (one row enters edit mode, commits, disposes), wizards (each step's controller lives for its step), command palette (the palette is constructed when opened, disposed when closed).

### 11.2 When to use controllers vs raw signals

Controllers are the unit of *testable logic*. Each one is a small program with its own lifecycle, its own primitives, and its own public surface. They earn their cost — both runtime (per-instance allocations, subscriptions, devtools events) and conceptual (you have to think about where it lives in the tree).

Use a **controller** when each item is genuinely its own small program: an open chat in messenger, a tab in a tabbed editor, an active video player on a watch page, a row in an editable spreadsheet of ~hundreds of rows. The signals it owns, the mutations it exposes, and the per-item lifecycle (close, pause, dispose) all justify a dedicated controller.

Use **plain signals or maps of signals** when items are homogeneous data with no per-item behavior worth testing in isolation: posts in an infinite news feed (10,000 visible), cells in a spreadsheet grid (100,000), nodes in a virtualized tree, comments past the first ten. These belong as data inside a parent controller. The parent owns one or many signals that hold the collection; UI subscribes to per-item slices (typically via `computed(() => bigMap.value.get(id))` or per-item signals stored in a `Map<Key, Signal<Item>>`).

A rule of thumb: **if the per-item logic would have less than three lines in its own controller factory, it's data, not a controller.** If you need per-item mutations, lifecycle, scopes, validators, or composition — controller. If you only need to read/write a field — signal.

For very large homogeneous collections where you still want fine-grained reactivity (one cell updating doesn't re-notify all subscribers to the parent map), the **per-key signal** pattern is canonical:

```ts
const cells = new Map<CellRef, Signal<CellData>>()
const getCell = (ref: CellRef) => {
  let s = cells.get(ref)
  if (!s) {
    s = signal({ value: '', formula: null })
    cells.set(ref, s)
  }
  return s
}
```

UI components subscribe only to the cells they render. Disposal happens with the parent controller (the map and all its signals get GC'd when the controller's closure goes).

**Virtualization compatibility.** Virtualizers (`react-virtual`, `react-window`, AG-Grid) mount and unmount row components rapidly as the user scrolls. If each row is its own controller, scrolling fast constructs and disposes hundreds of controllers per second — real performance pain and pointless allocation churn. **For virtualized lists, rows are data**: keep them as items in a parent controller's signal/map, and let UI components be lightweight stateless renderers driven by per-row signals (the pattern above). The Olas controller boundary belongs at the *list* level, not the row level.

If a row needs row-scoped logic that's worth a controller (e.g. a row enters edit mode), use `ctx.session(rowEditorController, ...)` on demand and dispose on commit/cancel — controllers exist only while editing.

---

## 12. Error handling

Caches capture fetcher errors into `error` signals. Mutations capture mutator errors into `error` signals. **Uncaught** errors — thrown in effects, in background refetches with no subscriber to observe `error`, in emitter handlers — go to a root-level handler:

```ts
const root = createRoot(rootController, {
  deps: { ... },
  onError: (err, context) => {
    deps.logger.error(err, context)
  },
})
```

`context` carries: `{ kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction', controllerPath: string[], queryKey?: unknown[] }`.

Default `onError` is `console.error`. The handler must never throw — if it does, we swallow and log to console.

### 12.1 Constructor errors

A controller's factory function can throw — typically because deps are misconfigured, props are invalid, or a constant-evaluation invariant is violated. Spec semantics:

1. **The throwing controller is not constructed.** Its API is never returned; `ctx.child(...)` re-throws synchronously.
2. **Already-constructed siblings stay alive.** If a parent constructed three children and the fourth's factory threw, the three are not torn down — they're functional.
3. **The throw propagates up.** If a parent's factory was the one calling `ctx.child(...)`, the parent's factory now throws too. This recurses up to the closest `try/catch` or to `createRoot` itself.
4. **Partially-constructed parents are rolled back.** When a parent's factory throws, every primitive and child the parent already created via `ctx` (before the throw) is disposed in reverse order of creation. The error then propagates further.
5. **`createRoot` does not swallow.** If construction reaches the root and throws, `createRoot` itself throws — *not* `onError`. Bootstrap failures are caller's responsibility, exactly like a top-level synchronous exception in `main()`.
6. **`root.onError` only fires for construction errors that happen *after* the root is alive** — e.g., inside an `effect` that constructs a `ctx.child` lazily, or inside a `ctx.collection`'s factory that throws when a new item arrives. Those throws go to `onError` with `kind: 'construction'` and don't propagate (the collection skips the bad item; UI sees one fewer entry).

The rule of thumb: synchronous bootstrap errors throw out of `createRoot`; runtime construction errors (collection items, lazy children, schema-driven primitive creation) go through `onError`.

---

## 13. Persistence

Persistence is a composable, not a built-in primitive:

```ts
import { usePersisted } from '@kontsedal/olas-persist'

const draft = signal('')
usePersisted(ctx, 'draft', draft, {
  storage: localStorage, // or indexedDB adapter, or custom
  serialize: JSON.stringify, // default
  deserialize: JSON.parse, // default
  crossTab: false, // opt-in 'storage' event sync
})
```

`usePersisted` is bound to `ctx` so it cleans up subscriptions on dispose. Loading the initial value is synchronous for localStorage; for async storages, it returns a `{ ready: Signal<boolean> }` and the signal holds the default until ready.

Cross-tab sync is opt-in and only supported by storages that emit change events (localStorage via `storage` event).

### 13.2 Cross-tab in-memory cache sync

A separate composable (`@kontsedal/olas-cross-tab`) layers over `QueryClient` to mirror `setData` / `invalidate` events across browser tabs of the same origin via `BroadcastChannel`. Persistence (§13 / `@kontsedal/olas-persist`) syncs *persisted* signals on the `storage` event; this syncs *in-memory* query cache entries that never touch disk. Both are opt-in and independently configurable; combining them for the same logical state is supported but redundant.

The plugin requires a stable `queryId` per query to route messages across tabs. Set it on `defineQuery({ queryId, ... })`. Opt a query in with `crossTab: true`. See `@kontsedal/olas-cross-tab` README and §5.2 for the query-spec fields.

```ts
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'

createRoot(appController, {
  deps,
  plugins: [crossTabPlugin({ channelName: 'my-app/cache/v1' })],
})
```

Only non-infinite queries sync. Infinite queries (`defineInfiniteQuery`) do not propagate cross-tab — the page-array payload is too heavy to be a safe default. Plugin events still fire with `kind: 'infinite'` so future plugins can opt in; the built-in cross-tab plugin filters them out.

**Echo prevention is layered:** (1) the `QueryClient` marks remote-applied writes with `isRemote: true` on `SetDataEvent` / `InvalidateEvent`, and plugins skip rebroadcast in that case; (2) messages carry a `sourceId`, and the plugin filters its own; (3) messages carry a monotonic `msgId`, and out-of-order or duplicate messages are dropped.

`SetDataEvent` carries a `source: 'set' | 'fetch' | 'remote'` field so layered plugins can distinguish explicit `setData` calls from fetcher-result writes (`'fetch'`) and remote-applied writes (`'remote'`). The cross-tab plugin only rebroadcasts `source: 'set'` — fetcher results are a per-tab concern, since every tab runs its own fetcher and rebroadcasting would be quadratic noise. Plugins that need a holistic view of cache writes (entity normalization — see §18.1) observe all three.

`QueryClientPluginApi` exposes `setEntryData(queryId, keyArgs, updater)` for plugins that need to write back into the cache via the local-write path (the resulting `SetDataEvent` has `source: 'set'`, `isRemote: false` — cross-tab WILL rebroadcast). Used by the entity-normalization plugin (§18.1) to patch every query holding a given entity in one batched round of writes.

**Channel-name versioning.** Channel names are user-supplied. Receivers drop messages whose protocol `v` they don't understand; users who want clean cross-deploy isolation should include a version suffix in their `channelName` (e.g. `'my-app/cache/v2'`).

**Non-cloneable values.** `BroadcastChannel` uses structured clone. Cache data carrying functions, class instances, or symbols cannot cross the boundary. The plugin catches the `DataCloneError`, calls `onWarn(...)`, and drops the message; the sender's cache is unaffected. Consumers should ensure their fetcher results are structured-cloneable when `crossTab: true`.

**Plugin contract.** The same `QueryClientPlugin` slot accepts other layered concerns — see §20.8 for the type.

---

## 14. Devtools

The root exposes a `__debug` event stream:

```ts
root.__debug.subscribe((event) => {
  // structured event, see below
})
```

Event types:

- `controller:constructed | suspended | resumed | disposed` — `{ path: string[], propsSnapshot }`
- `cache:subscribed | fetch-start | fetch-success | fetch-error | invalidated | gc` — `{ queryKey, controllerPath, durationMs? }`
- `mutation:run | success | error | rollback` — `{ controllerPath, vars?, error? }`
- `field:validated` — `{ controllerPath, fieldName, valid, errors }`

The schema is stable enough to build tooling on, but isn't a public API guarantee — internal events may be added. `@kontsedal/olas-devtools` consumes this stream as an in-app panel.

---

## 15. SSR — dehydrate & hydrate

We ship serialization primitives, not framework-specific SSR glue:

```ts
// server
const root = createRoot(rootController, { deps: serverDeps })
await root.waitForIdle() // resolves when no fetches in flight
const state = root.dehydrate() // JSON-serializable snapshot of the query client

// client
const root = createRoot(rootController, {
  deps: clientDeps,
  hydrate: state, // restores query client cache entries
})
```

`waitForIdle()` resolves when:

- No cache entries are in `pending` status.
- No pending mutations.

`dehydrate()` only serializes the **query client cache** (data + lastUpdatedAt per entry). Controller state isn't serialized — controllers reconstruct from their props on the client.

---

## 16. UI adapter contract

Adapters live in tiny separate packages (`@kontsedal/olas-react`, `@kontsedal/olas-vue`, `@kontsedal/olas-svelte`, vanilla). Roots are created **once** outside the UI (typically near `main.tsx`); the adapter resolves the root via context and exposes hooks for reading signals.

```tsx
// main.tsx
const root = createRoot(appController, { deps })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)

// inside any component
function UserProfile({ id }: { id: string }) {
  const app = useRoot()                       // get the root's api
  const user = useQuery(app.userProfile.user) // unwrap an AsyncState
  const isEditing = use(app.userProfile.isEditing)
  return /* ... */
}
```

In React, hooks build on `useSyncExternalStore`. In Vue, signals interop with `ref` natively. In Svelte, signals become stores via `$signal`. In vanilla, just `.subscribe()`.

The adapter is the **only** code that knows about a UI framework. Everything else is pure TS.

Note: `useRoot()` is the new ergonomic name; the older `useController(root)` form is also exported as an alias for back-compat in early releases.

---

## 16.5 Canonical patterns

Things that aren't framework primitives but show up in every non-trivial app. Documenting the recommended approach so projects converge on one shape instead of inventing four.

### Routing as a reactive service

Olas doesn't ship a router. Put your router behind a service interface in deps:

```ts
interface RouterService {
  currentRoute: ReadSignal<{ path: string; params: Record<string, string>; query: URLSearchParams }>
  navigate(path: string, options?: { replace?: boolean }): void
  back(): void
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    router: RouterService
  }
}
```

For React projects, a 30-line wrapper over `react-router` populates the signal from `useLocation` and exposes `navigate` from `useNavigate`. The router still owns the address bar; controllers consume `ctx.deps.router.currentRoute` reactively to decide what to render or fetch.

Why a service in deps instead of a controller: routing is conceptually one source of truth (browser history), and most apps already have a routing library that owns it. The service is a thin adapter.

### Real-time updates → cache patches

The recurring shape "WebSocket event arrives → patch some queries":

```ts
function useRealtimePatcher<TEvent>(
  ctx: Ctx,
  channel: string,
  handlers: Partial<Record<TEvent extends { type: infer K } ? K & string : never, (ev: TEvent) => void>>,
) {
  ctx.effect(() => {
    const sub = ctx.deps.realtime.subscribe(channel, (ev: TEvent) => {
      const type = (ev as { type: string }).type
      handlers[type as keyof typeof handlers]?.(ev)
    })
    return () => sub.unsubscribe()
  })
}

// usage
useRealtimePatcher(ctx, `feed-events`, {
  'like-added': (ev) => newsfeedQuery.setData('top-stories', (pages) => /* patch */),
  'comment-added': (ev) => commentsQuery.setData(ev.postId, (prev) => [...prev ?? [], ev.comment]),
  'post-deleted': (ev) => newsfeedQuery.invalidateAll(),
})
```

Ship this composable in user code. The framework primitive is `ctx.effect` + `setData`; this wraps the typical dispatching boilerplate.

### Gesture / transient UI state

Some state legitimately belongs to a single component for a single interaction: the in-progress rectangle while marquee-selecting, the floating ghost element during drag, focus rings, hover. These have:
- Lifetime equal to the gesture
- No business-logic value (nothing to test in isolation)
- No need to survive a re-render of the parent feature

**Keep this state in components** — `useState`, `useRef`, framework-native. On gesture end, *commit* the result to the controller (e.g., `kanban.moveCard(cardId, newColumnId)`). The pattern is: component owns "what is the user doing right now"; controller owns "what does the world look like after they're done."

This is not a violation of "logic lives in controllers" — gestures aren't logic, they're input. The controller method `moveCard` is the logic, and it's tested there.

### Bulk operations

For "select N items, do thing to all of them":

- **If the API supports a batch endpoint** (preferred): one mutation with `vars: ID[]`. Optimistic update writes all N at once. One rollback on failure.
- **If only single-item endpoints exist**: `await Promise.all(ids.map(id => mutation.run({ id })))`. Mutations are `parallel` by default. Errors per-item are visible via the rejected promise; `mutation.error` only reflects the *last* error (limitation of a single mutation instance). For richer per-item tracking, run mutations inside a controller and track an `Array<MutationOutcome>` signal.

Avoid pretending a single mutation tracks N concurrent runs cleanly — the `Mutation` API tracks one logical operation. For N truly independent operations, run N separate mutations or hand-roll the orchestration.

### Code splitting with `ctx.lazyChild`

Heavy features (rich editor, chart library, admin panel) shouldn't be in the initial bundle. `ctx.lazyChild` defers both module load and controller construction:

```ts
const editor = ctx.lazyChild(
  () => import('./editorController').then(m => m.editorController),
  { initialContent: '...' }, // props for the eventual controller
)

editor.status.value // 'idle' | 'loading' | 'ready' | 'error'
editor.api.value    // ReadSignal<EditorApi | undefined> — defined once status === 'ready'
editor.load()       // kicks off the dynamic import (idempotent)
editor.dispose()    // disposes the underlying controller if loaded; safe to call before load
```

Semantics:
- Returns a `LazyChild<Api>` wrapper, not the api itself.
- `load()` triggers the import; multiple calls dedupe. If you never call `load()`, the module never loads.
- On success, `api.value` becomes the controller's API. Components subscribe normally via `use(editor.api)`.
- On import / construction failure, `status` flips to `'error'` and `error.value` carries the cause; `root.onError` fires with `kind: 'construction'`.
- Parent disposal disposes the lazy child (if loaded) and aborts an in-flight load.

Type:

```ts
type LazyChild<Api> = {
  status: ReadSignal<'idle' | 'loading' | 'ready' | 'error'>
  api: ReadSignal<Api | undefined>
  error: ReadSignal<unknown | undefined>
  load(): Promise<Api>
  dispose(): void
}
```

### HMR (development)

Olas roots typically live at module scope. When HMR replaces a controller's module, the running root holds the *old* controller definition. Two options:

Treat the root as a "device" — on HMR boundary modules, `root.dispose()` and `createRoot(...)` again. UI state resets; cache survives because you can dehydrate-then-hydrate across the swap. Roughly 10 lines of Vite plugin glue.

Document the rebuild pattern in your project's HMR setup.

### Multi-select for large lists

Selection state (which items are selected, the "anchor" for shift-click range select) recurs in every table / list with bulk actions. Use the `selection` composable from `@kontsedal/olas-core`:

```ts
import { selection } from '@kontsedal/olas-core'

const issuesController = defineController((ctx) => {
  const issues = ctx.use(issuesQuery)
  const sel = selection<string>() // returns the Selection object below

  const bulkArchive = ctx.mutation({
    mutate: (_: void, signal) =>
      ctx.deps.api.archiveMany([...sel.selectedIds.value], { signal }),
    onSuccess: () => sel.clear(),
  })

  return { issues, selection: sel, bulkArchive }
})
```

`Selection<T>` shape:

```ts
type Selection<T> = {
  selectedIds: ReadSignal<ReadonlySet<string>>
  size: ReadSignal<number>
  isSelected(id: string): ReadSignal<boolean>

  // imperative
  select(id: string): void
  deselect(id: string): void
  toggle(id: string): void
  clear(): void
  selectAll(ids: readonly string[]): void

  // shift-click / cmd-click / range — call from your row click handler
  handleClick(id: string, mods: { shift?: boolean; meta?: boolean }, ordered: readonly string[]): void
}

function selection<T>(opts?: { initial?: readonly string[] }): Selection<T>
```

The `handleClick` method encapsulates the standard semantics:
- plain click → select only `id`
- meta-click → toggle `id` in selection
- shift-click → range from anchor (last clicked) to `id`, using `ordered` to define the range

`selection` is a plain function, not bound to `ctx` — the signals it owns aren't lifecycle-bound. Put it in a controller's closure; it dies with the closure.

### Inline editing

Click a cell, edit, save or cancel. The pattern across tables, kanban cards, profile fields:

```ts
function useInlineEdit<T>(
  ctx: Ctx,
  current: () => T,
  save: (value: T, signal: AbortSignal) => Promise<void>,
) {
  const isEditing = signal(false)
  const draft = signal<T | undefined>(undefined)

  const start = () => {
    draft.set(current())
    isEditing.set(true)
  }
  const cancel = () => {
    draft.set(undefined)
    isEditing.set(false)
  }

  const commit = ctx.mutation({
    mutate: (_: void, signal) => save(draft.value as T, signal),
    onSuccess: () => {
      draft.set(undefined)
      isEditing.set(false)
    },
  })

  return { isEditing, draft, start, cancel, commit }
}
```

Use cases:
- Editable table rows: one `useInlineEdit` per row, instantiated on demand in the row controller (or via `ctx.session`).
- Inline title editing on a card.
- Tag editing on a profile field.

The `current` thunk re-reads server data on edit start, so concurrent updates don't get clobbered.

### Live streaming buffers (logs, metrics, presence)

Tail mode: a WebSocket / SSE stream firing 10–1000 events/sec, rendered live with backpressure:

```ts
function useTail<T>(
  ctx: Ctx,
  subscribe: (push: (item: T) => void) => () => void,
  options: { capacity: number; flushMs?: number } = { capacity: 10_000, flushMs: 16 },
) {
  const buffer = signal<T[]>([])
  const isPaused = signal(false)
  let pending: T[] = []
  let flushTimer: number | null = null

  ctx.effect(() => {
    if (isPaused.value) return
    const unsub = subscribe((item) => {
      pending.push(item)
      if (flushTimer == null) {
        flushTimer = window.setTimeout(() => {
          const next = [...buffer.value, ...pending]
          if (next.length > options.capacity) {
            next.splice(0, next.length - options.capacity)
          }
          buffer.set(next)
          pending = []
          flushTimer = null
        }, options.flushMs ?? 16)
      }
    })
    return () => {
      unsub()
      if (flushTimer != null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }
  })

  return { items: buffer, isPaused, pause: () => isPaused.set(true), resume: () => isPaused.set(false) }
}
```

Key points:
- `flushMs` coalesces N events into one UI update — prevents 1000 renders/sec.
- `capacity` caps memory; oldest entries drop.
- Pause/resume controls the subscription, not the buffer (buffer is preserved when paused).
- For "merge with historical query" (load page-1 history then tail forward), compose with a `ctx.cache` and a `computed(() => [...history.data.value ?? [], ...buffer.value])`.

Ship as a user composable.

---

## 17. Testing strategy

### 17.1 Logic tests — no UI needed

```ts
import { createTestController } from '@kontsedal/olas-core/testing'

test('saving a profile invalidates the user query', async () => {
  const profile = createTestController(userProfile, {
    deps: { api: mockApi, session: mockSession },
    props: { id: 'user-123' },
  })

  await profile.save.run({ name: 'New name' })

  expect(mockApi.updateUser).toHaveBeenCalledWith('user-123', { name: 'New name' })
  expect(profile.user.isStale.value).toBe(true)

  profile.dispose()
})
```

For tests that need a real tree (parent + children), use the regular `createRoot` and exercise via the root's exposed api:

```ts
const root = createRoot(myApp, { deps: mockDeps })
await root.todoList.toggle.run({ id: '1', done: true })
```

### 17.2 UI tests — inject fake controllers

```tsx
const fakeProfile = {
  user: { data: signal({ id, name: 'Fake' }), isLoading: signal(false), ... },
  isEditing: signal(false),
  save: { run: vi.fn(), isPending: signal(false), ... },
  // ... shape matches the real controller's return type
}

render(<UserProfileView profile={fakeProfile} />)
```

UI tests never mock the network because UI never touches the network.

### 17.3 More logic-test patterns

```ts
import { createTestController } from '@kontsedal/olas-core/testing'

// Driving a form through happy and error paths
test('login validates and submits', async () => {
  const api = { signIn: vi.fn().mockResolvedValue({ token: 't' }) }
  const session = { signIn: vi.fn() }

  const login = createTestController(loginController, {
    deps: { api, session },
    props: undefined,
  })

  // empty submit — fails validation, no network
  await login.submit.run()
  expect(login.form.isValid.value).toBe(false)
  expect(api.signIn).not.toHaveBeenCalled()

  // fill in and submit
  login.form.fields.email.set('user@example.com')
  login.form.fields.password.set('supersecret')
  await login.submit.run()
  expect(api.signIn).toHaveBeenCalledWith({ email: 'user@example.com', password: 'supersecret' })

  login.dispose()
})

// Asserting optimistic update + rollback
test('liking a post optimistically updates then rolls back on error', async () => {
  const api = { likePost: vi.fn().mockRejectedValue(new Error('500')) }
  const ctrl = createTestController(postController, { deps: { api }, props: { id: 'p1' } })

  // seed cache
  postQuery.setData('p1', () => ({ id: 'p1', likes: 10, liked: false }))

  await expect(ctrl.like.run()).rejects.toThrow('500')
  expect(ctrl.post.data.value).toEqual({ id: 'p1', likes: 10, liked: false }) // rolled back

  ctrl.dispose()
})

// Driving an effect by mutating its tracked signal
test('debounced search refetches after delay', async () => {
  vi.useFakeTimers()
  const api = { search: vi.fn().mockResolvedValue([]) }
  const ctrl = createTestController(searchController, { deps: { api }, props: undefined })

  ctrl.query.set('foo')
  vi.advanceTimersByTime(300)
  await vi.runAllTimersAsync()

  expect(api.search).toHaveBeenCalledWith('foo')
  ctrl.dispose()
  vi.useRealTimers()
})
```

Patterns this exercises:
- **Mock at the boundary** — `api` and `session` are mocked services in `deps`, not modules. No `vi.mock(...)` needed.
- **Drive the controller by calling its methods** — exactly like calling a normal function. No render, no act.
- **Assert on signal `.value`** — synchronous, no waitFor.
- **Always `dispose()`** — clean teardown prevents cross-test bleed (cache entries surviving via gc, lingering subscribers). Use vitest's `afterEach` to enforce.

---

## 18. Non-goals

The following are deliberately out of scope. They aren't "we'll do them later" — they're not the kind of thing this design is for. (Ideas for additional optional packages live in `BACKLOG.md`; the items below are exclusions, not deferrals.)

- Async controller factories. Setup is always sync.
- A `command` primitive separate from mutations. Non-cache writes (analytics, navigation) go through `ctx.deps`.
- Framework-specific SSR helpers. `dehydrate`/`hydrate` is the boundary.
- Multi-framework adapters in core. `@kontsedal/olas-react` ships.
- **React Server Components (RSC).** Controllers rely on signals and client-side lifecycle. They run in the browser — wrap any RSC tree in client components before reaching Olas.
- **Built-in router.** Routing belongs in deps as a service (§16.5). Plug in `react-router`, TanStack Router, or your own.
- **Gesture / transient UI state.** State whose lifetime equals a single interaction (in-progress drag rectangle, hover, focus) belongs in components, not controllers. See §16.5.
- **Multi-item mutation orchestration.** The `Mutation` primitive tracks one logical operation. For "fire N mutations and track each result," compose them in a controller (§16.5).
- **Offline-first sync / mutation queueing.** No persistent outbox, no conflict-resolution layer in core. Mutations are best-effort against the network; if you need a queue-then-sync model (Notion, Linear), build it as a layer over `ctx.mutation` (queue locally, retry on reconnect) and persist via `@kontsedal/olas-persist`.

### 18.1 Entity normalization

When the same entity (a `Post`, a `User`) appears in many independent queries — `newsfeedQuery`, `userProfileQuery`, `searchQuery`, `notificationsQuery`, `commentsQuery` — updating that entity (e.g. liking the post) means patching every query that contains it. Olas core does **not** ship normalized storage; each query owns its own data.

Two equally-supported patterns:

**Userland helper (no extra dependency).** Write a small helper per entity that knows which queries it lives in. Verbose but explicit and grep-able:

```ts
const patchPostEverywhere = (id: string, patch: Partial<Post>) => {
  newsfeedQuery.setData('top-stories', (pages) => /* patch */)
  newsfeedQuery.setData('most-recent', (pages) => /* patch */)
  userProfileQuery.setData(authorId, (u) => /* patch */)
  // ... explicit list of touch sites
}
```

**`@kontsedal/olas-entities`.** A `QueryClientPlugin` that observes every cache write (via the `source: 'fetch' | 'set' | 'remote'` field on `SetDataEvent` — §13.2), walks the data via per-entity `idOf` predicates, maintains a normalized store, and exposes:

- `defineEntity<T>({ name, idOf })` — module-scope entity descriptor.
- `entitiesPlugin([Post, User, ...])` — install via `RootOptions.plugins[]`.
- `entities.signal(Post, id) → ReadSignal<Post | undefined>` — reactive per-id reads.
- `entities.update(Post, id, patchOrUpdater)` — accepts `Partial<T>` (shallow merge) or `(prev: T) => T` (updater). Backpropagates to every query holding the entity, batched into one round of subscriber notifications. Uses `QueryClientPluginApi.setEntryData` (§13.2) to write back.
- `entities.upsert / get / invalidate / entries / bindings` — round out the surface (last two are devtools snapshots).

```ts
const Post = defineEntity<Post>({ name: 'Post', idOf: (v: any) => v?.id ?? null })
createRoot(app, { plugins: [entitiesPlugin([Post])] })

// In a component:
const post = use(entities.signal(Post, 'p1'))   // reactive, normalized

// In a mutation handler — shallow merge:
entities.update(Post, 'p1', { liked: true })    // patches feedQuery, profileQuery, …

// Or compute the next value from the previous (non-shallow updates):
entities.update(Post, 'p1', (prev) => ({ ...prev, likes: prev.likes + 1 }))
```

Both patterns share the same core; neither is a framework. The userland helper is the right choice for ~5 queries and few entity types; the plugin scales further by removing the per-touch-site boilerplate. Infinite-query payloads aren't walked (mirrors the §13.2 cross-tab constraint).

Future-work ideas — additional packages, storage adapters, browser-extension devtools, cross-tab cache sync, normalization, lint rules — live in `BACKLOG.md`, not here. The spec describes what *is*.

---

# Part II — Implementation plan

## 19. Packages & build tooling

### 19.1 Monorepo

`pnpm` workspaces. One repo, multiple packages, shared TS config and tooling. Versioning via `changesets`.

### 19.2 Packages

| Package         | Purpose                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@kontsedal/olas-core`    | Everything: signals wrapper, controllers, ctx, lifecycle, caches, queries (incl. infinite), mutations, emitters, fields, forms, field arrays, validators, throttle/debounce, error handling, dehydrate/hydrate, devtools event bus. |
| `@kontsedal/olas-react`   | React adapter: `useController`, `use`, `useQuery`, root provider. Built on `useSyncExternalStore`.                                  |
| `@kontsedal/olas-persist` | `usePersisted` composable, localStorage adapter.                                                                                    |
| `@kontsedal/olas-zod`     | `zodValidator(schema)` and `formFromZod(ctx, schema)` — Zod schemas as the single source of truth for form types + validation.       |
| `@kontsedal/olas-devtools` | In-app `<DevtoolsPanel>` + floating launcher consuming `root.__debug` — controller tree inspector, cache timeline, mutation log. **Adoption-critical at scale; no longer optional.** |
| `@kontsedal/olas-cross-tab` | `BroadcastChannel`-backed `QueryClientPlugin` mirroring `setData` / `invalidate` writes across browser tabs. §13.2. |
| `@kontsedal/olas-realtime` | Composables over a consumer-supplied `RealtimeService` — `useRealtimePatcher` (WebSocket / SSE → cache patch) and `useLiveStream` (tail-buffer with capacity + coalesced flush). §16.5. |
| `@kontsedal/olas-entities` | `QueryClientPlugin` that walks query data via per-entity `idOf`, normalizes into a reactive per-id signal store, and backpropagates `entity.update(id, patch)` to every query holding the entity. §18.1. |

Vanilla "adapter" — no package needed. Signals already expose `.subscribe()` / `.peek()`.

### 19.3 Why one core package, not several

Splitting into `signals` / `runtime` / `query` / `forms` would give marginal bundle-size wins and real DX cost (more imports, version-sync issues, more changesets per release). Tree-shaking handles unused exports inside a single package. Estimated full-bundle size ~6–8 kb gzip with `@preact/signals-core` included.

### 19.4 Sub-path exports

Each published package ships from a single `src/index.ts` (§19.8). The only sub-path export today is `@kontsedal/olas-core/testing` (test-only helpers, kept grep-able). New sub-paths require both a `package.json#exports` entry and a `tsdown` entry so the type and runtime files are emitted under the same alias.

### 19.5 Build tooling

| Concern     | Choice                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Bundler     | **tsdown** — ESM+CJS+dts in one pass. Output `dist/{mjs,cjs,d.mts,d.cts}` per package.              |
| Test runner | **vitest** — ESM-first, vite ecosystem, expect-style API.                                           |
| Linter / formatter | **biome** — one Rust-based tool for lint + format.                                            |
| Versioning  | **changesets** — automated bumps + changelogs for monorepos.                                        |
| TypeScript  | strict mode, target ES2020, ESM module resolution. Shared `tsconfig.base.json` at repo root.        |
| Node        | `>= 18` (LTS).                                                                                      |
| CI          | GitHub Actions: install → typecheck → lint → test → build on every PR.                              |

### 19.6 Module format

Dual **ESM + CJS** via tsdown. ESM-only is cleaner ideologically but cuts off a chunk of users; the dual emission is one config line.

### 19.7 Peer dependencies

Declared explicitly so users dedupe correctly:

- `@kontsedal/olas-core` — peer: `@preact/signals-core ^1`.
- `@kontsedal/olas-react` — peer: `@kontsedal/olas-core ^1`, `react >= 18`.
- `@kontsedal/olas-persist` — peer: `@kontsedal/olas-core ^1`.
- `@kontsedal/olas-zod` — peer: `@kontsedal/olas-core ^1`, `zod ^3`.
- `@kontsedal/olas-cross-tab` — peer: `@kontsedal/olas-core ^1`.
- `@kontsedal/olas-realtime` — peer: `@kontsedal/olas-core ^1`.
- `@kontsedal/olas-entities` — peer: `@kontsedal/olas-core ^1`.

### 19.8 Public entry per package

Single `index.ts` entry per package, with one deliberate exception: `@kontsedal/olas-core/testing` exports `createTestController` and other test-only helpers. Splitting these into a sub-path makes "you imported testing utilities into production code" loud and grep-able.

### 19.9 Repo layout

```
olas/
  package.json                 # workspace root, private, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  biome.json
  .changeset/
  .github/workflows/ci.yml
  packages/
    core/
      src/
        index.ts               # single public entry
        signals/
        controller/
        query/                 # includes plugin.ts (QueryClientPlugin) and dehydrate/hydrate
        forms/
        timing/
        errors.ts
        devtools.ts
        testing.ts             # @kontsedal/olas-core/testing sub-path export
      tests/
      tsdown.config.ts
      tsconfig.json
      package.json
    react/                     # OlasProvider, useRoot/use/useQuery/useField, KeepAlive
    persist/                   # usePersisted + localStorage adapter
    zod/                       # zodValidator, formFromZod
    devtools/                  # in-app DevtoolsPanel + DevtoolsLauncher
    cross-tab/                 # BroadcastChannel-backed cache-sync QueryClientPlugin
    entities/                  # entity-normalization QueryClientPlugin
    realtime/                  # useRealtimePatcher + useLiveStream
  examples/
    kanban/                    # React + mutations + zod forms + devtools
    reader-ssr/                # React + SSR dehydrate/hydrate
    stock-ticker/              # vanilla TS, no UI framework
    virtualized-table/         # React + rows-are-data (§11.2) at 50k rows
  SPEC.md
  README.md
  LICENSE
```

---

## 20. Type-level API

The full public TypeScript surface. Internal types are not listed; anything in this section is exported from `@kontsedal/olas-core` (or `@kontsedal/olas-react` / `@kontsedal/olas-persist` where noted).

### 20.1 Signals

```ts
type ReadSignal<T> = {
  readonly value: T
  peek(): T
  subscribe(handler: (value: T) => void): () => void
}

type Signal<T> = ReadSignal<T> & {
  value: T // writable
  set(value: T): void
  update(fn: (prev: T) => T): void
}

type Computed<T> = ReadSignal<T>

function signal<T>(initial: T): Signal<T>
function computed<T>(fn: () => T): Computed<T>
function effect(fn: () => void | (() => void)): () => void // returns dispose
function batch<T>(fn: () => T): T // batched writes, single notification
function untracked<T>(fn: () => T): T // run fn outside the current tracking scope

function debounced<T>(source: ReadSignal<T>, ms: number): ReadSignal<T>
function throttled<T>(source: ReadSignal<T>, ms: number): ReadSignal<T>
```

`untracked(fn)` runs `fn` with auto-tracking suppressed — any signals read inside don't become dependencies of the surrounding `computed` or `effect`. Useful for "read these signals once to log them" or "read a snapshot of state inside an effect without subscribing to it." For a single-signal peek, prefer `signal.peek()`; `untracked` is for the multi-signal / nested-call case.

`Signal<T>` extends `ReadSignal<T>` — a `Signal` is assignable wherever a `ReadSignal` is expected, but not vice versa. This is what makes caches' `data: ReadSignal<T>` un-writable from the outside.

Standalone `effect()` is for use outside controllers (rare). Inside a controller use `ctx.effect()`, which is auto-disposed.

### 20.2 Controllers & `Ctx`

```ts
type Ctx<TDeps = AmbientDeps> = {
  // primitives
  cache<T>(
    fetcher: (signal: AbortSignal) => Promise<T>,
    options?: { key?: () => unknown[]; staleTime?: number; gcTime?: number; keepPreviousData?: boolean },
  ): LocalCache<T>

  use<const Args extends readonly unknown[], T>(
    source: Query<Args, T>,
    keyOrOptions?: (() => Args) | UseOptions<Args>,
  ): QuerySubscription<T>

  use<const Args extends readonly unknown[], TPage, TItem>(
    source: InfiniteQuery<Args, TPage, TItem>,
    keyOrOptions?: (() => Args) | UseOptions<Args>,
  ): InfiniteQuerySubscription<TPage, TItem>

  mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R>
  emitter<T = void>(): Emitter<T>
  field<T>(initial: T, validators?: Validator<T>[]): Field<T>
  form<S extends FormSchema>(schema: S, options?: FormOptions<S>): Form<S>
  fieldArray<I extends Field<any> | Form<any>>(
    itemFactory: (initial?: ItemInitial<I>) => I,
    options?: FieldArrayOptions<I>,
  ): FieldArray<I>

  child<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): Api

  attach<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): { api: Api; dispose: () => void }

  collection<Item, Props, Api>(
    spec: CollectionSpec<Item, Props, Api>,
  ): Collection<Item, Api>

  session<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): readonly [api: Api, dispose: () => void]

  lazyChild<Props, Api>(
    loader: () => Promise<ControllerDef<Props, Api> | { default: ControllerDef<Props, Api> }>,
    props: Props,
    options?: { deps?: Partial<TDeps>; autoLoad?: boolean },
  ): LazyChild<Api>

  effect(fn: () => void | (() => void)): void

  // event subscribe with auto-cleanup
  on<T>(emitter: Emitter<T>, handler: (value: T) => void): void

  // scopes (typed cross-tree data — see §10.3)
  provide<T>(scope: Scope<T>, value: T): void
  inject<T>(scope: Scope<T>): T

  // lifecycle
  onDispose(fn: () => void): void
  onSuspend(fn: () => void): void
  onResume(fn: () => void): void

  // DI
  deps: TDeps
}

type Scope<T> = {
  readonly __olas: 'scope'
  readonly default?: T
}

function defineScope<T>(options?: { default?: T; name?: string }): Scope<T>

type CollectionSpec<Item, Props, Api> =
  | {
      // Homogeneous form: one controller def for all items.
      controller: ControllerDef<Props, Api>
      source: ReadSignal<readonly Item[]>
      keyOf: (item: Item) => string | number
      propsOf: (item: Item) => Props
    }
  | {
      // Heterogeneous form: factory picks the controller def per item.
      // The factory runs once per new key, and again if the same key's item changes shape.
      source: ReadSignal<readonly Item[]>
      keyOf: (item: Item) => string | number
      factory: (item: Item) => { controller: ControllerDef<any, any>; props: any }
    }

type Collection<Item, Api> = {
  items: ReadSignal<ReadonlyArray<{ key: string | number; api: Api }>>
  size: ReadSignal<number>
  get(key: string | number): Api | undefined
  has(key: string | number): boolean
}

type LazyChild<Api> = {
  status: ReadSignal<'idle' | 'loading' | 'ready' | 'error'>
  api: ReadSignal<Api | undefined>
  error: ReadSignal<unknown | undefined>
  load(): Promise<Api>
  dispose(): void
}

type ControllerDef<Props, Api> = {
  readonly __olas: 'controller'
  readonly __types?: { props: Props; api: Api } // phantom for inference
}

function defineController<Props, Api>(
  factory: (ctx: Ctx, props: Props) => Api,
): ControllerDef<Props, Api>

// helpers to extract types from a ControllerDef (useful for fakes / tests)
type CtrlProps<C> = C extends ControllerDef<infer P, unknown> ? P : never
type CtrlApi<C> = C extends ControllerDef<unknown, infer A> ? A : never
```

`Api` is inferred from the factory's return type. `Props` is inferred from the second parameter. There are no decorators, no visibility annotations — the returned object **is** the public API.

`child()`'s third arg lets a subtree override deps for itself and descendants (`Partial<TDeps>` — only the keys being overridden).

### 20.3 Dependency injection

Two styles, pick one per project:

**Style A — ambient declaration merging (primary, recommended).**

```ts
// app/types.ts
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: ApiClient
    session: SessionStore
    logger: Logger
  }
}
```

Now every `Ctx` everywhere has `ctx.deps: { api, session, logger }`. No generics needed in controller signatures.

**Style B — explicit generic (for libraries / multiple roots with different deps).**

```ts
type AppCtx = Ctx<{ api: ApiClient; session: SessionStore }>

const userProfile = defineController<{ id: string }, UserProfileApi>((ctx: AppCtx, props) => {
  ctx.deps.api.getUser(props.id)
  // ...
})
```

The default `AmbientDeps` is `Record<string, unknown>` when no module augmentation is present — so untyped `ctx.deps.foo` doesn't error but isn't type-safe either.

### 20.4 Caches & Queries

```ts
type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

type AsyncState<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<AsyncStatus>
  isLoading: ReadSignal<boolean>
  isFetching: ReadSignal<boolean>
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean>

  refetch: () => Promise<T>
  reset: () => void               // clear error+status without fetching
  firstValue: () => Promise<T>    // resolves on first success
}

type Snapshot = {
  /** Restore the cache entry to its pre-`setData` value. Idempotent — once
   *  consumed (by `rollback` or `finalize`), subsequent calls are no-ops. */
  rollback: () => void
  /** Mark the optimistic update as committed: clears the entry's
   *  `hasPendingMutations` if no other snapshots remain live. Idempotent.
   *  The mutation runtime auto-calls this on success, mirroring the
   *  auto-`rollback` on error (spec §6.4). Consumers typically only call
   *  `rollback`; `finalize` is exposed for completeness. */
  finalize: () => void
}

// Local — anonymous, owned by one controller
type LocalCache<T> = AsyncState<T> & {
  invalidate(): void
  setData(updater: (prev: T | undefined) => T): Snapshot
  dispose(): void // idempotent; also called when controller disposes
}

// Query — module-scoped, sharable across the tree
type Query<Args extends unknown[], T> = {
  readonly __olas: 'query'
  invalidate(...args: Args): void
  invalidateAll(): void
  setData(...args: [...Args, updater: (prev: T | undefined) => T]): Snapshot
  prefetch(...args: Args): Promise<T>
}

type RetryPolicy = number | ((attempt: number, error: unknown) => boolean)
type RetryDelay = number | ((attempt: number) => number)

type QuerySpec<Args extends unknown[], T> = {
  key: (...args: Args) => unknown[]
  fetcher: (...args: [...Args, signal: AbortSignal]) => Promise<T>
  staleTime?: number
  gcTime?: number
  refetchInterval?: number
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
  keepPreviousData?: boolean // default false; see §5.2
  retry?: RetryPolicy        // default 0 (no retry)
  retryDelay?: RetryDelay    // default 1000
  queryId?: string           // stable identifier for cross-tab sync (§13.2)
  crossTab?: boolean         // opt into cross-tab cache sync (§13.2)
}

function defineQuery<Args extends unknown[], T>(
  spec: QuerySpec<Args, T>,
): Query<Args, T>

// subscription returned by ctx.use(...) — same shape regardless of source
type QuerySubscription<T> = AsyncState<T>

// Options form of ctx.use's second argument. The thunk form is shorthand for { key }.
type UseOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean  // tracking scope; when false, no fetch, status='idle'
}

// Infinite / paginated queries
type InfiniteQuerySpec<Args extends unknown[], PageParam, TPage, TItem = TPage> = {
  key: (...args: Args) => unknown[]
  fetcher: (
    pageCtx: { pageParam: PageParam; signal: AbortSignal },
    ...args: Args
  ) => Promise<TPage>
  initialPageParam: PageParam
  getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
  getPreviousPageParam?: (firstPage: TPage, allPages: TPage[]) => PageParam | null
  itemsOf?: (page: TPage) => TItem[] // for the .flat selector
  staleTime?: number
  gcTime?: number
  retry?: RetryPolicy
  retryDelay?: RetryDelay
  queryId?: string           // accepted on infinite queries; cross-tab plugin ignores them — see §13.2
  crossTab?: boolean         // accepted on infinite queries; cross-tab plugin filters them out — see §13.2
}

type InfiniteQuery<Args extends unknown[], TPage, TItem> = {
  readonly __olas: 'infiniteQuery'
  invalidate(...args: Args): void
  invalidateAll(): void
  setData(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): Snapshot
  prefetch(...args: Args): Promise<TPage>
}

type InfiniteQuerySubscription<TPage, TItem> = AsyncState<TPage[]> & {
  pages: ReadSignal<TPage[]>
  flat: ReadSignal<TItem[]>
  hasNextPage: ReadSignal<boolean>
  hasPreviousPage: ReadSignal<boolean>
  isFetchingNextPage: ReadSignal<boolean>
  isFetchingPreviousPage: ReadSignal<boolean>
  fetchNextPage: () => Promise<void>
  fetchPreviousPage: () => Promise<void>
}

function defineInfiniteQuery<Args extends unknown[], PageParam, TPage, TItem = TPage>(
  spec: InfiniteQuerySpec<Args, PageParam, TPage, TItem>,
): InfiniteQuery<Args, TPage, TItem>
```

The `__olas` brand tag is purely for clarity in error messages and devtools.

### 20.5 Mutations

```ts
type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'

type MutationSpec<V, R> = {
  mutate: (vars: V, signal: AbortSignal) => Promise<R>
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (
    err: unknown,
    vars: V,
    snapshot: Snapshot | undefined,
  ) => void
  onSettled?: (
    result: R | undefined,
    err: unknown | undefined,
    vars: V,
  ) => void
  concurrency?: MutationConcurrency // default: 'parallel'
  retry?: RetryPolicy               // default 0 (no retry for mutations — they're intentional)
  retryDelay?: RetryDelay
}

type Mutation<V, R> = {
  /**
   * Trigger a run. The signature uses a variadic tuple so:
   *  - `V extends void` → no args. `mutation.run()`
   *  - `V` defaulted to `unknown` (no constraint) → optional arg.
   *  - otherwise → required arg. `mutation.run(vars)`
   * Internally typed as `MutationRun<V, R>`; users see the natural shape.
   */
  run: MutationRun<V, R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  lastVariables: ReadSignal<V | undefined>
  reset(): void
  dispose(): void // idempotent; aborts in-flight; also called when controller disposes
}

type MutationRun<V, R> = (
  ...args: unknown extends V ? [V?] : [V] extends [void] ? [] : [V]
) => Promise<R>
```

The `Snapshot` type is shared with caches' `setData` — a snapshot from `userQuery.setData(...)` plugs into `onMutate`'s return naturally.

### 20.6 Emitters

```ts
type Emitter<T> = {
  emit: T extends void ? () => void : (value: T) => void
  on(handler: (value: T) => void): () => void
  once(handler: (value: T) => void): () => void
  dispose(): void // idempotent; drops all handlers
}

// standalone — for emitters that live outside any controller (e.g. in deps)
function createEmitter<T = void>(): Emitter<T>
```

The conditional on `emit` means `ctx.emitter<void>()` gives you `emit()` (no arg), while `ctx.emitter<{ id: string }>()` gives you `emit({ id })`.

`createEmitter` has the same shape as `ctx.emitter` but no controller binding — handlers registered via `.on()` are kept until they're explicitly unsubscribed (or the emitter itself is GC'd). Use this for emitters in `deps`; use `ctx.emitter` for emitters owned by a controller.

### 20.7 Fields, forms & validators

```ts
type Validator<T> = (
  value: T,
  signal: AbortSignal,
) => string | null | Promise<string | null>

type Field<T> = ReadSignal<T> & {
  errors: ReadSignal<string[]>
  isValid: ReadSignal<boolean>
  isDirty: ReadSignal<boolean>
  touched: ReadSignal<boolean>
  isValidating: ReadSignal<boolean>

  set(value: T): void
  reset(): void
  markTouched(): void
  revalidate(): Promise<boolean>
  dispose(): void // idempotent; aborts pending validators; also called when controller disposes
}

// helper for async server-side validation with debounce
function debouncedValidator<T>(
  fn: (value: T, signal: AbortSignal) => Promise<string | null>,
  ms: number,
): Validator<T>

// Schema and Form types — heavy recursive inference, but TypeScript handles it
type FormSchema = { [key: string]: Field<any> | Form<any> | FieldArray<any> }

type FormValue<S extends FormSchema> = {
  [K in keyof S]:
    S[K] extends Field<infer T> ? T
  : S[K] extends Form<infer SS> ? FormValue<SS>
  : S[K] extends FieldArray<infer I> ? FieldArrayValue<I>
  : never
}

type FormErrors<S extends FormSchema> = {
  [K in keyof S]?:
    S[K] extends Field<any> ? string[] | undefined
  : S[K] extends Form<infer SS> ? FormErrors<SS>
  : S[K] extends FieldArray<infer I> ? Array<FieldArrayItemErrors<I> | undefined>
  : never
}

type FormValidator<S extends FormSchema> = (
  value: FormValue<S>,
  signal: AbortSignal,
) => string | null | Promise<string | null>

type FormOptions<S extends FormSchema> = {
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  resetOnInitialChange?: boolean // default: true (only when form is not dirty)
  validators?: FormValidator<S>[] // form-level (cross-field) validators
}

type Form<S extends FormSchema> = {
  fields: { [K in keyof S]: S[K] }
  value: ReadSignal<FormValue<S>>
  errors: ReadSignal<FormErrors<S>>     // per-field errors (mirrors schema shape)
  topLevelErrors: ReadSignal<string[]>      // form-level (cross-field) validator output
  flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>
  isValid: ReadSignal<boolean>          // all leaves valid AND topLevelErrors empty
  isDirty: ReadSignal<boolean>
  touched: ReadSignal<boolean>
  isValidating: ReadSignal<boolean>

  set(partial: DeepPartial<FormValue<S>>): void // batched
  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>

  // Nested access only: `form.fields.a.fields.b.fields.c`. Path-typed
  // `form.fieldAt('a.b.c')` is not provided.

  dispose(): void // idempotent; disposes all leaf fields/sub-forms/field-arrays
}

type FieldArrayValue<I> =
  I extends Field<infer T> ? T[]
: I extends Form<infer S> ? FormValue<S>[]
: never

type FieldArrayItemErrors<I> =
  I extends Field<any> ? string[]
: I extends Form<infer S> ? FormErrors<S>
: never

type ItemInitial<I> =
  I extends Field<infer T> ? T
: I extends Form<infer S> ? DeepPartial<FormValue<S>>
: never

type FieldArrayValidator<I> = (
  items: FieldArrayValue<I>,
  signal: AbortSignal,
) => string | null | Promise<string | null>

type FieldArrayOptions<I> = {
  initial?: ItemInitial<I>[]
  validators?: FieldArrayValidator<I>[] // array-level (whole-collection) validators
}

type FieldArray<I extends Field<any> | Form<any>> = {
  items: ReadSignal<ReadonlyArray<I>>
  value: ReadSignal<FieldArrayValue<I>>
  errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  topLevelErrors: ReadSignal<string[]>  // array-level validator output
  isValid: ReadSignal<boolean>
  isDirty: ReadSignal<boolean>
  touched: ReadSignal<boolean>
  isValidating: ReadSignal<boolean>
  size: ReadSignal<number>

  add(initial?: ItemInitial<I>): void
  insert(index: number, initial?: ItemInitial<I>): void
  remove(index: number): void
  move(from: number, to: number): void
  at(index: number): I | undefined
  clear(): void

  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>
  dispose(): void // idempotent; disposes all items
}

type DeepPartial<T> = T extends object
  ? T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : { [K in keyof T]?: DeepPartial<T[K]> }
  : T
```

`Field<T>` *is* a `ReadSignal<T>` — `use(field)` in the UI works, `field.value` reads, `field.set(x)` writes. Direct `.value = ...` is not exposed; writes must go through `set` so dirty / touched / validation update.

Nested field access is via the `form.fields.address.fields.city`-style path. Path-typed lookup (`form.fieldAt('address.city')`) is not part of the API — the template-literal-type machinery is implementation-heavy and the nested access covers ~95% of cases.

### 20.8 Root & options

```ts
type Root<Api> = Api & {
  dispose(): void
  suspend(options?: { maxIdle?: number }): void
  resume(): void
  dehydrate(): DehydratedState
  waitForIdle(): Promise<void>
  readonly __debug: {
    subscribe(handler: (event: DebugEvent) => void): () => void
  }
}

type RootOptions<TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  hydrate?: DehydratedState
  /** Default for queries that don't set `refetchOnWindowFocus` on their spec (§5.9). */
  refetchOnWindowFocus?: boolean
  /** Default for queries that don't set `refetchOnReconnect` on their spec (§5.9). */
  refetchOnReconnect?: boolean
  /** Query-client plugins — cross-tab sync, server-push patches, etc. (§13.2). */
  plugins?: QueryClientPlugin[]
}

type QueryClientPlugin = {
  /** Called once after the QueryClient is constructed. */
  init?(api: QueryClientPluginApi): void
  onSetData?(event: SetDataEvent): void
  onInvalidate?(event: InvalidateEvent): void
  onGc?(event: GcEvent): void
  /** Called from QueryClient.dispose. */
  dispose?(): void
}

type QueryClientPluginApi = {
  /**
   * Apply a remote snapshot. The plugin's own `onSetData` IS fired for the
   * resulting write — but with `isRemote: true` so plugins skip rebroadcast.
   */
  applyRemoteSetData(queryId: string, keyArgs: readonly unknown[], data: unknown): void
  applyRemoteInvalidate(queryId: string, keyArgs: readonly unknown[]): void
  subscribedKeys(queryId: string): readonly (readonly unknown[])[]
}

type SetDataEvent = {
  queryId: string
  keyArgs: readonly unknown[]
  data: unknown
  kind: 'data' | 'infinite'
  isRemote: boolean
}

type InvalidateEvent = {
  queryId: string
  keyArgs: readonly unknown[]
  kind: 'data' | 'infinite'
  isRemote: boolean
}

type GcEvent = {
  queryId: string
  keyArgs: readonly unknown[]
  kind: 'data' | 'infinite'
}

function createRoot<Api, TDeps = AmbientDeps>(
  def: ControllerDef<void, Api>,
  options: RootOptions<TDeps>,
): Root<Api>
```

`Root<Api>` is the controller's public API plus the lifecycle/SSR/devtools controls. Root controllers take no props (`ControllerDef<void, Api>`) — any startup config goes in `deps`.

### 20.9 Errors & devtools

```ts
type ErrorContext = {
  kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'
  controllerPath: readonly string[]
  queryKey?: readonly unknown[]
}

type DebugEvent =
  | { type: 'controller:constructed'; path: readonly string[]; props: unknown }
  | { type: 'controller:suspended'; path: readonly string[] }
  | { type: 'controller:resumed'; path: readonly string[] }
  | { type: 'controller:disposed'; path: readonly string[] }
  | { type: 'cache:subscribed'; queryKey: readonly unknown[]; subscriberPath: readonly string[] }
  | { type: 'cache:fetch-start'; queryKey: readonly unknown[] }
  | { type: 'cache:fetch-success'; queryKey: readonly unknown[]; durationMs: number }
  | { type: 'cache:fetch-error'; queryKey: readonly unknown[]; error: unknown; durationMs: number }
  | { type: 'cache:invalidated'; queryKey: readonly unknown[] }
  | { type: 'cache:gc'; queryKey: readonly unknown[] }
  | { type: 'mutation:run'; path: readonly string[]; vars: unknown }
  | { type: 'mutation:success'; path: readonly string[]; result: unknown }
  | { type: 'mutation:error'; path: readonly string[]; error: unknown }
  | { type: 'mutation:rollback'; path: readonly string[] }
  | { type: 'field:validated'; path: readonly string[]; field: string; valid: boolean; errors: string[] }
```

Discriminated union keyed by `type` — devtools consumers `switch` on it. Adding new event variants is non-breaking; consumers ignore unknown types.

> Production note: emission sites are elided from the production build of
> `@kontsedal/olas-core` — see §23 *Devtools / `__debug` and production builds*.
> Subscribers attach but receive no events.

```ts
type DehydratedState = {
  version: 1
  entries: Array<{
    key: readonly unknown[]
    data: unknown
    lastUpdatedAt: number
  }>
}
```

Versioned so future changes are detectable.

### 20.10 React adapter (`@kontsedal/olas-react`)

```ts
function useRoot<Api = unknown>(): Api // resolves the root from <OlasProvider>
function useController<Api>(root: Root<Api>): Api // back-compat alias for useRoot — takes root explicitly

function use<T>(signal: ReadSignal<T>): T

// convenience: unwraps an AsyncState<T> into plain values in one subscribe call
function useQuery<T>(subscription: AsyncState<T>): {
  data: T | undefined
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
}

// convenience: unwraps a Field<T> into plain values + binders
function useField<T>(field: Field<T>): {
  value: T
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
  set: (value: T) => void
  reset: () => void
  markTouched: () => void
  revalidate: () => Promise<boolean>
}

// opt-in suspension wrappers
function KeepAlive(props: { controller: { suspend(): void; resume(): void }; children: ReactNode }): JSX.Element
function useSuspendOnHidden(controller: { suspend(): void; resume(): void }): void
```

The root is created once (typically in `main.tsx`) and shared via context. Inside the provider:

```ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): JSX.Element
```

`useRoot()` resolves the root from context. `useController(root)` is the older form that takes the root explicitly — retained for back-compat and tests where context isn't available.

`useQuery(subscription)` batches all signals in an `AsyncState<T>` into one `useSyncExternalStore` subscription — one re-render trigger per change, not seven.

`useField(field)` does the same for `Field<T>` — three subscribes become one, plus you get the methods on the same object so binding to an input is a single destructure:

```tsx
function TextInput({ field, label }: { field: Field<string>; label: string }) {
  const { value, errors, touched, set, markTouched } = useField(field)
  return (
    <label>
      {label}
      <input value={value} onChange={(e) => set(e.target.value)} onBlur={markTouched} />
      {touched && errors[0] && <span className="err">{errors[0]}</span>}
    </label>
  )
}
```

**Suspension helpers.** Default React behavior is "unmount means dispose" (the root lives on; sub-controllers are owned by their parent and not torn down by React). For UI-driven suspension (hidden tabs, router caches), use:

- `<KeepAlive controller={ctrl}>` — calls `ctrl.suspend()` on unmount and `ctrl.resume()` on remount instead of disposing. Useful when a controller wraps a sub-tree.
- `useSuspendOnHidden(ctrl)` — auto-suspends when the tab becomes hidden via `document.visibilityState`. Resumes on visible.

Without these, you call `ctrl.suspend()` / `ctrl.resume()` yourself; the adapter doesn't drive lifecycle implicitly.

**`useField` fake helper.** For UI tests, `@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides)` that produce shape-correct fakes:

```tsx
import { fakeField, fakeAsyncState } from '@kontsedal/olas-core/testing'

const fakeProfile = {
  user: fakeAsyncState({ data: { id: 'x', name: 'Fake' } }),
  draft: fakeField('hello'),
  save: { run: vi.fn(), isPending: signal(false), error: signal(undefined), /* ... */ },
}
render(<UserProfileView profile={fakeProfile} />)
```

These return objects whose signals satisfy the real types so TypeScript accepts them as drop-in substitutes.

### 20.11 Persistence adapter (`@kontsedal/olas-persist`)

```ts
type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  // optional change notifications (e.g. localStorage 'storage' event)
  onChange?(handler: (key: string, value: string | null) => void): () => void
}

type PersistOptions<T> = {
  storage?: StorageAdapter // default: localStorage adapter
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  crossTab?: boolean // requires storage.onChange
}

type Persisted<T> = {
  ready: ReadSignal<boolean> // true once initial load is complete
}

// structural interface accepted by usePersisted —
// satisfied by Signal<T>, Field<T>, or any custom read/write/subscribe trio.
type PersistableSource<T> = {
  readonly value: T
  set(value: T): void
  subscribe(handler: (value: T) => void): () => void
}

function usePersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: PersistOptions<T>,
): Persisted<T>
```

### 20.12 Miscellaneous exports

```ts
// from @kontsedal/olas-core
function isAbortError(err: unknown): boolean
// — true iff err is a DOMException with name === 'AbortError'.
//   Used to filter superseded latest-wins mutations and aborted fetches.

function createEmitter<T = void>(): Emitter<T>
// — see §20.6

type Selection<T = unknown> = {
  selectedIds: ReadSignal<ReadonlySet<string>>
  size: ReadSignal<number>
  isSelected(id: string): ReadSignal<boolean>
  select(id: string): void
  deselect(id: string): void
  toggle(id: string): void
  clear(): void
  selectAll(ids: readonly string[]): void
  handleClick(
    id: string,
    mods: { shift?: boolean; meta?: boolean },
    ordered: readonly string[],
  ): void
}
function selection<T = unknown>(options?: { initial?: readonly string[] }): Selection<T>
// — multi-select with shift/meta-click range semantics; see §16.5

// from @kontsedal/olas-core/testing  (sub-entry exception: testing is the one sub-path we ship)
function createTestController<Props, Api, TDeps = AmbientDeps>(
  def: ControllerDef<Props, Api>,
  options: {
    deps: TDeps
    props: Props
    onError?: (err: unknown, ctx: ErrorContext) => void
  },
): Root<Api>
// — constructs an isolated root wrapping a single controller. Returns its API
//   plus the standard Root lifecycle controls (dispose / suspend / resume).
//   Equivalent to defining a tiny root wrapper, but ergonomic in tests.
```

The testing helper is the **only** sub-path export we ship (`@kontsedal/olas-core/testing`). It's separated because importing it in production builds is a smell — tree-shakers should drop it, but a sub-path makes the separation explicit.

---

## 21. Internal architecture

This section describes how `@kontsedal/olas-core` is organized internally. None of these types are exported — they're implementation detail. Listed here so contributors (and devtools) know the boundaries.

### 21.1 Modules

```
src/
  signals/
    index.ts             # public: signal, computed, effect, batch, types
    runtime.ts           # wraps @preact/signals-core
    readonly.ts          # readOnly(signal) — internal projection helper
  controller/
    define.ts            # defineController()
    root.ts              # createRoot()
    instance.ts          # ControllerInstance class
    ctx.ts               # Ctx implementation (returns object given an instance)
  query/
    client.ts            # QueryClient: registry of entries, subscribe/gc
    entry.ts             # Entry: per-key state machine + signals
    define.ts            # defineQuery() + Query value
    param.ts             # ParamCache implementation (thin wrapper over Entry)
    local.ts             # LocalCache: anonymous Entry tied to a controller
    mutation.ts          # Mutation: concurrency, snapshot stack
    keys.ts              # key serialization (stable hash for Map lookup)
  forms/
    field.ts             # Field + validator runner
    validators.ts        # required, minLength, email, etc. (stdlib)
  timing/
    debounced.ts
    throttled.ts
  emitter.ts             # Emitter implementation
  errors.ts              # ErrorContext, root error dispatcher
  devtools.ts            # DebugEvent emitter
  ssr.ts                 # dehydrate/hydrate, waitForIdle
  index.ts               # public entry — re-exports
```

### 21.2 Module responsibilities

| Module             | Owns                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `signals/`         | Reactive primitives. Single source of truth for `Signal` / `ReadSignal` / `Computed`. |
| `controller/`      | The lifecycle: construction, suspension, disposal. Owns `Ctx` shape and `child()` semantics. |
| `query/client.ts`  | Per-root entry registry. Subscribe/unsubscribe semantics, GC timers, invalidation routing. |
| `query/entry.ts`   | One cache entry's state machine. Owns the AsyncState signals and the fetch-id race protection. |
| `query/define.ts`  | `defineQuery` and the `Query` value. Holds a `WeakMap<QueryClient, EntryRef>` for cross-root operation. |
| `query/mutation.ts`| Mutation execution: concurrency modes (parallel / latest-wins / serial), snapshot stack for rollback. |
| `forms/`           | Field state and validator orchestration (sync + async, debouncing pending validators). |
| `timing/`          | Pure signal projections — no controller knowledge, no lifecycle hooks. |
| `emitter.ts`       | Just a `Set<Handler>`. No imports from anything. |
| `errors.ts`        | Type definitions + a tiny dispatch function. Used by controller and query. |
| `devtools.ts`      | Per-root debug-event multiplexer. Subscribed to by users via `root.__debug`. |
| `ssr.ts`           | Walks the query client and serializes entries; replays on hydrate. Uses `waitForIdle()` on the client. |

### 21.3 Dependency direction

```
                     ┌──────────────┐
                     │   signals/   │  (no deps)
                     └──────┬───────┘
            ┌───────────────┼───────────────────┐
            ▼               ▼                   ▼
        timing/         forms/             query/entry.ts
            │               │                   ▲
            │               │                   │
            │               │              query/client.ts ◄── devtools.ts
            │               │                   ▲                   ▲
            │               │                   │                   │
            └───────────────┴─►  controller/ ───┘                   │
                                     │                              │
                                     └──── errors.ts ───────────────┘
                                     │
                                     └──── emitter.ts (used by ctx)

query/define.ts  ─►  query/client.ts   (Query values look up clients)
query/mutation.ts ─► query/entry.ts    (mutations call setData on entries)
ssr.ts ─► query/client.ts
```

Rules:

- **`query/*` does not import `controller/`.** The query client only knows about abstract subscribers (objects with `notify()` and `dispose()`). The controller container is the one that creates subscriber objects when `ctx.use(...)` or `ctx.cache(...)` runs.
- **`controller/` may import `query/`.** The `Ctx` factory needs to construct caches and subscriptions.
- **`signals/` imports nothing else.** Swappable runtime.
- **`emitter.ts` imports nothing.** Pure data structure.
- **`devtools.ts` is a sink.** Other modules push to it; it doesn't pull.

### 21.4 Runtime objects: who holds what

A live `Root` consists of:

```
Root
├── QueryClient            (one per root)
├── DevtoolsEmitter        (one per root)
├── onError handler        (one per root, default console.error)
├── deps                   (immutable per root)
└── rootController: ControllerInstance
        ├── parent: null
        ├── children: ControllerInstance[]
        ├── effects: Disposable[]
        ├── caches: Entry[]                   (anonymous local caches)
        ├── subscriptions: Subscription[]     (from ctx.use(...))
        ├── mutations: Mutation[]
        ├── emitters: Emitter[]
        ├── fields: Field[]
        ├── onDispose/onSuspend/onResume: (()=>void)[]
        └── path: ['root']
```

Each child `ControllerInstance` inherits a *reference* to the root's `QueryClient`, `DevtoolsEmitter`, and `onError` — passed in at construction. Deps are merged from parent + override and stored on the instance.

### 21.5 The query-client / query-value binding

Queries are defined at module scope (`export const userQuery = defineQuery(...)`). They predate any root. A `Query` object internally holds:

```ts
class QueryValue<Args, T> {
  readonly spec: QuerySpec<Args, T>
  // one EntryRegistry per QueryClient that has ever touched this query
  private readonly clients = new WeakMap<QueryClient, EntryRegistry<Args, T>>()

  bindTo(client: QueryClient): EntryRegistry<Args, T> { /* lazy create */ }

  invalidate(...args: Args): void {
    // iterate all known clients (we track them in a WeakSet on top of the map)
    for (const client of this.activeClients) client.invalidate(this, args)
  }
}
```

Iterating "all known clients" requires we keep a `WeakRef` list (since WeakMap isn't iterable). Implementation detail; the point is: a query value works correctly across multiple roots (e.g. test isolation, SSR + client) without leaking, and `invalidate()` reaches every relevant client.

For single-root apps (the common case), there's exactly one active client and this is trivial.

### 21.6 Cache entry state machine

Each `Entry<T>` holds:

```ts
class Entry<T> {
  data: Signal<T | undefined>
  error: Signal<unknown | undefined>
  status: Signal<AsyncStatus>
  isLoading: Signal<boolean>
  isFetching: Signal<boolean>
  isStale: Signal<boolean>
  lastUpdatedAt: Signal<number | undefined>

  private subscribers = 0
  private currentFetchId = 0     // monotonic, latest-wins
  private currentAbort: AbortController | null = null
  private gcTimer: number | null = null

  subscribe(subscriber: Subscription): () => void { ... }
  refetch(): Promise<T> { ... }
  invalidate(): void { ... }
  setData(updater): Snapshot { ... }
  private startFetch(): void {
    this.currentFetchId += 1
    const myId = this.currentFetchId
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort
    this.spec.fetcher(...args, abort.signal).then(
      (result) => {
        if (myId !== this.currentFetchId) return  // race protection
        // apply result
      },
      (err) => {
        if (myId !== this.currentFetchId) return  // race protection
        // apply error
      },
    )
  }
}
```

The `currentFetchId` counter is how §5.6 (race protection) is implemented — stale results check their id against the latest before writing.

### 21.7 Mutation runner

```ts
class MutationRunner<V, R> {
  private inflight = new Set<{ id: number; abort: AbortController; snapshot?: Snapshot }>()
  private nextId = 0
  private serialQueue: Array<{ vars: V; resolve; reject }> = []

  async run(vars: V): Promise<R> {
    switch (this.spec.concurrency ?? 'parallel') {
      case 'parallel': return this.runParallel(vars)
      case 'latest-wins': return this.runLatestWins(vars)  // aborts inflight
      case 'serial': return this.runSerial(vars)           // queues
    }
  }
}
```

The snapshot stack for rollback is just `Array<{ id, snapshot }>` ordered by application time. On rollback, only the failed mutation's snapshot is invoked. Snapshots themselves close over the pre-update value of any caches they touched.

### 21.8 Devtools event flow

Every controller, query client, and mutation runner gets a reference to the root's `DevtoolsEmitter`. Events are emitted synchronously at relevant points (no batching). The emitter is just `Set<(event: DebugEvent) => void>`.

Users opt in via `root.__debug.subscribe(handler)`. With no subscribers, the emitter calls are roughly free (one Set size check).

### 21.9 SSR flow

```ts
// dehydrate (server)
root.dehydrate(): DehydratedState
// iterates queryClient.entries, picks the ones with data, serializes

// hydrate (client)
createRoot(def, { hydrate: state })
// when QueryClient initializes, replays entries: data, status='success', lastUpdatedAt
// no fetches kicked off until subscribers arrive (then staleTime applies)
```

`waitForIdle()` is a promise that resolves when:
- `queryClient.inflightCount === 0`
- `mutations.inflightCount === 0` (across all controllers — root keeps a count)

Implementation: a signal `idleCount` that increments/decrements; `waitForIdle` resolves when it hits zero. Re-entrant: starts a new fetch *after* `waitForIdle` resolves doesn't retroactively block; intentional.

---

## 23. Performance characteristics

Honest estimates so users know what they're paying for. All numbers are order-of-magnitude — actual perf depends on platform, payload size, and usage pattern.

### Bundle size

| Package | Minified + gzipped | Notes |
|---|---|---|
| `@kontsedal/olas-core` | **~10–14 kB** | Includes signals (preact-signals: ~1 kB), controllers, query client, mutations, forms (the biggest piece), scopes, errors, devtools event bus, SSR. |
| `@kontsedal/olas-react` | **~1–2 kB** | Thin wrapper over `useSyncExternalStore`. |
| `@kontsedal/olas-persist` | **~1 kB** | localStorage adapter + composable. |
| `@kontsedal/olas-zod` | **~2 kB + your Zod** | Adapter only; Zod itself is ~13 kB. |

For a "kitchen sink" app: `core + react + persist + zod = ~15 kB + Zod = ~28 kB` over the wire. Comparable to TanStack Query (~13 kB) + react-hook-form (~10 kB) + Zod (~13 kB) = ~36 kB.

Tree-shaking removes unused parts of core: if you don't use `defineInfiniteQuery`, the infinite-query machinery is dropped (~2 kB saved). Forms are the largest single category (~4 kB) and are dropped if no controller calls `ctx.form`, `ctx.field`, or `ctx.fieldArray`.

### Per-primitive overhead

| Primitive | Approx allocation | Approx signals |
|---|---|---|
| `ControllerInstance` | ~500 B base + children/effects/caches arrays | 0 |
| `signal()` | ~80 B + boxed value | 1 |
| `computed()` | ~120 B + dep-tracking node | 1 |
| `effect()` | ~150 B + dep-tracking + closure | 0 (it consumes signals) |
| `ctx.cache()` | ~400 B (Entry state machine) | 8 |
| `ctx.use(query)` | ~80 B (subscription record) | 0 (shares Entry's signals) |
| `ctx.mutation()` | ~250 B (runner) | 4 |
| `ctx.field()` | ~300 B | 6 |
| `ctx.form({ a, b, c })` | ~500 B + leaf cost | 6 + child signals (computed) |
| `ctx.emitter()` | ~100 B + handlers Set | 0 |

These add up. A controller with 5 fields, 2 mutations, and 3 cache subscriptions is roughly `500 + 5×300 + 2×250 + 3×80 = 2,740 B` plus ~40 signals. For 1,000 such controllers, that's ~3 MB and 40,000 signals — workable but not free. **Per §11.2, prefer plain signals/maps for high-cardinality homogeneous items.**

### "How many controllers is too many?"

- **Under 100:** never a concern.
- **100–1,000:** fine, but profile if you mount/unmount frequently.
- **1,000–10,000:** consider reducing — use a `ctx.collection` with per-item controllers only if each item genuinely has its own logic; otherwise model items as data inside a parent.
- **10,000+:** almost certainly the wrong tool. The `cells` pattern (per-key signal in a Map) is what you want.

### Reactivity costs

- Signal write notifies subscribers synchronously. With N subscribers and no batching, a write does O(N) work. Use `batch(() => ...)` when writing many signals in one logical step — subscribers re-run once after the batch instead of N times.
- `computed` only recomputes when read after at least one of its dependencies changed; otherwise it returns its memoized value. Reading a `computed` is O(1) in the steady state.
- `effect`s run synchronously at write time (after batching). An effect that reads a signal and writes another can cascade; cycle detection is in the runtime, but you should avoid the pattern.

### `structuredClone` vs Immer

For `setData` updates on nested data:
- `structuredClone(prev)`: O(*total nodes*). Fine for trees up to ~1,000 nodes; visible stutter above ~10,000 nodes per update.
- Immer's `produce`: O(*touched path*). 10–100× faster on real workloads where you mutate a tiny fraction of the tree.

Recommendation in §5.7: use Immer for any non-trivial nested update.

### Query client GC

- Default `gcTime: 5 * 60_000` (5 min). After the last subscriber leaves, the entry stays for this long before being dropped.
- For long-running apps with many unique queries, configure shorter `gcTime` on bulky queries to bound memory.
- Subscribed entries are never gc'd. Suspended (not disposed) controllers count as subscribed — see §4.1.

### Devtools events

- `__debug.subscribe(handler)` makes the per-event cost roughly free when no one is listening (one Set size check, < 100 ns).
- With one subscriber, expect ~1–5 µs per event (allocation of the event object + handler invocation).
- For a noisy controller (many cache events / sec), this matters. Use the devtools subscription only in dev, not in prod.

### Form perf

- `form.value` is one big `computed` reading every leaf. Re-derives only when *some* leaf changes. UI subscribing to `form.value` re-renders on any change to anything — typically the wrong thing to do; subscribe to specific fields via `useField(form.fields.x)`.
- `form.set(partial)` batches its leaf writes (one notification pass).
- Validators run in tracking scopes; their dependency on other signals is automatic but they re-run whenever those signals change, which can be more often than expected for cross-field validators.

### Devtools / `__debug` and production builds

`@kontsedal/olas-core` ships two builds, gated by `process.env.NODE_ENV` at bundle time.
In the production build, every `bus.emit(...)` site inside core is removed
(tsdown `define: { __DEV__: 'false' }` + dead-code elimination). The
substitution covers all sibling packages too (`@kontsedal/olas-persist`, `@kontsedal/olas-zod`,
`@kontsedal/olas-react`, `@kontsedal/olas-realtime`, `@kontsedal/olas-devtools`), though emission lives
only in core today.

What this means for consumers:

- `root.__debug.subscribe(handler)` still exists and accepts the handler, but
  the handler will never be called in a production build. The snapshot replay
  (live controllers at subscribe time) is also empty, because the
  `controller:constructed` and `controller:suspended/resumed/disposed`
  emission sites that feed the `DevtoolsEmitter`'s `liveControllers` map are
  inside the same guard — the bus's internal snapshot machinery is inert.
- `root.__debug.queryEntries()` still returns the live cache inspector
  snapshot — that data path doesn't depend on emission and remains useful for
  in-prod cache introspection.
- `@kontsedal/olas-devtools` is a dev-time tool. Mounting `DevtoolsPanel` against a
  production build of core renders an empty tree.

The substitution is keyed on `process.env.NODE_ENV !== 'production'` at the
moment tsdown runs. Consumers do not need to define `__DEV__` themselves — it
is already inlined into the published `.mjs` / `.cjs` artefacts. To produce a
dev-flavoured build of the workspace, use the root `build:dev` script (no
`NODE_ENV` prefix) instead of `build`.
