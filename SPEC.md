# Olas — Specification

Olas enforces a strict separation: **all business logic lives in a tree of pure TypeScript controllers; the UI is a thin renderer that subscribes to them.**

This isn't a stylistic preference. It's the architectural principle the whole library is designed around, and it shapes every decision in this spec.

## What "all business logic" means concretely

Everything that decides *what happens* belongs in a controller:

- **Data fetching and caching** — every API call, every `fetch`, every WebSocket subscription. The UI never calls the network.
- **State** — both server-derived, meaning cached responses, and client-local: filters, drafts, open and closed flags, selected items, the current step in a wizard. All of it.
- **Mutations** — every write to the server, with optimistic updates, rollback, and invalidation.
- **Events** — domain events (`'note saved'`, `'user invited'`) that other parts of the app react to.
- **Validation** — form rules, business invariants, async server-side checks (username taken, etc.).
- **Derived data** — anything computed from server or client state.
- **Workflow and orchestration** — multi-step flows, navigation triggers, conditional logic, "after X happens, do Y."

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
4. **You can swap frameworks by swapping a thin adapter** — the React, Vue or Svelte adapter is the only code that knows about the UI framework (§16). Everything else is pure TS and runs anywhere.

## Why this is worth the rules

The common shape of a serious browser app today is a sprawl. Hooks hold state, effects mutate that state, components call APIs, contexts thread through render trees, and custom stores are glued to query libraries glued to form libraries. The "logic" ends up everywhere. It is observable only by rendering, testable only by simulating a DOM, and bound tightly to the framework that owns the components.

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

The library is opinionated, the vocabulary is sizable (~20 primitives), and the testing payoff requires writing tests. Below a certain size, that's a bad trade.

If you're picking a tool for the next thing, ask one question. *Will this codebase still be alive in three years, and will engineers I haven't hired yet be working on it?* If yes, Olas is built for that horizon. If no, pick something smaller.

---

## 1. Core principles

1. **Logic and UI split is hard.** Logic *cannot* import from UI; UI subscribes to controllers via a tiny adapter.
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
| `createCache`     | Anonymous local async cache (no args)      | Controller             |
| `defineQuery`   | Keyed cache, shared via the root client    | Root query client      |
| `createQuery(ctx, q, k)` | Subscribe to a query from a controller     | Controller subscription |
| `createMutation`  | Async write with optimistic + invalidation | Controller             |
| `defineMutation`  | Module-scope mutation, registered by `id`  | Process-wide registry  |
| `ctx.emitter`   | One-shot event stream                      | Controller             |
| `createField`     | Form field (signal + validators)           | Controller             |
| `createForm`      | Aggregate of fields/sub-forms/arrays       | Controller             |
| `createFieldArray`| Dynamic-length list of fields or sub-forms | Controller             |
| `ctx.child`     | Construct a child controller (static)      | Parent                 |
| `ctx.attach`    | Child controller with its own dispose, suspend and resume handle | Parent  |
| `ctx.collection`| Keyed set of child controllers (homogeneous or per-item-typed) | Parent       |
| `ctx.lazyChild` | Code-split child loaded on demand          | Parent                 |
| `defineInfiniteQuery` | Cursor/page-accumulating shared cache | Root query client      |
| `defineScope` + `ctx.provide` / `ctx.inject` | Typed cross-tree data slot   | Providing controller   |
| `throttled` / `debounced` | Derived signals with timing      | Inherits source        |

---

## 3. Controllers

### 3.1 Definition

```ts
const userProfile = defineController((ctx, id: string) => {
  const user = createQuery(ctx, userQuery, () => [id])
  const page = signal(1)
  const posts = createQuery(ctx, userPostsQuery, () => [id, page.value]) // userPostsQuery defined module-scope

  const isEditing = signal(false)
  const draft = createField(ctx, '', { validators: [required(), maxLength(200)] })

  const save = createMutation(ctx, {
    mutate: (data: Draft, { signal, deps }) => deps.api.updateUser(id, data, { signal }),
    onMutate: (data) => {
      userQuery.cancel(id) // an in-flight refetch must not land over the guess (§6.4)
      return userQuery.setData(id, (u) => ({ ...u, ...data }))
    },
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

`ctx` carries what binds to a controller's **tree and lifetime**: `emitter`, `child`, `attach`, `collection`, `lazyChild`, `effect`, `on`, `provide`, `inject`, the lifecycle hooks `onDispose`, `onSuspend` and `onResume`, the devtools helper `debug`, and `deps`. The full canonical type signature lives in **§20.2** — refer there for the authoritative shape; this section sticks to usage patterns.

The primitives that build lifetime-owned **things** are standalone functions taking `ctx` first: `createField`, `createForm`, `createFieldArray`, `createCache`, `createQuery`, `createMutation` and `bindQuery`. See "On `ctx`'s shape" below for why.

At a glance:

- **Async data:** `createCache`, `createQuery`, `createMutation`, plus `ctx.effect`.
- **Forms & input:** `createField`, `createForm`, `createFieldArray`.
- **Events & communication:** `ctx.emitter`, `ctx.on`, `ctx.provide`, `ctx.inject`.
- **Tree composition:** `ctx.child`, `ctx.attach`, `ctx.collection`, `ctx.lazyChild`.
- **Lifecycle & DI:** `ctx.onDispose`, `ctx.onSuspend`, `ctx.onResume`, `ctx.deps`.
- **Devtools, dev-only:** `ctx.debug({ ... })` — expose named live values such as signals, computeds and fields to the devtools "Variables" view for this controller. A no-op in production; see §14.

**On `ctx`'s shape.** `ctx` carries what binds to a controller's *tree and lifetime*: children, effects, scopes, emitters, lifecycle hooks. The primitives that build lifetime-owned **things** — fields, forms, field arrays, queries, local caches, mutations — are standalone functions that take `ctx` as their first argument.

```ts
const email = createField(ctx, '')
const user = createQuery(ctx, userQuery, () => [id.value])
```

Three consequences worth knowing upfront:

1. **Helpers that take `ctx`.** Reusable composables that need lifecycle-bound primitives take `ctx: Ctx` as their first parameter (`createUserView(ctx, id)`, `createInlineEdit(ctx, current, save)`). That's "prop-drilling at the logic layer" — but it's explicit, grep-able, and surfaces exactly what binds to a lifecycle. The built-in primitives follow the same rule the composables always did.

2. **You pay for what you import.** A `ctx` method is reachable from `createRoot`, so a `ctx.field` forced every consumer to ship the forms subsystem and a `ctx.use` forced the query engine — used or not. As free functions they are ordinary named exports, and a controller that builds no form ships no form code. Measured with esbuild, gzipped: a controllers-only bundle was 20.1 KB when these were `ctx` methods, and is 6.35 KB built from the published `dist` (`.wiki/decisions/esm-only-build.md`). The query engine stays out too: a root gets one only through `createRoot(app, { queries: queryEngine() })`.

3. **What's not on `ctx` at all.** Anything that needs no lifecycle binding is standalone and takes no `ctx`. That covers `signal`, `computed`, `effect` (standalone), `batch`, `untracked`, `createEmitter`, `defineQuery`, `defineInfiniteQuery`, `defineMutation`, `defineScope`, `definePlugin`, `queryEngine`, `createSelection`, `debounced`, `throttled`, `debouncedValidator`, `isAbortError`, `serializeForScript`, `createTestController`. Most utility code never sees `ctx`.

An earlier draft considered splitting `ctx` into three *parameters* — `CtxQuery`, `CtxForm`, `CtxLifecycle` — and rejected it: most helpers mix concerns, three parameters is worse than one, and there is no clean axis. That rejection stands. What changed is different: `ctx` remains a single parameter, and the primitives that never needed to be methods moved off it. See `.wiki/decisions/ctx-primitives-are-free-functions.md`.

### 3.3 Reusable composables

Composables are functions that take a `ctx`. No special framework concept.

```ts
function createPagination(ctx: Ctx, opts: { pageSize: number }) {
  const page = signal(1)
  const next = () => (page.value += 1)
  const prev = () => (page.value = Math.max(1, page.value - 1))
  return { page, next, prev }
}

function createUserView(ctx: Ctx, id: () => string) {
  const user = createQuery(ctx, userQuery, () => [id()])
  const isMe = computed(() => user.data.value?.id === ctx.deps.session.userId)
  return { ...user, isMe }
}
```

Name them `create*`, as core and the satellite packages do. A `use*` name reads as a React hook, and `@kontsedal/olas-eslint-plugin`'s `no-react-hooks-in-controllers` rule reports any `use*` call inside a `defineController` factory.

### 3.4 When can `ctx.*` be called?

Every primitive is callable **any time during the controller's active lifetime**, not only during the initial factory run. Calling one after disposal throws.

On `ctx`: `emitter`, `child`, `attach`, `collection`, `lazyChild`, `effect`, `on`, `provide`, `inject`, `debug`, `onDispose`, `onSuspend`, `onResume`.

Taking `ctx` as their first argument: `createField`, `createForm`, `createFieldArray`, `createCache`, `createQuery`, `createMutation`, `bindQuery`.

Either way, everything you create is owned by that controller and disposed when it disposes.

This makes runtime-driven shapes natural:

```ts
const dynamicFormController = defineController((ctx) => {
  const schema = createQuery(ctx, schemaQuery)
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
        fields.set(def.name, createField(ctx, def.default ?? '', { validators: def.validators }))
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
- For *child controllers* that come and go, prefer `ctx.collection` and `ctx.attach` over hand-rolling Maps of `ctx.child` — those handle the diff and lifecycle for you. The Map-of-primitives pattern shown above is for non-controller primitives (fields, caches, mutations).

---

## 4. Lifecycle

Most controllers have two states: **active** and **disposed**. Construction happens once, disposal happens once, and that's the whole lifecycle for 80% of apps.

| Transition       | Triggers                                 | Effect                                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------- |
| construct        | `ctx.child(...)`, `ctx.attach(...)` or `createRoot(...)` | Runs factory, sets up effects/caches/children |
| dispose          | parent disposes, `root.dispose()`, or an `attach` handle's `dispose()` | Cleanup runs in **reverse registration order** — see below |

**Teardown order is reverse registration order: one pass, all kinds interleaved.** Children, effects, caches, subscriptions and `onDispose` hooks share one lifecycle list, in creation order. Dispose walks that list backwards. There is no phase ordering. An `onDispose` hook registered *after* an effect runs *before* that effect is torn down. The same hook registered *before* it runs after. LIFO is the useful guarantee, and the only one: a thing is torn down before whatever it was built on top of.

This matters when a hook needs a collaborator to still be alive. Flushing a pending `debounced` write from `onDispose` (§9) works only because the effect that consumes it is still subscribed, which is true only because the hook was registered later:

```ts
defineController((ctx) => {
  const width = createField(ctx, 240)
  const settled = debounced(width, 500) // a Field is a ReadSignal of its value
  ctx.effect(() => void save({ width: settled.value }))  // registered first…

  ctx.onDispose(() => {
    settled.flush()   // …so the effect above is still live here and the write lands
    settled.dispose()
  })
})
```

Register the hook before the effect and `flush()` emits into nothing.

**Memory.** Disposal is always recursive and synchronous. After dispose, all signals owned by the controller are dropped; subscribers receive a final `disposed` notification and unsubscribe.

**After dispose, `ctx` is dead.** Calling any `ctx.*` factory or `ctx`-taking primitive after the owning controller has been disposed **throws** `[olas] <name>() called after the controller was disposed`. That covers `ctx.effect`, `createQuery`, `ctx.child`, `ctx.attach`, `ctx.collection`, `createMutation`, `createForm`, `ctx.onDispose` and the rest, and the message names the call, as `effect()` or `createQuery()`. A captured `ctx` used past its owner's lifetime is a programming error; silently pushing into a torn-down lifecycle list would leak a live child or subscription. (Reads — `ctx.deps`, `ctx.inject` — do not throw.)

**For "user navigated away, might come back."** Dispose. The query client's `gcTime` retains shared data for ~5 min by default, so re-construction finds it warm and renders it at once. It skips the network only while the entry is fresh (within `staleTime`). Past that, and with the default `staleTime: 0`, it refetches in the background (§5.5). This is the right tool for route caches, closed tabs, hidden panels you might re-open.

### 4.1 Advanced — suspend & resume

A subtree can also be suspended and resumed. This is for "definitely coming back, definitely soon" cases — tab UIs where you're switching between two visible tabs, modals you minimize and re-open in seconds. Suspending preserves the controllers and their state; resuming is faster than dispose-and-reconstruct.

| Transition | Triggers                                 | Effect                                                        |
| ---------- | ---------------------------------------- | ------------------------------------------------------------- |
| suspend    | `root.suspend(options?)`, an `attach` handle's `suspend()`, `collection.suspendItem(key)` | Effects torn down; query subscriptions release their entries; `onSuspend` hooks run |
| resume     | `root.resume()`, the handle's `resume()`, `collection.resumeItem(key)` | Effects re-run; subscriptions re-acquire their entries, and a stale one refetches; `onResume` hooks run |

**Suspension and caches:**

- A suspended subscription releases its entry, so the entry's `gcTime` timer starts. The subscription keeps reporting the last data it showed. If the entry is collected before the resume, the resume binds a fresh entry and fetches.
- `refetchInterval` does not tick for a suspended subscription: the interval belongs to the entry, and runs only while the entry has subscribers (§5.9).
- A fetch that was already in flight when suspend was called continues to completion (we don't abort, since the result may be immediately useful on resume).
- On resume, any entry past its `staleTime` refetches.

**Explicit child suspension survives tree cascades.** A child suspended explicitly via `attach.suspend()` or `collection.suspendItem(key)` stays suspended through a whole-tree `suspend()` → `resume()` cycle (what `<SuspendOnUnmount>` performs, §16.1). Only its matching `attach.resume()` and `resumeItem(key)` wakes it — otherwise a virtualized list's scrolled-out rows would all resume on a single tree resume. The reverse is symmetric. `attach.resume()` and `resumeItem()` called while the parent is still suspended do not activate the child inside a frozen tree. They clear the explicit mark, and the child rejoins the parent's next resume cascade.

### 4.2 Suspend vs dispose — picking the right one

Two states preserve a controller's identity past "not currently active." Pick deliberately, because they have very different memory profiles:

| Use case | Right tool | Why |
|---|---|---|
| Tab UI where the user is *very likely* coming back within seconds | `suspend()` | Controller state preserved; entries still inside `staleTime` need no re-fetch on return |
| Modal in the background while you peek at something else briefly | `suspend()` | Same |
| Route navigation away — user *might* come back in 5 minutes, *might* not | `dispose()` | Drops subscriptions; query client's `gcTime` retains shared data for ~5 min; return navigation re-constructs the controller and finds data warm (no request while it is within `staleTime`) |
| Closing a tab / panel for good | `dispose()` | Terminal |

**The pitfall to avoid.** Using `suspend()` for "user navigated away" cases is a memory leak in disguise. The cache entries age out through `gcTime` as they would after a dispose. The controllers themselves stay alive for the rest of the session, with their signals, fields and children. Over a long session you accumulate dozens of suspended subtrees consuming memory.

**Disposal preserves data via `gcTime`.** When the last subscriber to a query entry goes away because a controller disposed, the entry isn't dropped immediately — it stays for `gcTime`, 5 min by default. If the user returns within that window, re-construction re-subscribes and the data is already there. This is the right mechanism for "maybe coming back" caching; suspend isn't.

### 4.3 `root.suspend(options?)` — optional auto-dispose

For cases where you legitimately want suspension but don't want to baby-sit it, pass `maxIdleTime`:

```ts
root.suspend({ maxIdleTime: 5 * 60_000 }) // dispose the root after 5 minutes suspended
```

Semantics:
- A timer starts at `suspend()` time.
- `resume()` cancels the timer.
- If the timer fires, the root transitions directly from `suspended` → `disposed`.
- Without `maxIdleTime` the root stays suspended until something resumes or disposes it. `Infinity` means the same, and a finite value above the platform timer limit is scheduled in chunks rather than overflowing (§21.5).

The name follows the duration rule in `.wiki/decisions/duration-naming.md`. Every duration is in milliseconds. Core's lifetime policies end in `Time`: `staleTime`, `gcTime`, `maxIdleTime`. Every other knob ends in `Ms`, such as `throttleMs` and `flushMs`.

Use this for back/forward navigation caches, hidden tabs that *might* be reopened, etc. It bounds memory without forcing you to write the cleanup yourself.

---

## 5. Caches & queries

### 5.1 Two flavors, one engine

- **Local cache** (`createCache`): anonymous, scoped to controller. Disposed with the controller.
- **Query** (`defineQuery` + `createQuery`): named, keyed, shared across the tree, lives on the root's query client.

Both go through the same internal machinery. Local caches get an opaque internal key.

**Request deduplication.** Two (or twenty) subscribers to the same query key share **one** cache entry and **one** in-flight fetch. The fetcher runs once per distinct key, regardless of how many `createQuery(ctx, ...)` subscriptions exist. This is implicit from the keyed-entry design and applies equally to `Query` and `InfiniteQuery`.

### 5.2 Query definition

```ts
export const userQuery = defineQuery({
  id: 'users/detail',                   // required: stable, hand-written, the same in server and client bundles
  key: (id: string) => ['user', id],
  fetcher: ({ signal, deps }, id: string) => deps.api.getUser(id, { signal }),
  staleTime: 30_000,                    // ms; default 0
  gcTime: 5 * 60_000,                   // ms; default 5min
  keepPreviousData: true,               // default false

  // retry on failure
  retry: 3,                             // number | (attempt, err) => boolean; default 0
  retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),  // exponential, capped: the default

  // settings for installed plugins, typed by the plugins that augment QueryMeta (§13.1)
  meta: { crossTab: true },             // mirror this query across tabs (§13.2)
})
```

**The fetcher's first argument is the fetch context** `{ signal, deps }`. `signal` is the `AbortSignal` to honor (§5.5), and `deps` holds the root's services (§10). The key arguments follow it. A module-scope query reaches its services through `deps`, with no module-level import of an API client.

**`id` is required.** It names the query everywhere a query crosses a boundary: SSR payloads, plugin events, devtools and error contexts (§15, §13.1, §12). `defineQuery` and `defineInfiniteQuery` throw on a missing or empty one. Write it by hand. A name derived from `fetcher.name` or a hash of the source changes under minification, and the id must be identical in the server and client bundles. Two queries sharing an id in one root warn in development. `.wiki/decisions/required-id-and-meta.md` records why.

**`meta` carries plugin settings.** `QueryMeta` is an empty interface in core, and each plugin package adds its fields by module augmentation (§13.1). `meta` therefore accepts what the installed plugins understand, and core never reads it.

**Retry semantics.**
- `retry: false | 0` (default) — never retry.
- `retry: number` — retry up to N times.
- `retry: (attempt, err) => boolean` — decide per-attempt; lets you skip retries on 4xx errors.
- `retryDelay: number | (attempt) => number` — ms between attempts. The default for a query is exponential, `min(1000 * 2 ** attempt, 30_000)`. A mutation's default is a constant `1000`.
- Retries respect `AbortSignal`: any cancellation in §5.5 ends the whole retry chain.
- A retried fetch counts as one logical fetch for `isFetching` and race protection and inflight counter; only the final outcome (success after retries, or final error) reaches consumers.
- Mutations support the same `retry` and `retryDelay` fields on `MutationSpec`.

**Resetting.** `subscription.reset()` clears `error` and settles `status` without dropping `data`: `'success'` when data exists, else `'idle'` (useful to dismiss an error toast without forcing a refetch). `subscription.refetch()` re-fetches regardless of stale-state. To both clear and re-fetch: `reset(); refetch();`.

When `keepPreviousData: true` and the key changes (e.g. id signal flips from `'a'` to `'b'`), the subscription keeps showing the previous entry's `data` until the new entry's first fetch resolves. `isFetching` is true, `isLoading` is false (we already have *some* data). Without this, key transitions briefly show `data === undefined`, causing UI flashes in tab and pagination UIs.

**Conditional and disabled queries.** Bootstrap flows often need "fetch X only once Y is available" (e.g. fetch the news feed once `session.currentUser` resolves). `createQuery` accepts an `enabled` thunk that runs in a tracking scope:

```ts
const session = createQuery(ctx, sessionQuery)

const feed = createQuery(ctx, newsfeedQuery, {
  key: () => [session.data.value!.id, 'top-stories'],
  enabled: () => session.data.value !== undefined,
})
```

While `enabled` returns `false`, the subscription holds `status: 'idle'`, `data: undefined`, no network fetch fires, and `isLoading` stays `false`. When `enabled` flips to `true`, the key is evaluated and fetching starts normally. Flipping back to `false` releases the entry without disposing it, so a re-enable inside `gcTime` reuses the cached data subject to `staleTime`.

A disabled subscription says so. `isEnabled` reads `false` while `enabled` returns `false`. `refetch()` rejects with `QueryDisabledError`, which carries the `queryId`, so a "Retry" button can filter it or disable itself on `isEnabled`. `firstValue()` waits until the subscription is enabled and loaded, so a suspense view over a dependent query suspends until its input arrives, instead of failing. It rejects only when the subscription is disposed. `.wiki/decisions/disabled-subscriptions.md` records the reasoning.

**`keepDataWhileDisabled` (opt-in).** Pass `createQuery(ctx, query, { enabled, keepDataWhileDisabled: true })` to keep the subscription reporting its **last `data`**, snapshotted at the moment `enabled` went false, instead of blanking to `undefined`. This is the react-query "a disabled observer still reads the cache" shape, for porting flows that flash empty otherwise. The entry is still released, so refcount and GC are unchanged, and `status` stays `'idle'`. Only `data` survives. `error` is not retained. On re-enable the live entry's data takes over. Default `false`.

**Projections.** `createQuery(ctx, query, { key, select })` reports `select(data)` instead of the cached value. The projection runs per subscriber, and the cache keeps the raw value.

For the common case (no `enabled`), continue to pass a bare thunk: `createQuery(ctx, query, () => [id])`. The options object form is only needed for `enabled`, `keepDataWhileDisabled` or `select`.

### 5.3 Subscription state shape

All fields are read-only signals. `QuerySubscription<T>` is `AsyncState<T>` (§20.4), the same shape a `LocalCache` has:

```ts
type QuerySubscription<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<'idle' | 'pending' | 'success' | 'error'>
  isLoading: ReadSignal<boolean>          // first load, no data yet
  isFetching: ReadSignal<boolean>         // any fetch in flight, including background
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean> // ≥ 1 optimistic write applied via setData, not yet settled
  isPaused: ReadSignal<boolean>            // a fetch is parked waiting for network reconnect
  isEnabled: ReadSignal<boolean>           // false while `enabled` returns false (§5.2)

  refetch: () => Promise<T>
  reset: () => void                   // clear error, settle status, keep data; no fetch
  cancel: () => void                  // abort in-flight fetch; keep data; settle status
  firstValue: () => Promise<T>        // resolves on first success — for SSR / navigation guards
}
```

The `isLoading` vs `isFetching` split is intentional: spinners typically gate on `isLoading`, but progress indicators want `isFetching`.

**`hasPendingMutations`** is true while any `setData`-produced `Snapshot` is alive and unrolled-back for this entry. It flips back to `false` when the last outstanding mutation settles. On success `onSuccess` finalizes and the snapshot is discarded; on failure `snapshot.rollback()` restores the baseline. UI uses this to render "saving…" indicators on individual records without inventing a `pending: true` flag in the data shape.

### 5.4 Keys — a single thunk returning an array

`createQuery` takes **one function that returns the args tuple**. Earlier drafts used variadic functions (one per arg), but that broke spread, dynamic-length keys, and conditional args. A single thunk is uniform across all cases.

```ts
// arity 1
const user = createQuery(ctx, userQuery, () => [idSignal.value])

// arity 2+
const reviews = createQuery(ctx, reviewsQuery, () => [productId, page.value])

// arity 0
const todos = createQuery(ctx, todosQuery)                       // no key function needed

// dynamic / spread
const tagged = createQuery(ctx, taggedQuery, () => [...tags.value])

// conditional
const maybeUser = createQuery(ctx, userQuery, () => [enabled.value ? id : 'guest'])
```

**No `as const` ceremony.** `Args` comes from the query, and the thunk's return type is the variadic tuple `readonly [...Args]`, so `() => [id]` checks as `[string]` rather than `string[]`:

```ts
createQuery<Args extends unknown[], T>(
  ctx: Ctx,
  source: Query<Args, T>,
  keyOrOptions?: (() => readonly [...Args]) | QuerySubscriptionOptions<Args>,
): QuerySubscription<T>
```

The thunk runs inside an auto-tracking scope. When any signal read inside changes, the subscription swaps to a different cache entry. Accepting "value or signal or function" makes the API ambiguous — always require the function form (no inline values).

### 5.5 Cancellation

Every fetcher receives an `AbortSignal` as `signal` on its first argument, the fetch context `{ signal, deps }` (§5.2). The cache aborts an in-flight fetch when:

- The cache is disposed (controller disposal).
- The key of a `createCache` local cache changes. For a shared query, a key change releases the old entry instead, and its fetch keeps running for the entry's other subscribers and its gc window.
- `refetch()` is called while a previous fetch is still pending — the previous one is aborted.
- The subscriber count drops to 0 *and* `gcTime` is `0` (immediate gc).

Fetchers are responsible for passing the signal to their I/O (`fetch(url, { signal })`, axios cancel tokens, etc.). If a fetcher ignores it, the cache will discard the eventual result.

**Explicit cancellation.** `query.cancel(...keyArgs)` aborts the in-flight fetch on demand, and `subscription.cancel()` does the same for the bound entry. It supersedes the request so its result can never land, restores a settled status of `'success'` when data exists and `'idle'` otherwise, and leaves `data` untouched. `query.cancelAll()` cancels every keyed entry of the query. The canonical use is the optimistic-write recipe (§6.4): cancel outgoing refetches *before* an optimistic `setData`, so a slower in-flight response can't land and clobber the optimistic value. `query.replace(...)` needs no such call — it supersedes the in-flight fetch itself, because a whole-record write is newer than any request issued before it (§6.4). `query.write(...)` does not: it patches, and a patch has no claim on the fields it left alone. Complementarily, on a **successful** fetch any live optimistic snapshots are rebased onto the fresh result, so a later rollback restores server truth rather than resurrecting pre-fetch data.

**"Nothing invalidates this query" does not mean "no fetch is in flight".** The cancel-before-*optimistic*-write step is not only for queries something else invalidates. An entry fetches on its own whenever a subscription **acquires it while stale**. That covers a first subscriber, a second root binding the same key, and a `resume()` after a suspend (§4.1). All three are `staleTime`-driven, with no invalidator anywhere in the program. Skipping `cancel(...)` because a grep found no `invalidate(...)` call is therefore unsound: the refetch lands after the optimistic write and overwrites it. The failure is transient and self-healing, which is exactly why it survives review.

**Reading without subscribing.** `query.peek(...keyArgs)` returns the entry's current data synchronously. It returns `undefined` when there is nothing to read: no entry, because it was never fetched or has been gc'd, or an entry that has not settled. It never creates an entry, because asking cannot change the answer, and it never fetches. It also **registers no reactive dependency**, so a `peek` inside a `computed` or an effect will not re-run it when the data changes. Reactive reads are `createQuery(ctx, ...)`'s job. `peek` is for imperative moments: an event handler that needs the current value, or a guard before a canonical write (§6.4). It is also the read side of the imperative surface, whose write side of `setData` and `cancel` could already reach a keyed entry from outside a subscription.

**Network mode & `isPaused`.** A query's `networkMode` (spec'd on `QuerySpec`) controls how fetches interact with `navigator.onLine`:

- `online` (default) — a fetch requested while offline is **deferred**, not run; it resumes automatically on the next reconnect. The entry reports `isPaused: true` while deferred.
- `always` — never gate on connectivity; the fetcher runs whenever requested (localhost, IPC and service-worker sources that don't surface through `navigator.onLine`).
- `offlineFirst` — start the fetch regardless. If it rejects **while offline** with a network-shaped error, park the entry at `isPaused: true` and retry on reconnect instead of surfacing the error. Network-shaped means a `fetch` `TypeError`, not an `AbortError`. The `status` stays `idle` and last-success. Otherwise the error surfaces normally.

`isPaused` (on `AsyncState`, §5.3) is the observable signal for both parked paths — `false` whenever a fetch is in flight or settled. Use it to render a "waiting for network" affordance, distinct from the spinner that `isFetching` drives and the error that `status === 'error'` drives.

### 5.6 Race conditions

Only the **latest** fetch's result is applied to a cache entry. If `refetch` is called three times in quick succession, results from the first two are discarded even if they resolve after the third. Errors from outdated fetches are also dropped.

This applies to both local caches and queries.

**Structural sharing.** A successful fetch is structurally shared with the entry's previous data (`structuralShare`, default `true`). Wherever a subtree of the new result equals the old one, the entry keeps the old reference. A refetch that returns an unchanged payload therefore leaves `data` identical (`===`), and no downstream `computed` or component re-runs. Plain objects and arrays are walked. `Map`, `Set`, `Date` and class instances are replaced whole. Set `structuralShare: false` on a query with a very large payload, where the walk on every refetch costs more than the re-render it saves.

### 5.7 Invalidation & mutation

Invalidation and write methods hang directly off the query value (no DI needed):

```ts
await userQuery.invalidate(id) // mark stale + refetch if subscribed; awaitable (resolves when the refetch settles)
await userQuery.invalidateAll() // mark stale + refetch every entry for this query (TanStack-style)
userQuery.setData(id, (u) => ({ ...u, name: 'X' })) // OPTIMISTIC write, returns a snapshot to settle
userQuery.write(id, (u) => ({ ...u, name: 'X' })) // CANONICAL write, no snapshot (§6.4)
userQuery.replace(id, user) // CANONICAL whole-record write; supersedes an in-flight fetch (§6.4)
userQuery.peek(id) // read the cached value synchronously, or undefined (§5.5)
userQuery.cancel(id) // abort the in-flight fetch for this key (optimistic recipe, §6.4)
userQuery.cancelAll() // abort in-flight fetches for every entry of this query
userQuery.prefetch(id) // fire-and-forget warmup
```

Internally these all dispatch to the root's query client. An unbound call works only while one root has touched the query; `bindQuery` selects a root explicitly (below, and §21.5).

**Invalidate semantics.** `invalidate` and `invalidateAll` always mark the entry stale, but refetch **immediately only if the entry currently has subscribers**. A subscriber-less entry is marked stale and *not* refetched, and the next subscriber triggers the fetch. An entry is subscriber-less when `gcTime` kept it warm after its last subscriber left, or when `prefetch` created it. This matches TanStack and avoids waking data no subscriber is watching.

Both return a `Promise<void>` that resolves when the refetches they trigger settle or are discarded, or immediately for entries without subscribers (which are marked stale only). Fetch failures are reported through the root's `onError` and the entry's `error` signal. Ambiguous unbound operations and operations on disposed bound roots reject. Use `bindQuery(ctx, query)` or `root.bindQuery(query)` to select a root (§21.5). Resolution alone does not guarantee reconciliation if a request was superseded (§6.4).

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

**Perf note.** `structuredClone` is O(*total nodes in the tree*), every call — it deep-copies everything to enforce immutability. On a thread of 10,000 comments, each like flips the whole tree; that's tens of milliseconds and can produce visible UI stutter. Immer's `produce` is O(*touched path*) via structural sharing. Only the nodes you mutated, and their ancestors up to the root, are new objects. The rest is shared with the previous value. Prefer Immer for any cache holding more than a few hundred nodes, and for any update path that runs on hot input such as typing, scrolling or dragging.

We deliberately don't bundle Immer — users who want it import it themselves, others stay slim.

### 5.8 GC

- Each cache entry tracks its subscriber count.
- When it hits 0, start a `gcTime` timer.
- If a new subscriber arrives before the timer fires, cancel and keep the data.
- Otherwise drop the entry entirely on timer fire.

### 5.9 Refetch triggers

- `staleTime` — on subscribe and access, refetch if older than this.
- `refetchInterval` — periodic background refetch while subscribed (a suspended subscription releases its entry, §4.1). Two forms, see below.
- `refetchOnWindowFocus` — **off by default.** Opt-in per query or root-wide.
- `refetchOnReconnect` — **off by default.** Same.

The defaults are deliberately quieter than TanStack — surprise refetches are a common source of bugs.

#### `refetchInterval` — fixed or data-driven

```ts
type RefetchInterval<T> = number | ((data: T | undefined) => number)
```

A number is a fixed gap in ms. A function is resolved **once per scheduling decision** — on every tick, for the *next* gap — and receives the entry's latest data:

```ts
// Poll fast while a job is running, back off when the queue is idle.
refetchInterval: (jobs) => (jobs?.some((j) => j.state === 'running') ? 1_000 : 30_000)
```

That "poll fast while there's work, slowly when idle" shape is the case the function form exists for. A fixed number forces a choice between a wasteful cadence at rest and a sluggish one under load. Expressing it outside the query means a second timer racing the first.

The contract:

- **The gap for tick N+1 is resolved at tick N**, before that tick's fetch starts. A change in data therefore shows up in the gap *after* the fetch that produced it. The timer is a self-rescheduling chain, not a settle-chained delay. A fetch slower than the gap doesn't stretch the cadence. A tick that lands while a fetch is already in flight is skipped, and joins the running fetch rather than aborting it.
- **The gap must be a positive finite number, in either form.** `0`, `NaN`, a negative number and `Infinity` all stop the timer for that entry, with a dev-build warning. The alternative would be a fetch-per-macrotask loop. The rule is about the *resolved gap*, so it binds a literal `refetchInterval: 0` exactly as it binds a thunk returning `0`. Once stopped, the timer restarts only on the entry's next **0→1 subscriber transition**. A subscriber joining an entry that still has others does not re-arm it.
- **A valid gap above the platform timer limit is scheduled in chunks, not clamped.** Rejecting `Infinity` is not the same as handling overflow. A finite gap larger than 2,147,483,647 ms passes the rule above, and would still overflow a raw `setTimeout` into an immediate fire. The longest interval you can ask for would behave as the shortest. The chain goes through the shared expiry scheduler (§21.5) like every other user-supplied duration.
- **A thunk must not throw.** A throw is handled like a bad gap — the chain stops with a dev warning that names the throw and carries the error. It is caught rather than left to escape, because the resolution happens *before* the re-arm inside the timer callback. Unguarded, one throw would end polling for that entry permanently, leaving nothing but an uncaught error in a timer.
- **The first resolution is synchronous, at acquire.** The 0→1 subscriber arms the chain before the initial fetch can settle. A thunk's first call therefore receives `undefined`, or hydrated or cached data when the entry already holds some. It must handle that argument.
- **The thunk is not reactive.** Reading a signal inside it yields that tick's value and registers no dependency; changing that signal reschedules nothing. Drive the decision off the `data` argument.
- **The data is read without subscribing**, so resolving a gap never marks the entry as accessed or perturbs staleness.
- **It is per entry, not per subscriber.** The timer belongs to the shared cache entry, so ten controllers subscribed to one key share one interval. This is why `QuerySubscriptionOptions` (§20.4) carries no `refetchInterval`: per-subscriber intervals would need a "whose interval wins" rule, and every answer to that question surprises somebody. It's also why the field isn't defaultable (below).
- For infinite queries the argument is the entry's **pages array** (`TPage[] | undefined`) — what the entry stores. A tick re-fetches every loaded page (§5.11).
- **`createCache` (`LocalCache`, §5.1 / §5.10) has no interval of any kind** and does not gain one from this. A controller-local cache that wants polling should use `ctx.effect` + a timer, or graduate to `defineQuery`.

#### Root-wide query defaults

The query engine carries the defaults: `queryEngine({ defaults })` sets them for every query under a root that uses the engine. Resolution is always **`spec.X ?? defaults.X ?? built-in`** — a per-query spec field wins, so a root default can never silently override an explicit decision.

```ts
createRoot(app, { deps, queries: queryEngine({ defaults: { staleTime: 5 * 60_000, retry: 1 } }) })
```

Why this exists: the built-in `staleTime: 0` and `retry: 0` are the right *quiet* choice for a single query. An app that wants different ones had to restate them on all N `defineQuery` calls. Forgetting one doesn't error. It presents as "why is this refetching on every subscribe?", a bad failure mode for a value with no local justification.

Applies to `defineQuery`, `defineInfiniteQuery`, and `createCache` (for the fields `LocalCacheOptions` carries — `staleTime`, `keepPreviousData`). A focus or reconnect refetch of an infinite query re-fetches every loaded page (§5.11). The engine is the only place for these defaults, so there is no precedence between two sources to get wrong.

One deliberate exclusion: **`refetchInterval` is not defaultable.** A root-wide interval would start background polling for every query in the app, which is not what "defaults" is asking for. Opt in per query, in either form. `id`, `key`, `fetcher` and `meta` are per-query identity and settings, so they have no default either.

**An engine is a definition, not an instance.** Each root that adopts it gets its own client. One engine value can therefore be hoisted to module scope and shared by several roots, or by a `HydrationBoundary` that rebuilds its root under StrictMode. `createRoot` creates the client eagerly, before plugin setup and the root factory, so a plugin's `setup` can already reach the cache (§13.1).

### 5.10 Picking the right cache flavor

| Use case | Primitive |
|---|---|
| One-off async load, no args (only this controller cares) | `createCache(ctx, fetcher)` |
| Keyed cache (args vary), used by one or many controllers | `defineQuery({ key, fetcher })` |
| Paginated / cursored accumulation | `defineInfiniteQuery({...})` |

**A note on "local" parameterized caches.** Earlier drafts shipped a `ctx.paramCache` primitive — a controller-scoped keyed cache — to cover "I need pagination state but no other module needs this data." That use case is fully covered by `defineQuery`: define the query at module scope, never import it elsewhere, and it is local in practice. Sharing across controllers is opportunistic, not required, and entries gc cleanly via `gcTime`. The extra primitive added vocabulary without adding capability, so it's gone. If you want zero leakage into the global query client, set `gcTime: 0` and the entry drops the instant the last subscriber leaves.

### 5.11 Infinite / cursor pagination

For accumulating pages (chat history, infinite feeds), use `defineInfiniteQuery`:

```ts
export const messagesQuery = defineInfiniteQuery({
  id: 'messages/list',
  key: (conversationId: string) => ['messages', conversationId],
  fetcher: ({ pageParam, signal, deps }, conversationId: string) =>
    deps.api.getMessages(conversationId, { cursor: pageParam, signal }),
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

**Refetch semantics.** A refetch of an infinite entry **re-fetches every currently-loaded page** in order, not only the first. It starts at `initialPageParam` and chains each next param via `getNextPageParam` off the freshly-fetched pages. The triggers are `refetchInterval`, `invalidate()`, `refetch()`, focus and reconnect. Pages update atomically at the end, so a scrolled-down list never flashes down to one page mid-refetch. This matches TanStack. A refetch that finds the dataset has shrunk, because a page now returns `getNextPageParam === null` earlier, keeps only the pages that still exist.

The `flat` selector is configurable per-query via an `itemsOf: (page) => page.items` field. If omitted, `flat` equals `pages`.

Invalidation is a refetch like the others: it marks the entry stale and re-fetches every loaded page from `initialPageParam`, and the pages swap at the end. There is no "partial invalidate". For "keep only the most recent N pages", `write` the pages you want to keep.

**An infinite query does what a regular one does.** It dehydrates and hydrates with its `pageParams`, so a server-rendered list continues paging where the server stopped (§15). It honours `refetchOnWindowFocus`, `refetchOnReconnect` and the `offlineFirst` park (§5.5). It has the imperative surface `peek`, `write`, `replace`, `cancel` and `cancelAll`, and its writes reach plugins with their `pageParams` (§13.1). `.wiki/decisions/infinite-query-parity.md` records how.

---

## 6. Mutations

A mutation is a controller-scoped async function with first-class loading state, optimistic updates, and invalidation.

```ts
type MutationSpec<V, R> = {
  id?: string                                            // devtools label, plugin routing; required by defineMutation
  mutate: (vars: V, ctx: { signal: AbortSignal; deps: AmbientDeps }) => Promise<R>
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (err: unknown, vars: V, snapshot: Snapshot | undefined) => void
  onSettled?: (result: R | undefined, err: unknown | undefined, vars: V) => void
  concurrency?: 'parallel' | 'latest-wins' | 'serial'    // default: 'parallel'
  retry?: RetryPolicy                                    // see §5.2
  retryDelay?: RetryDelay                                // see §5.2
  meta?: MutationMeta                                    // plugin settings (§13.1)
  detached?: boolean                                     // default: false — see §6.5
}

type Mutation<V, R> = {
  run: (vars: V) => Promise<R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  status: ReadSignal<'idle' | 'pending' | 'success' | 'error'>
  lastVariables: ReadSignal<V | undefined>
  reset(): void
  dispose(): void
}
```

`mutate` receives the variables and a context: the run's `AbortSignal` (§6.2) and the owning controller's `deps`. It is the same `{ signal, deps }` shape a query fetcher gets (§5.2).

**Defined mutations.** `defineMutation` declares a write at module scope and registers it by `id` in a process-wide registry. A plugin can then run it with no controller present: the mutation queue replays a run persisted before a reload this way (§13.3). A definition carries only the write and its policy: `id` (required), `mutate`, `concurrency`, `retry`, `retryDelay` and `meta`. Lifecycle hooks belong to the controller that runs it:

```ts
// module scope
export const createOrder = defineMutation({
  id: 'order/create',
  mutate: (vars: OrderInput, { signal, deps }) => deps.api.createOrder(vars, { signal }),
  meta: { persist: true }, // typed by @kontsedal/olas-mutation-queue (§13.3)
})

// a controller
const place = createMutation(ctx, createOrder, { onSuccess: () => ordersQuery.invalidateAll() })
```

`createMutation(ctx, def, hooks)` takes `onMutate`, `onSuccess`, `onError`, `onSettled` and `detached`. A definition's `mutate` must not close over controller state, because a replay has no controller; it reaches services through `deps`. An inline `createMutation(ctx, spec)` may omit `id`, and when given it labels the mutation in devtools and error contexts.

**`status`** is the outcome of the latest run — `'idle'` before any run (and after `reset()`), `'pending'` in flight, `'success'`, `'error'`. It is what React's `useMutation` derives `isIdle`, `isSuccess` and `isError` from, so a **`void` mutation** (which resolves `undefined`) still reports `status: 'success'` rather than looking stuck at idle. Distinct from `isPending`, which stays true while *any* run is in flight (parallel mode). A superseded `latest-wins` run does **not** flip `status` to `'error'` — the superseder owns the terminal status.

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

`isAbortError(err)` is exported from `@kontsedal/olas-core`. It is true for a `DOMException` named `'AbortError'`, and for any other object whose `name` is `'AbortError'`, which covers the aborts axios, msw and hand-thrown errors produce. Mode `serial` never aborts queued calls. Mode `parallel` never aborts.

**Lifecycle callbacks on supersede.** When a `latest-wins` run is superseded:
- `onError` is **not** invoked with the AbortError. It's reserved for genuine failures.
- `onSettled` is **not** invoked either. A superseded run never "settles" — its work was deliberately replaced. Calling it with `(undefined, undefined, vars)` was the previous spec and led to confusing branches in user code; we now skip it. If you need cleanup that fires even on supersede, put it in a `try/finally` inside `mutate`.
- `onMutate`'s snapshot, if any, is rolled back automatically before the new run starts (so the new optimistic update doesn't stack on top of the superseded one).

### 6.2 Cancellation

Each `mutate` receives an `AbortSignal` as `signal` in its context. It's triggered when:

- Controller is disposed — **unless the mutation is `detached` (§6.5)**.
- `mutation.reset()` is called.
- `concurrency: 'latest-wins'` and a new `run()` supersedes this one.

**`run()` after dispose rejects with `MutationDisposedError`, and `mutate` is never called.** The write does not happen. That error is deliberately **not** an `AbortError`. `isAbortError(err)` is how callers filter cancellations, and a run that was never accepted is not a cancellation. It is a write the app asked for and silently did not get. Filtering it away would hide that. It carries `mutationId` (the mutation's `id`, when it has one) and `controllerPath` to say which one.

```ts
import { MutationDisposedError, isAbortError } from '@kontsedal/olas-core'

try {
  await mutation.run(vars)
} catch (e) {
  if (e instanceof MutationDisposedError) {
    // The write never ran. Either own the mutation higher up, or mark it
    // `detached` (§6.5) so it survives the screen that started it.
  } else if (isAbortError(e)) {
    return // superseded or reset — deliberate
  } else throw e
}
```

**A run that already completed is never rolled back.** If `mutate` resolves and the abort lands in the gap before the run's continuation, the work is done. You cannot cancel what already happened. The optimistic snapshot is **finalized**, not rolled back. A rollback would commit a value already known to be stale to a cache that outlives the mutation, with no `onSuccess` left to invalidate it. Plugins hear such a run as `'success'` rather than `'cancel'` (§13.1), so the mutation queue does not replay a write the server accepted (§13.3). The returned promise still rejects with `AbortError` — the caller walked away, and `data` and `status` belong to the superseder, or are left unset.

### 6.3 Optimistic updates

`onMutate` returns a `Snapshot`. Typical shape:

```ts
{
  rollback: () => void  // called on error
}
```

The rollback closure typically calls `query.setData(...)` with the pre-mutation value.

### 6.4 Optimistic rollback under concurrency

Each `Snapshot` captures the entry's value at the moment its `setData` ran — a **baseline**, not a delta. Snapshots form a stack in application order, and rollback is **positional**:

- Rolling back the **top** (most-recent live) snapshot restores its captured baseline as the current data. So if A applies, then B applies, and B fails first, B's rollback reverts to the state observed **after A's update**. A later A rollback then reverts to the original pre-A value. This is the LIFO case, and the common one.
- Rolling back a **non-top** snapshot does **not** rewrite the currently-displayed value — a middle layer can't be removed cleanly without replaying the updaters stacked above it. Instead that layer's baseline is spliced out of the chain and threaded down onto the next layer ("chain-splice"). The visible value keeps every still-pending optimistic delta until the top layer settles.

The guarantee this buys is one sentence. **Once every optimistic layer has rolled back, in any order, the data returns to the original pre-mutation value.** Before the chain-splice, an out-of-order rollback restored B's stale baseline last. That resurrected A's delta and corrupted the final state. The order that broke it: A applies, B applies, A fails first, then B fails.

**Fetch success rebases live snapshots.** When a fetch resolves while optimistic snapshots are live, each snapshot's captured baseline is updated to the fresh server value. A subsequent rollback therefore restores *server truth*, not the pre-fetch value — otherwise a refetch landing mid-mutation, followed by that mutation failing, would resurrect stale pre-fetch data. Pair this with `query.cancel(...)` (§5.5): cancelling outgoing refetches *before* an optimistic write prevents a stale response from overwriting it in the first place.

This is snapshot-based rollback, not full rebasing. It does not re-run the surviving updaters against a new baseline, so a non-top rollback leaves the failed layer's delta on screen until the stack unwinds. For conflicting updates, meaning two mutations writing the same field, prefer `concurrency: 'serial'` or explicit conflict resolution in `onMutate`.

Only `query.setData(...)` (as used inside a mutation's `onMutate`) creates a rollback snapshot and flips `hasPendingMutations`. **Canonical cache writes** that do not originate from an optimistic mutation write straight through the entry without pushing a snapshot. A cross-tab receive (§13.2), an entity backprop (§18.1) and a realtime patch (§16.5) are all of this kind: each goes through `host.queries.write` or a bound `write`. None of them sets `hasPendingMutations` or can wedge it at `true`.

**Userland canonical writes use `query.write(...)`.** It is `setData` minus the snapshot. Same entry, created if absent. It reports `source: 'write'` to plugins and devtools, where `setData` reports `'optimistic'` (§13.1). No rollback handle, and `hasPendingMutations` untouched. Use it whenever the write is not an optimistic guess that a mutation might have to undo. Folding a server-pushed record into the cache, applying a realtime event, and syncing a value another view just changed are all of that kind.

**`replace(...keyArgs, value)` is the write that supersedes an in-flight fetch.** It takes a whole VALUE rather than an updater, and that signature is the contract. A patch built from `prev` describes the fields it touches and says nothing about the rest. A response already on its way may carry newer values for those other fields, and discarding it would lose them. A replacement asserts there is nothing else, *this is the record now*, which is exactly the condition under which a request issued earlier has nothing left to contribute. Its canonical source is a server read-back taken after the write it reports.

`write` and `setData` both leave an outstanding fetch alone, for different reasons. `write` is canonical but partial, so it has no claim on what it did not touch. `setData` is a guess, and a server response is entitled to overrule a guess. That is why the cancel-before-`setData` recipe in §5.5 is still the caller's to make. `cancel(...)` remains the escape hatch for a `write` the caller has decided should win anyway.

**`replace` supersedes only when `value` is defined.** A write flips an idle or pending entry to `success` whatever it is handed. Replacing with `undefined` *and* cancelling would therefore strand the entry at `success` over no data, with nothing to refetch it until `staleTime` lapses. Replacing with `undefined` says "there is no record", and the in-flight fetch is left to produce the first value.

All three rebase live optimistic snapshots onto the written value, so a rollback restores what was written rather than a baseline captured before it.

**The limit of that rule.** "Holds data" means `!== undefined`, which is how the whole cache spells "nothing here" (`peek`, `firstValue`, `keepPreviousData`). A query whose fetcher legitimately resolves `undefined` therefore never supersedes, and a stale response can still clobber a `write` on it. Call `cancel(...)` first on such a query; distinguishing "no value yet" from "the value is `undefined`" would need a has-settled flag the entry does not carry.

This is a correctness distinction, not a stylistic one. A `setData` snapshot exists to be settled by the mutation that created it (`onMutate` returns it; success finalizes, failure rolls back). A fire-and-forget patcher has no mutation to settle it, so **every call leaves a live snapshot record on the entry**. `hasPendingMutations` wedges at `true` for the rest of the entry's life. On a long-lived entry patched on every server event, the snapshot array also grows without bound, each layer retaining its captured baseline. Without `write`, the only escape would be remembering to call `snapshot.finalize()` on every patch.

### 6.5 Detached runs — writes that outlive the screen

`detached: true` stops `dispose()` from cancelling. In-flight runs finish, queued `serial` runs still drain, `run(...)` still works after dispose, and `onSuccess`, `onError` and `onSettled` still fire.

```ts
const activate = createMutation(ctx, {
  mutate: (key: string, { deps }) => deps.api.activateLicense(key),
  detached: true,
  onSuccess: () => licenseQuery.invalidate()
})
```

The default is right for a **read** a closing screen no longer wants. It is wrong for a **write**: the request is already at the server, the user asked for it, and cancelling the client half neither un-sends it nor tells anyone. The symptom is a modal that reports "Something went wrong: Aborted" for an operation that succeeded, or a confirm answered just after its panel closed that does nothing at all.

What still cancels a detached run:

- `reset()` — and it keeps working after dispose, since it is then the only stop button left.
- A `latest-wins` supersede.

Both are the app explicitly saying "drop this one". Dispose only says "this screen is gone", which is not the same claim.

**The callbacks run after the controller is torn down.** That is the whole point, because it is how the `onSuccess` invalidation lands. It also means they must not touch what dispose destroyed. Keep them to client-level work: `query.invalidate()`, a toast, a logger. Not the controller's signals, fields or children. If the whole **root** is gone the run still completes, but its cache writes no-op, because the client has deregistered itself from every query.

**A non-detached run whose `mutate` already resolved is finalized, not rolled back.** The abort can land in the gap between the promise resolving and its continuation. By then the work has already happened. Rolling back would write a known-stale value into a cache that outlives the mutation, so the optimistic value is committed as server truth. One consequence is worth knowing. `onSuccess` does *not* run on that path, so the invalidation that would normally reconcile the optimistic guess against the server's normalized record never fires. Nothing marks the entry stale either, which means on a query with `staleTime: Infinity` the committed guess is what the cache holds until something invalidates it explicitly. `detached: true` is the way to avoid the whole situation: the run finishes normally and `onSuccess` lands.

Reach for it on writes whose completion the user has already been promised, and leave it off everything else.

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

Three primitives cover the entire form story. `Field<T>` holds one value, `Form<S>` is a nested aggregate, and `FieldArray<I>` is a dynamic-length list.

### 8.1 Field

```ts
const draft = createField(ctx, '', { validators: [required(), maxLength(200)] })

draft.value          // T — current value (Field<T> IS a ReadSignal<T>)
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
draft.setErrors(['Taken'])    // pin server errors; cleared by the next set() or reset()
draft.dispose()               // explicit teardown when owned outside a ctx (rare)
```

`createField(ctx, initial, options?)` takes `{ validators, validateOn }`. `validateOn` says when validation first runs: `'change'` (default) at once, `'blur'` after the first `markTouched()`, `'submit'` after the first `revalidate()` or `Form.validate()`. Once it has run, every change re-validates.

See §8.4 for when to reach for `setAsInitial`. `Field`, `Form` and `FieldArray` are all `ReadSignal`s of their value, so `field.value`, `form.value` and `array.value` each read the value itself (`.wiki/decisions/forms-are-read-signals.md`).

**Server errors are a separate channel.** `setErrors(errors)` pins messages a failed submit returned. A validator re-run does not clear them; the user's next `set` does, and so do `setErrors([])` and `reset()`. `errors` shows validator output first and server errors after.

`Validator<T>` signature:

```ts
type FormIssue = { path: (string | number)[]; message: string }

type Validator<T> = (
  value: T,
  signal: AbortSignal,
) => string | null | FormIssue[] | Promise<string | null | FormIssue[]>
```

The `AbortSignal` is triggered when the value changes again before the validator resolves (or the field is disposed) — async validators should pass it through to their I/O.

A validator may return a `string`, which is an error on the node it is attached to. `null` and `[]` both mean valid. A `FormIssue[]` targets descendants by `path`; see §8.3 for how form-level and array-level validators route those onto specific fields. On a leaf `Field` a returned `FormIssue[]` collapses to its messages, because a leaf has no descendants to route to.

**Validators run in a tracking scope.** Reading any signal inside a validator causes the validator to re-run automatically when that signal changes:

```ts
const password = createField(ctx, '', { validators: [minLength(8)] })
const confirm = createField(ctx, '', {
  validators: [(v) => (v === password.value ? null : 'Passwords must match')],
})
// editing password re-runs confirm's validator
```

Sync validators run first and short-circuit; async validators only run after all syncs pass.

**Built-in validators.** `required`, `minLength`, `maxLength`, `min`, `max`, `email`, `pattern`, and `mustBeTrue`, plus `validator(schema)`, which adapts any Standard Schema (Zod, Valibot, ArkType) into a `Validator`. `required` rejects the empty values `''`, `null`, `undefined` and `[]`. A boolean `false` is a legitimate value and **passes**. For a consent or terms checkbox that must be ticked, use `mustBeTrue(message?)`, which rejects anything that is not `true`.

### 8.2 Debounced async validators

For server-side checks (username taken, email exists), use `debouncedValidator`:

```ts
import { debouncedValidator } from '@kontsedal/olas-core'

const username = createField(ctx, '', {
  validators: [
    required(),
    debouncedValidator(async (v, signal) => {
      const taken = await ctx.deps.api.checkUsername(v, { signal })
      return taken ? 'Username taken' : null
    }, 500),
  ],
})
```

While debouncing, or while the request is in flight, `isValidating` is `true` and `isValid` **holds its last settled value**. Editing an already-valid field therefore keeps `isValid: true` mid-check, so a submit button bound to it doesn't strobe to disabled on every keystroke. A field with no prior settled validation defaults to valid. `isValid` only flips when a validation pass completes.

### 8.3 Form — aggregate of fields & nested forms

`createForm(ctx, schema, options?)` builds a `Form<S>` whose fields are addressable, whose aggregate value/errors/isValid/touched/dirty are signals, and whose schema can nest arbitrarily.

```ts
type UserProfile = {
  name: string
  address: { street: string; city: string }
  preferences: { theme: 'light' | 'dark' }
}

const form = createForm(ctx, {
  name: createField(ctx, '', { validators: [required()] }),
  address: createForm(ctx, {
    street: createField(ctx, '', { validators: [required()] }),
    city: createField(ctx, '', { validators: [required()] }),
  }),
  preferences: createForm(ctx, {
    theme: createField<'light' | 'dark'>(ctx, 'light'),
  }),
})

form.value        // UserProfile — a Form IS a ReadSignal of its value, like a Field
form.errors       // ReadSignal<FormErrors<...>>  — same shape as value, leaves are string[] | undefined
form.isValid      // ReadSignal<boolean>  — all leaves valid
form.isDirty      // ReadSignal<boolean>  — any leaf dirty, or a FieldArray structurally changed (§8.5)
form.dirtyFields  // ReadSignal<string[]> — dotted paths of the dirty leaves, for a PATCH payload
form.touched      // ReadSignal<boolean>  — any leaf touched
form.isValidating // ReadSignal<boolean>

form.fields.name.set('Bob')
form.fields.address.fields.street.set('1 Main St')
form.fields.address.fields.city.set('Springfield')

// ops
form.set({ name: 'New', address: { street: 'X' } })  // deep merge — partial OK
form.setAsInitial({ name: 'Ann' })                    // new baseline: isDirty stays false
form.reset()
form.clearSubtree('address')                          // reset one subtree to its initial
form.markAllTouched()
await form.validate()  // run everything; returns overall isValid
form.setErrors({ 'address.city': ['Unknown city'] })  // server errors, by dotted path
```

`form.value` is typed exactly as the schema's nested value type — no manual `FormData` interface required. `form.subscribe(fn)` and `useValue(form)` fire when any leaf changes.

**`form.set` is batched.** Updating multiple leaves through `form.set(partial)` fires one notification pass, not one per leaf — same `batch()` semantics signals already provide.

**Form-level validators.** Cross-field rules ("endDate > startDate", "password === confirm") that don't belong to any one field go in `options.validators`:

```ts
const form = createForm(ctx, {
  password: createField(ctx, '', { validators: [minLength(8)] }),
  confirm: createField(ctx, ''),
}, {
  validators: [
    (value) => value.password === value.confirm ? null : 'Passwords must match',
  ],
})

form.topLevelErrors // ReadSignal<string[]> — errors from form-level validators only
form.isValid    // false when ANY leaf is invalid OR topLevelErrors is non-empty
```

`topLevelErrors` is separate from `errors` because the latter mirrors the schema shape; form-level errors don't belong to a specific leaf. UI typically shows `topLevelErrors` at the top of the form.

**Targeting a specific field from a form-level validator.** A cross-field rule often belongs on one field, not at the top ("passwords must match" reads best on the confirm input). Return a `FormIssue[]` instead of a `string`:

```ts
const form = createForm(ctx, {
  password: createField(ctx, '', { validators: [minLength(8)] }),
  confirm: createField(ctx, ''),
}, {
  validators: [
    (value) =>
      value.password === value.confirm
        ? []
        : [{ path: ['confirm'], message: 'Passwords must match' }],
  ],
})

form.fields.confirm.errors // ['Passwords must match'] — routed onto the field
form.topLevelErrors        // [] — nothing landed at the top
```

Each issue's `path` walks the schema exactly like `flatErrors` paths (object keys, numeric array indices); an **empty** path lands in `topLevelErrors`. A whole-form Standard-Schema validator (`validator(schema)` and `zodValidator(objectSchema)`) works the same way — its issues keep their `path`, so `z.object({...}).refine(fn, { path: ['confirm'] })` lands on `confirm`. Field-targeted messages are a **third error channel**, beside a field's own validator output and `setErrors` server errors. They merge into the field's visible `errors`, and are **cleared and recomputed on every form-level run**. Fixing the mismatch therefore removes them, while a field's own `set()` does not. An unresolvable path falls back to `topLevelErrors` rather than vanishing. The same mechanism applies to array-level validators on a `FieldArray`, whose paths are `[index, ...]`.

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
const profile = createQuery(ctx, profileQuery, () => [props.id])

const form = createForm(ctx, {
  name: createField(ctx, '', { validators: [required()] }),
  email: createField(ctx, '', { validators: [required(), email()] }),
}, {
  initial: () => profile.data.value, // DeepPartial of form value, or undefined
})
```

Semantics:

- `initial()` runs in a tracking scope; when its tracked signals change, the form re-applies the new initial values **only if the form is not dirty**. Once the user touches anything — editing a field **or** a `FieldArray` add/remove/move (§8.5) — auto-sync stops to avoid clobbering edits. That is the default `resetOnInitialChange: 'when-clean'`; `'never'` runs `initial()` once at construction, and `'always'` re-seats even a dirty form, discarding its edits.
- `form.reset()` always re-reads `initial()` to get the latest baseline.
- Setting `initial` to a fixed object (not a function) is also accepted — equivalent to a one-shot constructor initial.

### 8.5 FieldArray — dynamic lists

```ts
const order = createForm(ctx, {
  customer: createField(ctx, '', { validators: [required()] }),
  items: createFieldArray(
    ctx,
    (initial?: { sku?: string; qty?: number; price?: number }) =>
      createForm(ctx, {
        sku: createField(ctx, initial?.sku ?? '', { validators: [required()] }),
        qty: createField(ctx, initial?.qty ?? 1, { validators: [min(1)] }),
        price: createField(ctx, initial?.price ?? 0, { validators: [min(0)] }),
      }),
    { initial: [{ sku: '', qty: 1, price: 0 }] },
  ),
})

order.fields.items.add({ sku: 'X', qty: 2, price: 9.99 })
order.fields.items.remove(0)
order.fields.items.move(0, 2)
order.fields.items.insert(1, { sku: 'Y' })
order.fields.items.set([{ sku: 'A', qty: 1, price: 5 }])  // items keep identity where indices overlap
order.fields.items.setAsInitial([])                      // rebuild from a new, clean baseline

order.fields.items.at(0)         // Form<{ sku, qty, price }> | undefined
order.fields.items.size          // ReadSignal<number>
order.fields.items.items         // ReadSignal<Form<...>[]>
order.fields.items.value         // Array<{ sku, qty, price }> — a FieldArray IS a ReadSignal of its value
order.fields.items.errors        // ReadSignal<Array<FormErrors | undefined>>
order.fields.items.isValid       // ReadSignal<boolean>

order.value
// { customer: string; items: Array<{ sku: string; qty: number; price: number }> }
```

The factory passed to `createFieldArray` runs once per `add()` and `insert()` to construct a fresh sub-form (or sub-field), and receives the value passed to them. Each item is owned by the array; removing it disposes the underlying form.

**Structural dirtiness.** `add`, `insert`, `remove`, `move`, and `clear` mark the array **dirty** — `isDirty` is `true` after any of them, not only after a per-item edit. This is what makes the reactive-`initial` guard (§8.4) safe. Once the user adds or removes a row, the default `resetOnInitialChange: 'when-clean'` stops re-seating. A background refetch of `initial: () => queryData` therefore cannot silently delete the rows the user just added. `reset()` — and an `initial`-driven re-seat — clears the structural dirt back to the clean baseline.

For arrays of simple fields (no sub-form), the factory returns a single field:

```ts
const tags = createFieldArray(ctx, (initial?: string) =>
  createField(ctx, initial ?? '', { validators: [required()] }),
)
tags.add('hello')
tags.value  // string[]
```

**Array-level validators** ("min 1 item", "max 5 tags", "unique skus") go in `options.validators`:

```ts
const tags = createFieldArray(ctx, () => createField(ctx, '', { validators: [required()] }), {
  validators: [
    (items) => items.length >= 1 ? null : 'At least one tag',
    (items) => new Set(items).size === items.length ? null : 'Tags must be unique',
  ],
})

tags.topLevelErrors // ReadSignal<string[]> — errors from array-level validators
```

Same shape as `Form.topLevelErrors` — surfaced separately from per-item errors.

### 8.6 Submitting a form

`form.submit(handler, options?)` runs the validate-then-send flow and resolves a discriminated `SubmitResult`:

```ts
const save = createMutation(ctx, saveProfile) // a defineMutation, §6

const result = await form.submit((value) => save.run(value))
if (result.ok) {
  toast(`Saved ${result.data.name}`)
} else if (result.reason === 'invalid') {
  // validation failed; every leaf is now touched, so the errors show
} else if (result.reason === 'error') {
  report(result.error) // the handler threw
}
// 'busy': a submission was already in flight, so this one did not start.
// 'disposed': the form is gone.
```

Semantics:
- It validates first, unless `validateBeforeSubmit: false`. An invalid form marks every leaf touched, skips the handler and resolves `{ ok: false, reason: 'invalid' }`.
- `isSubmitting` is `true` while a submission runs, and `submitCount` counts the submissions that started. `submitError` holds what the last handler threw, and each new submission clears it. A validation failure throws nothing, so it leaves `submitError` empty.
- A handler that throws resolves `{ ok: false, reason: 'error', error }` by default (`onError: 'capture'`). `onError: 'rethrow'` rejects with the thrown value instead.
- `resetOnSuccess: true` calls `reset()` after the handler resolves. The default is `false`.

A union, rather than `{ ok, data?, error? }`, lets a caller tell "invalid" from "already submitting" without matching an error message (`.wiki/decisions/forms-are-read-signals.md`).

### 8.7 Zod integration (`@kontsedal/olas-zod`)

Zod is the de facto schema library; we ship a small adapter rather than baking Zod into core (Zod is ~13 kb, opt-in). `@kontsedal/olas-zod`'s two main helpers:

```ts
import { z } from 'zod'
import { zodValidator, createZodForm } from '@kontsedal/olas-zod'

// 1. Single-field validator
const email = createField(ctx, '', { validators: [zodValidator(z.string().email())] })

// 2. Whole form inferred from schema — types, structure, validators all from one source
const form = createZodForm(ctx, z.object({
  name: z.string().min(1),
  age: z.number().int().min(0),
  address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
  }),
  tags: z.array(z.string().min(1)),
}))

form.value
// { name: string; age: number; address: { street: string; city: string }; tags: string[] }
```

`createZodForm` walks the Zod schema:
- `z.object(...)` → `Form<...>` (recurses).
- `z.array(...)` → `FieldArray<...>` (recurses on element).
- Anything else → `Field<...>` with `zodValidator(elementSchema)` attached.

Each leaf field's initial is the Zod schema's default if present, otherwise an empty value for that type (`''` for string, `0` for number, etc.). The `initial` option overrides it, as a partial value or as a tracked function that re-seats a clean form (§8.4), with the same `resetOnInitialChange` choices. `extraValidators` adds validators to named fields beside the schema's own.

`createZodForm` enforces the schema's rules on objects and arrays, not only its leaf rules. Such a rule is a `.refine`, `.superRefine` or `.check` on an object or an array, or an array's `.min`, `.max`, `.length` or `.nonempty`. A rule on an `.optional()` or `.default()` wrapper around one counts too. When the schema has one, the root form gets a form-level validator that parses the whole schema, and each issue routes by its path (§8.3):

- an empty path lands in `form.topLevelErrors`;
- a nested object's path lands in that nested form's `topLevelErrors`;
- an array's path, as from `z.array(...).min(3)`, lands in that `FieldArray`'s `topLevelErrors`;
- a path at or under a leaf, as from `.refine(fn, { path: ['confirm'] })`, lands on that field.

An issue at a leaf is dropped when the leaf's own schema reports the same message for the same value, so each message appears once. A schema with no such rule gets no whole-schema validator, and a change runs only the changed leaf's validators.

`zodValidator(schema)` returns a `Validator<T>` that runs the schema through the Standard Schema interface (`validator(schema)`, §8.1) and reports **all** issues as `FormIssue[]`, each carrying its `path`. As a leaf field validator the paths are empty and collapse to messages; as a whole-object form-level validator the paths route each issue onto the matching field (§8.3). An async schema (`.refine(async ...)`) is awaited. `zodValidatorAsync(schema)` is the variant that honours the validator's `AbortSignal` and reports the first issue only.

Olas core stays Zod-free; `@kontsedal/olas-zod` has peer dependencies on `zod` 4 and `@kontsedal/olas-core` (§19.7).

---

## 9. Throttle, debounce, and timing

Derived signals — no `ctx` needed:

```ts
const query = signal('')
const debouncedQuery = debounced(query, 300) // TimingSignal<string>, lags by 300ms
const throttledScroll = throttled(scrollY, 100)
```

A `TimingSignal<T>` is a `ReadSignal<T>` with three more methods: `flush()` emits the pending value now, `cancel()` drops it, and `dispose()` releases the source. Both take `{ leading, trailing, signal }`: `debounced` defaults to the trailing edge, `throttled` to both edges. A timing signal holds a subscription to its source, so release it with `dispose()` or an aborting `options.signal`; in a controller, dispose it from `ctx.onDispose` (§4). Core ships no function-level `debounce`: debounce the signal a method reads instead.

---

## 10. Dependency injection

```ts
const root = createRoot(rootController, {
  deps: {
    api: realApiClient,
    session: sessionStore,
    logger: console,
  },
  queries: queryEngine(),
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

For tests, pass mocked deps to `createRoot` or `createTestController` (§17.1), and the whole tree runs against them. Query fetchers and `mutate` receive the same `deps` in their context (§5.2, §6), so a mock reaches them too.

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

Services can be plain objects, Olas roots themselves, or anything else with a `.value` signal-like surface. The point is: **deps is the right home for app-wide state**, not only stateless API clients.

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
  queries: queryEngine(),
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
- `defineScope<T>({ default, name })` accepts a default that's used when no provider exists, and a `name` that error messages use.
- Providing the same scope at a deeper level *shadows* the ancestor's value for that sub-tree.
- Two sources seed scopes above the root controller. A plugin can `host.provide(scope, value)` during its setup, which is how a plugin exposes a service (§13.1). `RootOptions.scopes` binds `[scope, value]` pairs, and those win over a plugin's, so a test can stand a fake in for a plugin's service.
- `root.inject(scope)` resolves a scope from outside the tree, as the root controller would.
- The provided value is a snapshot — re-providing with a new object replaces it (and notifies signal-aware consumers).
- For a reactive scope value, provide a signal-bearing object: `ctx.provide(orgScope, { orgId, orgName })` where these are signals.

Why scopes vs deps:
- **Deps** is for app-wide services that are stable for a root's lifetime.
- **Scopes** is for hierarchical data that varies by subtree and is provided/consumed at specific layers.

Scopes are slightly weaker than props for static traceability (a consumer's signature doesn't tell you who provides it), but they're **typed and named** — `grep "provide(orgScope"` finds every provider. Use them for true domain-scoped concerns, not as a general bypass for props.

#### When to use a scope — and when not to

Scopes are the most easily abused primitive in the library. Used well, they remove painful prop-drilling for hierarchical data. Used carelessly, they turn into React Context 2.0: invisible coupling, hard-to-trace dependencies, provider spaghetti.

**Use a scope when:**

- The data is **domain-hierarchical** — there's a level in your controller tree where it's introduced, and every controller below that level conceptually exists *within* that domain. Classic examples: `orgId`, `workspaceId`, `documentId`, `experimentBucket`.
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

**The litmus test:** if a junior engineer reading your controller can't answer "where does this value come from?" in 10 seconds, you've overused scopes. Scopes are a memory-and-typing convenience, not a substitute for explicit parameterization. The default move is props; reach for a scope when the prop-drilling cost is real and the data is hierarchical.

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
const items = useValue(conversations.items)
items.map(({ key, api }) => <ConversationView key={key} api={api} />)
```

The collection subscribes to `source`. On each change it diffs by `keyOf`:

- **New keys** → construct a child controller via `controller` with `propsOf(item)`.
- **Removed keys** → dispose that child controller (recursive disposal, same as parent-driven).
- **Unchanged keys** → leave the child in place; its props **are not** re-applied. Controllers own their state past construction.

Item *content* can change under the same key, with new fields. A child that needs to react should consume that data through a signal passed in `propsOf`, rather than expecting `propsOf` to be re-invoked.

Collections solve two problems at once: dynamic lifecycles, and **per-item subscription performance**. Each child controller owns its own signals, so UI items can subscribe only to *their* signals. The parent list re-renders only when items are added or removed. Item internals re-render only when their own signals change.

For non-controller-worthy items (plain data), a `computed(() => list.value.find(...))` is fine — accept the linear search up to a few thousand items.

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

// items signal — the api is the union of every branch's controller api
blocks.items.value
// Array<{ key, api: TextBlockApi | CodeBlockApi | ChartBlockApi }>
```

`ctx.collection` accepts **either** the homogeneous form of `controller` plus `propsOf`, **or** the factory form `factory: (item) => { controller, props }`. Never both. The factory runs for each item on every change of `source`. A key whose factory now picks a different controller is disposed and reconstructed; one that picks the same controller keeps its child, and its props are not re-applied.

Both forms take an optional `deps` override for the children, like `ctx.child`. A collection also exposes `suspendItem(key)`, `resumeItem(key)` and `isItemSuspended(key)`, so a virtualized list can freeze the rows scrolled out of view without disposing them (§4.1). A construction error in one item goes to `onError` with `kind: 'construction'`, and the collection skips that item (§12.1).

This makes `ctx.collection` the single primitive for plugin, block and widget containers. Document editors, dashboards, page builders, IDE panels — anywhere the children are typed-per-item.

**Ephemeral controllers — `ctx.attach`.** A child controller sometimes exists only for a transient interaction: a modal, an edit session, a tooltip, an open command palette. `ctx.child` is the wrong primitive there, because it lives until the parent disposes. Use `ctx.attach`, which returns the api together with a handle on the child's lifecycle:

```ts
const editor = ctx.attach(richEditorController, { initial: content })

// use editor
await editor.api.save.run({ content: editor.api.draft.value })

// dispose explicitly when done
editor.dispose()
```

Lifetime is bounded by whichever comes first: the explicit `dispose()` you call, or the parent's disposal. The handle's `suspend()` and `resume()` freeze and thaw the child without disposing it (§4.1). `<SuspendOnUnmount>` in the React adapter takes the handle as it is (§16.1). All three are idempotent.

Use cases:

- Modal forms: open, edit, save or cancel, dispose.
- Inline edit sessions: one row enters edit mode, commits, disposes.
- Wizards: each step's controller lives for its step.
- Command palette: constructed when opened, disposed when closed.

### 11.2 When to use controllers vs raw signals

Controllers are the unit of *testable logic*. Each one is a small program with its own lifecycle, its own primitives, and its own public surface. They earn their cost. The runtime cost is per-instance allocations, subscriptions and devtools events. The conceptual cost is that you have to think about where each one lives in the tree.

Use a **controller** when each item is its own small program. Examples: an open chat in messenger, a tab in a tabbed editor, an active video player, a row in an editable spreadsheet of a few hundred rows. The signals it owns, the mutations it exposes, and its per-item lifecycle all justify a dedicated controller.

Use **plain signals or maps of signals** when items are homogeneous data with no per-item behavior worth testing in isolation. Examples: posts in an infinite news feed at 10,000 visible, cells in a spreadsheet grid at 100,000, nodes in a virtualized tree, comments past the first ten. These belong as data inside a parent controller. The parent owns one or many signals that hold the collection, and the UI subscribes to per-item slices. The usual shapes are `computed(() => bigMap.value.get(id))` or per-item signals stored in a `Map<Key, Signal<Item>>`.

A rule of thumb. **If the per-item logic would have less than three lines in its own controller factory, it is data, not a controller.** Choose a controller if you need per-item mutations, lifecycle, scopes, validators or composition. Choose a signal if you only need to read and write a field.

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

If a row needs row-scoped logic that's worth a controller (e.g. a row enters edit mode), use `ctx.attach(rowEditorController, ...)` on demand. Dispose the handle on commit/cancel — controllers exist only while editing.

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

`context` is an `ErrorContext` (§20.9):
- `kind` — `'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'`;
- `controllerPath` — the path from the root to the controller that owned the failing code;
- `queryId` and `key` — the cache entry, for `cache` kinds;
- `pluginName` — the plugin, for `plugin` kinds (§13.1);
- `eventId`, `timestamp`, and `attempt` and `cause` where they apply, for correlating the error in a telemetry tool.

Default `onError` is `console.error`. The handler must never throw — if it does, we swallow and log to console.

### 12.1 Constructor errors

A controller's factory function can throw — typically because deps are misconfigured, props are invalid, or a constant-evaluation invariant is violated. Spec semantics:

1. **The throwing controller is not constructed.** Its API is never returned; `ctx.child(...)` re-throws synchronously.
2. **Already-constructed siblings stay alive.** If a parent constructed three children and the fourth's factory threw, the three are not torn down — they're functional.
3. **The throw propagates up.** If a parent's factory was the one calling `ctx.child(...)`, the parent's factory now throws too. This recurses up to the closest `try/catch` or to `createRoot` itself.
4. **Partially-constructed parents are rolled back.** When a parent's factory throws, every primitive and child the parent already created via `ctx` (before the throw) is disposed in reverse order of creation. The error then propagates further.
5. **`createRoot` does not swallow.** If construction reaches the root and throws, `createRoot` itself throws — *not* `onError`. Bootstrap failures are caller's responsibility, exactly like a top-level synchronous exception in `main()`.
6. **`root.onError` only fires for construction errors that happen *after* the root is alive.** Two examples: an `effect` that constructs a `ctx.child` lazily, and a `ctx.collection` factory that throws when a new item arrives. Those throws go to `onError` with `kind: 'construction'` and do not propagate. The collection skips the bad item, so the UI sees one fewer entry.

The rule of thumb: synchronous bootstrap errors throw out of `createRoot`; runtime construction errors (collection items, lazy children, schema-driven primitive creation) go through `onError`.

---

## 13. Plugins & persistence

A plugin extends every root it is installed in. It observes cache writes and mutation runs, wraps fetches and `mutate` calls, and can expose a service to controllers. §13.1 is the contract. §13.2 to §13.4 cover the first-party packages that keep state beyond one tab's memory: across tabs, across reloads for mutations, and across reloads for signals and the query cache. `PLUGINS.md` is the authoring guide, and §20.8 lists the types.

### 13.1 The plugin contract

```ts
import { definePlugin } from '@kontsedal/olas-core'

export const logger = definePlugin({
  name: 'logger',
  setup(host) {
    return {
      onWrite: (e) => console.log(e.query.id, e.source, e.origin),
    }
  },
})

createRoot(app, { deps, queries: queryEngine(), plugins: [logger] })
```

#### A definition, set up per root

A plugin is `{ name, setup(host) }`. `definePlugin` is an identity helper that types the literal. The value is a definition, not an instance: `createRoot` calls `setup` once per root, and per-root state lives in `setup`'s closure. One plugin value therefore serves any number of roots, including a `HydrationBoundary` that rebuilds its root under StrictMode.

- **`setup` runs in `plugins` order, before the root controller's factory.** The query client already exists at that point, so `setup` can read and write the cache. A mutation queue replays a previous session's writes from there (§13.3).
- **The name must be non-empty and unique among a root's plugins.** `createRoot` throws otherwise. The name attributes the plugin's errors (`ErrorContext.pluginName`), labels its devtools lane, and is the `origin` stamped on every write the plugin makes.
- **A plugin works without a query engine.** `host.queries` and `host.mutations` are then `null`. The router bridge is such a plugin: it only provides scopes (§16.5).

#### The host

`setup` receives a `PluginHost` for its root:

| Member | What it gives the plugin |
|---|---|
| `deps` | The root's `deps`. |
| `provide(scope, value)` | A service for every controller and for `root.inject`. Only during `setup`; a later call throws. |
| `reportError(err)` | A route to the root's `onError`, as `{ kind: 'plugin', pluginName }`. |
| `onDispose(fn)` | Teardown that runs after the plugin's `dispose` hook. |
| `track(promise)` | Makes `root.waitForIdle()` wait for the plugin's own work, such as a restore or a replay. |
| `network` | `isOnline()`, `onReconnect(fn)` and `onFocus(fn)`, shared with the query engine's own triggers. The host releases both subscriptions when the plugin is disposed. |
| `queries` | The root's cache, or `null` without a query engine (below). |
| `mutations` | `has(id)`, `get(id)` and `run(id, variables)` for mutations registered with `defineMutation`, or `null` without a query engine. |
| `debug(payload)` | A development-only payload on the plugin's devtools lane (§14). A no-op in production. |

`host.queries` addresses an entry by query `id` and entry `key`. The key is the output of the query's `key(...)`, not the arguments passed to it.

| `host.queries` member | Behaviour |
|---|---|
| `get(id)` | The `QueryRef` (`{ id, kind, meta }`) of a query this root has used: one it holds an entry for, or one a `bindQuery` reached. `undefined` otherwise. |
| `keys(id)` | The keys of every entry this root holds for the query. |
| `peek(id, key)` | An entry's data, without subscribing. For an infinite query, its pages. |
| `write(id, key, updater, options?)` | A canonical patch (§6.4): no snapshot, and a fetch in flight is left alone. A no-op when the root holds no entry for the key. |
| `replace(id, key, value, options?)` | A canonical whole-record write that supersedes a fetch in flight. A no-op when the root holds no entry for the key. |
| `invalidate(id, key)` | Marks the entry stale. It refetches now when subscribed, else on the next subscribe (§5.7). |
| `hydrate(state)` and `dehydrate()` | What `root.hydrate` and `root.dehydrate` do (§15). |
| `hashKey(key)` | The stable hash the engine keys entries by. Two keys collide exactly when their hashes do. |

`write` and `replace` take `{ pageParams }` for an infinite query, so the entry's cursors stay aligned with the new pages.

`host.mutations.run(id, variables)` runs a registered definition through the engine's own runner. The definition's `retry` and `concurrency` apply, `mutate` receives the root's `deps`, and the run counts toward `root.waitForIdle()`. It rejects when no definition is registered under `id`, which happens until the module calling `defineMutation` has been imported. `get(id)` returns the definition's `MutationRef`, which is `{ id, meta }`. A plugin that replays stored runs checks that `meta` before it runs anything (§22).

#### The hooks

`setup` returns its hooks, or nothing. Every hook is optional.

| Hook | Fires when |
|---|---|
| `onWrite(e)` | A cache entry's data changed. |
| `onInvalidate(e)` | An entry was invalidated. `e` carries `query`, `key` and `origin`. |
| `onRemove(e)` | The cache collected an entry: its last subscriber left and `gcTime` passed. |
| `onActivate(e)` and `onDeactivate(e)` | An entry gained its first subscriber, or lost its last one. A second subscriber joining, or one of two leaving, fires nothing. |
| `onMutation(e)` | A mutation run moved a step. |
| `wrapFetch(ctx, next)` | Around every fetch attempt (middleware, below). |
| `wrapMutate(ctx, next)` | Around every `mutate` attempt. |
| `dispose()` | Once, when the root disposes. |

Observation hooks are synchronous and run after the change is visible to subscribers. A plugin that must hold a write until it has done something asynchronous uses `wrapMutate`, as the mutation queue does.

#### Write events: `source` and `origin`

A `WriteEvent` carries `query`, `key`, `data`, `updatedAt`, `source` and `origin`. `query` is the `QueryRef`, and `data` is the value after the write, or the pages for an infinite query. An infinite query's write also carries `pageParams`, one per page. Each write reports exactly once. A hydration, for example, reports one `'hydrate'` write and no fetch.

`source` says what produced the write:

| `source` | Produced by |
|---|---|
| `'fetch'` | A fetcher resolved; for an infinite query, every page batch. |
| `'hydrate'` | Dehydrated data reached the entry: SSR, streaming, a warm start from storage. |
| `'optimistic'` | `setData`, a guess a mutation may roll back. |
| `'rollback'` | An optimistic layer was undone. |
| `'write'` | `write`, a canonical patch. |
| `'replace'` | `replace`, a canonical whole record. |

`origin` says who asked for the write:
- the `name` of the plugin whose host made it;
- the `origin` given to `bindQuery(ctx, query, { origin })` or `root.bindQuery(query, { origin })`, so a realtime patcher can tag its writes;
- `undefined` for the app itself and for the engine's own fetches.

Invalidations carry `origin` by the same rule. Echo prevention follows from it with no flag in core. A relay skips the writes stamped with its own name, and it mirrors only the origins it means to. Cross-tab mirrors the app's own writes, and leaves a write another plugin derived to that plugin in each tab (§13.2).

A plugin that persists or relays state takes the canonical sources only. `'optimistic'` and `'rollback'` are guesses the server has not confirmed.

#### Mutation events

`onMutation` fires for every run, with or without an `id`. Each run reports `'start'` after `onMutate` and before the first `mutate` call. Then it reports exactly one outcome: `'success'`, `'error'` once retries are exhausted, or `'cancel'` for a supersede, a `reset()` or the owner's disposal. A `MutationEvent` carries `mutation`, its `MutationRef`, and `runId`, `variables` on every phase, `result` on success, `error` on error, and `origin`. `origin` names the plugin that started the run through `host.mutations.run`, and is `undefined` otherwise.

A run whose work completed reports `'success'` even when an abort beat its continuation (§6.2). A queue that read `'cancel'` as "replay this on the next load" would otherwise send a write the server already accepted.

#### Middleware

`wrapFetch(ctx, next)` and `wrapMutate(ctx, next)` run around every attempt, retries included. `next()` runs the inner chain, with the fetcher or `mutate` innermost. A wrapper can return `next()`'s promise, transform its result, call it again to retry, or answer without calling it. A throw fails the attempt like a fetcher throw. Wrappers compose in `plugins` order, the first plugin outermost.

A `FetchContext` carries `query`, `key`, the fetcher's `args`, `signal`, `attempt` (0 first, one more per retry) and, for an infinite query, `pageParam`. A `MutateContext` carries `mutation`, `runId`, `variables`, `signal`, `attempt` and `origin`. Auth refresh, tracing, logging and canned test responses are all middleware; `examples/kanban/src/tracing.ts` times each attempt.

#### Lifecycle

- **A `setup` throw aborts `createRoot`.** The plugins already set up are disposed first, in reverse order, and then the query client. The root factory never runs.
- **A hook's throw is isolated to its plugin.** It reaches `onError` as `{ kind: 'plugin', pluginName }`, and the next plugin's hook still runs. A throw from `dispose` or an `onDispose` function is reported the same way.
- **No hook runs once the root starts disposing.** `root.dispose()` closes delivery first, so nothing the teardown itself causes, such as entries releasing or runs cancelling, reaches a plugin.
- **Teardown order.** After delivery closes, the controller tree disposes. Then the plugins dispose in reverse `plugins` order: each plugin's `dispose` hook first, then its `onDispose` functions, last registered first. The query client disposes last.
- **`root.waitForIdle()` waits for plugin work.** It alternates between the cache's idle wait and the promises plugins `track`ed, until neither moves.

`.wiki/decisions/plugin-host-v2.md` records why the contract is shaped this way, and `packages/core/tests/plugin-host.test.ts` pins each rule above.

#### Services through scopes

A plugin exposes a service by providing a scope during `setup`:

```ts
export const Traces = defineScope<TraceService>({ name: 'Traces' })

const tracing = definePlugin({
  name: 'tracing',
  setup(host) {
    host.provide(Traces, createTraceService())
  },
})

// in any controller
const traces = ctx.inject(Traces)
```

The scope is seeded before the root factory runs, so every controller sees it (§10.3). `root.inject(Traces)` reaches it from outside the tree. A `RootOptions.scopes` binding for the same scope wins, which is how a test stands a fake in. `@kontsedal/olas-entities` provides its store as `Entities`, `@kontsedal/olas-mutation-queue` provides `MutationQueue`, and the router bridge provides the route scopes.

#### Typed settings: `QueryMeta` and `MutationMeta`

`QuerySpec.meta` and `MutationSpec.meta` carry per-query and per-mutation settings for plugins. Both types are empty interfaces in core. A plugin package declares its fields by module augmentation:

```ts
declare module '@kontsedal/olas-core' {
  interface QueryMeta {
    audit?: boolean
  }
}
```

`meta` then accepts exactly what the installed plugins understand, and core never reads it. A plugin reads it back as `event.query.meta`, `host.queries.get(id)?.meta`, `event.mutation.meta` or `host.mutations.get(id)?.meta`. The first-party fields are `QueryMeta.crossTab` (§13.2), `QueryMeta.persist` (§13.4) and `MutationMeta.persist` (§13.3).

#### Identity inside a root

Each root indexes the queries it has bound by `id`, and `host.queries` reaches only those. There is no process-wide query registry, so a duplicate `id` is a collision within one app, and development builds warn about it. The mutation registry is process-wide, because a replay must find a definition before any controller exists.

#### Testing a plugin

`createTestController(def, { plugins })` installs plugins on a test root. `@kontsedal/olas-core/testing` adds two plugins. `createPluginRecorder()` records every observation event a root emits, for assertions on `source`, `origin` and mutation phases. `mockFetchPlugin(handlers)` answers fetches by query `id` through `wrapFetch`, without running the fetchers.

### 13.2 Cross-tab in-memory cache sync

`@kontsedal/olas-cross-tab` mirrors cache writes and invalidations across browser tabs of the same origin, over `BroadcastChannel`. `@kontsedal/olas-persist` (§13.4) syncs *persisted* state; this syncs *in-memory* query cache entries that never touch disk. Both are opt-in and independently configurable; combining them for the same logical state is supported but redundant.

A query opts in with `meta: { crossTab: true }`, a field cross-tab adds to `QueryMeta`. The send side and the receive side both check it. Regular and infinite queries sync alike, and an infinite query's pages travel with their `pageParams`, so the receiving tab keeps paging from them.

```ts
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'

const userQuery = defineQuery({ id: 'users/detail', key, fetcher, meta: { crossTab: true } })

createRoot(appController, {
  queries: queryEngine(),
  deps,
  plugins: [crossTabPlugin({ channelName: 'my-app/cache/v1' })],
})
```

**What crosses.**
- Writes and invalidations the app made itself, with `origin: undefined` (§13.1). A write another plugin made is usually derived: a realtime push every tab receives, or the entities a mirrored query write carries, which every tab's own entities plugin walks. Mirroring it would deliver it twice. `origins: [name, …]` opts named origins in. A direct `entities.update(...)` is the case to opt in for, because no peer re-derives it (§18.1).
- `'optimistic'` and `'rollback'` writes by default, so a peer shows a pending edit before the server confirms it. `optimistic: false` limits the channel to canonical writes and invalidations.
- Never `'fetch'` or `'hydrate'` writes. Every tab runs its own fetcher, and relaying results would be quadratic noise.

**Receiving.** A peer's write goes through `host.queries.write`, so it carries the plugin's name as `origin` and is never mirrored back. A tab applies it only to an entry it holds, and a key it has never loaded fetches for itself on first subscribe. A peer's invalidation refetches an entry only when that tab subscribes to it. `validate(queryId, data)` lets a tab reject a payload shape it did not expect; any same-origin script can post on the channel (§22).

**Echo prevention is layered.** First, the plugin mirrors no write stamped with its own name. Second, messages carry a `sourceId`, and a root drops its own. Third, messages carry a monotonic `msgId`, and a receiver drops a duplicate or out-of-order message, and one whose `msgId` is not a safe non-negative integer.

**Channel-name versioning.** Channel names are user-supplied. Receivers drop messages whose protocol `v` they don't understand; users who want clean cross-deploy isolation should include a version suffix in their `channelName` (e.g. `'my-app/cache/v2'`).

**Non-cloneable values.** `BroadcastChannel` uses structured clone. Cache data carrying a function or a symbol cannot cross the boundary, and a class instance arrives as a plain object without its prototype. The plugin catches the `DataCloneError`, calls `onWarn(...)`, and drops the message; the sender's cache is unaffected. `maxPayloadBytes` (default 512 KB) warns about an oversized message and still posts it. Without `BroadcastChannel`, as during SSR, the plugin installs no hooks.

**Devtools lane.** In a development build (§23) the plugin reports through `host.debug` each message it posts and each message a peer sent on this protocol version. A payload names the direction (`kind: 'send' | 'receive'`), the message `type`, the `queryId` and key, the sender's `sourceId` as `from`, the `msgId`, and an `outcome`. A send is `posted` or `not-cloneable`. A receive is `applied`, `duplicate`, `malformed`, `ignored` (a query this tab has not bound or opted in), `rejected` (by `validate`) or `failed` (applying it threw).

### 13.3 Mutation queue — reload-safe replay

`@kontsedal/olas-mutation-queue` persists runs of opted-in mutations and replays the ones a reload or a lost connection interrupted. A mutation opts in on its definition with `meta: { persist: true }`, a field the package adds to `MutationMeta`. Nothing persists by default.

```ts
import { localStorageAdapter } from '@kontsedal/olas-persist'
import { MutationQueue, mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'

export const createOrder = defineMutation({
  id: 'order/create',
  mutate: (vars: OrderInput, { signal, deps }) => deps.api.createOrder(vars, { signal }),
  meta: { persist: true },
})

createRoot(app, {
  deps,
  queries: queryEngine(),
  plugins: [mutationQueuePlugin({ storage: localStorageAdapter(), keyPrefix: 'my-app/mutations/v1' })],
})

// anywhere: replay now instead of on the next load or reconnect
await ctx.inject(MutationQueue).replayNow()
```

**Per run**, through the plugin's `onMutation` and `wrapMutate` hooks:
- On `'start'` the plugin records the run. Its `wrapMutate` writes the durable entry on the first attempt, before calling `next()`, so the entry is in storage before the request goes out.
- `'success'` deletes the entry, and also the entries earlier failed runs of the same operation left.
- `'error'` deletes the entry once `attempts` reaches `maxAttempts` (default 5), or when `isRetryable(err, entry)` returns `false`, and keeps it for the next load otherwise. A deleted entry is reported through `onReplayError`. A replay's failure goes through the same test.
- `'cancel'` keeps the entry. A reload mid-run looks the same as a cancel from here, so the next start replays it.

**Replay.** At setup, and again on reconnect, the plugin lists the keys under `keyPrefix`, checks each entry, and groups the entries by mutation id in `seq` order. Two tabs can mint the same `seq`, so `runId` breaks a tie, and every tab sorts the same entries the same way. It replays each group serially through `host.mutations.run`, so the definition's `retry` applies and `mutate` receives the root's `deps` (§13.1). It replays only a definition whose `meta.persist` is `true`, and it requires each entry's storage key to match its contents (§22). A startup replay that begins online is `track`ed, so `root.waitForIdle()` waits for it; one that begins offline waits for the reconnect instead. A cross-tab lock, through the Web Locks API with a `localStorage` lease as the fallback, keeps two tabs from replaying the same entries at once.

A replay writes server state no live query knows about. `onReplaySettle(entry, result, queries)` receives the root's `QueryHost` to reconcile the cache, typically with `queries.invalidate(id, key)`.

**Delivery is at-least-once until success.** The queue does not deduplicate on the server. Include an idempotency key in the variables and have the server deduplicate by it. `dedupeBy` collapses duplicate enqueues on the client only. Variables must be JSON-serializable. A run whose variables are not still runs, and the plugin reports through `onWarn` that it is not durable.

**Devtools.** In its development build (§23), the plugin publishes each replay attempt, the attempt's result, and each entry a pass skips on its lane through `host.debug` (§14). A payload carries the entry's `mutationId` and `runId`, the attempt number, and the result or skip reason. It carries no variables.

### 13.4 Persistence

`@kontsedal/olas-persist` covers two kinds of state: a signal that should survive a reload, and the query cache as a whole.

**A persisted signal** is a composable, not a built-in primitive:

```ts
import { createPersisted, localStorageAdapter } from '@kontsedal/olas-persist'

const draft = signal('')
const { ready } = createPersisted(ctx, 'draft', draft, {
  storage: localStorageAdapter(), // the default; indexedDbAdapter() or a custom StorageAdapter
  serialize: JSON.stringify, // default
  deserialize: JSON.parse, // default
  crossTab: false, // opt-in sync through storage.onChange
})
```

`createPersisted` is bound to `ctx`, so it cleans up its subscriptions on dispose. The source is any signal-like value with `value`, `set` and `subscribe`: a `Signal`, a `Field`, or a custom trio. Loading the initial value is synchronous for localStorage. For an async storage the source holds its default until the load settles, and `ready` turns `true` then. A user write that lands **before** an async load settles is not lost. It wins over the stored value, and over a cross-tab change that also raced the load, and it is flushed to storage. A cross-tab change that races the load is buffered and applied once ready. Fallible operations (`get`/`set`, `serialize`/`deserialize`, `migrate`, cross-tab `onChange`) route through the optional `onError(err, op, key)` — without it, errors are swallowed. `version` + `migrate` enable a `{"$olas":1,"v":N,"d":…}` on-disk envelope with forward migration; `throttleMs` throttles writes (flushed on dispose). A reader without `version` unwraps that envelope. Without `version`, a value is written raw, unless a reader could take it for an envelope: then it is wrapped as `{"$olas":1,"d":…}`, so it reads back as itself. The unmarked `{"v":N,"d":…}` of earlier versions is an envelope only to a reader with `version`. The source's `subscribe` handler is skipped for a call made while `subscribe()` runs, which is a signal's delivery of its current value; every later call is a change and is written.

Cross-tab sync is opt-in and only supported by storages that emit change events (localStorage via the `storage` event). The localStorage adapter is SSR-safe: without `localStorage`, every read is `null` and every write a no-op. `clearPersisted(storage, { prefix })` deletes the keys under a prefix, and `{ all: true }` deletes every key the adapter enumerates. With neither, it throws, because the default adapter is the whole origin's `localStorage`.

**The query cache** persists through a plugin:

```ts
import { persistQueryCachePlugin } from '@kontsedal/olas-persist'

const settingsQuery = defineQuery({ id: 'settings', key: () => [], fetcher, meta: { persist: true } })

createRoot(app, { deps, queries: queryEngine(), plugins: [persistQueryCachePlugin()] })
```

- A query opts in with `meta: { persist: true }`, a field persist adds to `QueryMeta`, or through the plugin's `include` option.
- The plugin writes every canonical write of an opted-in query to storage: a fetch, a `write`, a `replace` or a hydration. It skips `'optimistic'` and `'rollback'` writes. It throttles the storage writes, one per `throttleMs` (default 1000). An entry the cache collects is dropped from storage too.
- With synchronous storage the plugin restores during `setup`, before any controller subscribes, so a restored entry is there on the first read. With asynchronous storage the restore lands later, is `track`ed, and fills only entries no subscription has bound yet. `restoreQueryCache(options)` reads the stored cache before `createRoot`, for an app whose first render must see it; pass its result as `hydrate` and set `restore: false`.
- A restore discards a cache stored under a different `buster`, an entry older than `maxAgeMs`, and an entry dated in the future (§22). `maxAgeMs` defaults to 24 hours.

---

## 14. Devtools

The root exposes a `debug` bus — an event stream plus a live cache snapshot:

```ts
root.debug.subscribe((event) => {
  // structured DebugEvent, see below
})
root.debug.queryEntries() // DebugCacheEntry[] — current state of every cache entry, with its queryId
```

A new subscriber first receives a replay of the live controller tree, so a panel that mounts after `createRoot` sees the existing tree at once. No other event type is buffered.

### 14.1 Event families

`DebugEvent` is a discriminated union on `type`:

- `controller:constructed | suspended | resumed | disposed` — `{ path }` (`constructed` also carries `props`, and any variables the controller registered via `ctx.debug({...})` during construction as `debug`).
- `controller:debug` — `{ path, values }`. A `ctx.debug({...})` call *after* construction, for example from an effect. It carries the controller's full merged variables record as live references.
- `cache:subscribed | fetch-start | fetch-success | fetch-error | invalidated | gc` — `{ queryKey }`, and `queryId` on every one but `subscribed` (`fetch-success`/`fetch-error` add `durationMs`, `fetch-error` adds `error`, `subscribed` adds `subscriberPath`).
- `cache:set-data` — `{ queryId, queryKey, source, data }`. Emitted on every cache write; `data` is the post-write value and `source` is the plugins' `WriteSource`: `'fetch' | 'hydrate' | 'optimistic' | 'rollback' | 'write' | 'replace'` (§13.1). This is what lets a panel show *current* data without polling.
- `snapshot:push | rollback | finalize` — `{ queryKey }`. The optimistic-update stack (§6.4): a tracked `setData` pushes, a mutation error and supersede rolls back, a mutation success finalizes.
- `mutation:run | success | error | rollback` — `{ path, name? }`, where `name` is the mutation's `id` (`run` adds `vars`, `success` `result`, `error` `error`).
- `field:validated` — `{ path, field, valid, errors }`.
- `plugin:event` — `{ plugin, payload }`. A plugin published `payload` on its lane through `host.debug(...)` (§13.1).

### 14.2 Correlation fields (every event)

Every *delivered* event also carries `seq` and `t`, and — where core can cheaply attribute one — a `causeId`:

- `seq` — a monotonic, per-root sequence number stamped by the bus. The canonical sort key for a timeline (wall-clock `t` can tie under a burst, and is approximate for events replayed to a late subscriber).
- `t` — epoch-ms timestamp.
- `causeId` — correlates every event produced by one cause into a group. A mutation run's id flows into the optimistic `cache:set-data`, the `snapshot:*` events, the `mutation:rollback`, and the mutation's own lifecycle events. A fetch's id flows into its `cache:fetch-*` and the `cache:set-data` it writes. Absent for an un-attributable write (e.g. a bare `query.setData(...)` outside any mutation).

These three are optional on the `DebugEvent` *type* (so tooling can construct events by hand), but the bus always stamps `seq`/`t` on delivery.

`@kontsedal/olas-devtools` consumes this stream as an in-app panel. Its headline view is a causal **Timeline**: events grouped by `causeId` into cause-chains, each `cache:set-data` expandable to a structural before-and-after diff, with one lane per plugin for `plugin:event`. Alongside it sit a controller tree, where each node shows its `ctx.debug` **Variables** live, plus the cache log, the live cache inspector, and the mutation and field views. The timeline keeps a ring of the newest events, 10,000 by default through `maxTimelineEntries`. The long lists are windowed. An omnibox, focused with `/`, searches controllers, queries, mutations, fields and events. `.wiki/decisions/devtools-overhaul.md` records the design.

The schema is stable enough to build tooling on, but isn't a public API guarantee — internal events may be added, and consumers `switch` on `type` and ignore unknowns. All events and the bus itself are dev-only. Production builds strip every `emit(...)` call site behind `__DEV__`, so no events arrive (§23).

---

## 15. SSR — dehydrate & hydrate

Core ships serialization primitives, not framework-specific SSR glue. The React adapter builds streaming SSR on top of them (§16.1).

```ts
// server
const root = createRoot(rootController, { queries: queryEngine(), deps: serverDeps })
await root.waitForIdle() // resolves when no fetches in flight
const state = root.dehydrate() // JSON-serializable snapshot of the query client

// client
const root = createRoot(rootController, {
  queries: queryEngine(),
  deps: clientDeps,
  hydrate: state, // restores query client cache entries
})
```

`waitForIdle()` resolves when:

- No cache entry has a fetch in flight.
- No mutation is in flight, queued `serial` runs included.
- No work a plugin `track`ed is pending (§13.1).

`dehydrate()` only serializes the **query client cache**: `id`, `key`, `data` and `lastUpdatedAt` for every settled entry. Controller state isn't serialized — controllers reconstruct from their props on the client. **Infinite queries dehydrate too.** Their entries carry the pages as `data` and the page params as `pageParams`, so the client continues paging where the server stopped (§5.11).

Each serialized entry carries its query's `id` alongside its key. Every shared query has an `id` (§5.2), so every settled entry dehydrates. IDs must be unique per query and identical in server and client bundles; registration order never identifies hydrated data. Hydration is namespaced by `id + key hash`, so two queries whose keys match cannot adopt one another's data. An entry that arrives before any subscription binds its key waits in a buffer, and the first binding adopts it. Hand-authored payloads must use the target query's `id`. Core checks the payload's `version` and each entry's shape, and skips an entry it cannot read (§22).

**Hydrating a live root.** `root.hydrate(state)` applies a payload after `createRoot`. An entry whose key is already bound is written through and supersedes the fetch in flight for it; the rest wait in the buffer. Streaming SSR uses this: each resolved `<Suspense>` boundary pushes its entries into the client root (§16.1). A root without a query engine discards the payload, with a development warning.

**Inlining the payload.** `serializeForScript(state)` writes a value for an inline `<script>` without opening an injection hole. It returns `JSON.parse("…")` over the JSON, with every character that could end the string, the script or an attribute escaped (§22):

```ts
const html = `<script>window.__STATE__ = ${serializeForScript(root.dehydrate())}</script>`
```

---

## 16. UI adapter contract

Adapters live in small separate packages: `@kontsedal/olas-react`, `@kontsedal/olas-vue` and `@kontsedal/olas-svelte`. Preact runs the React adapter through `preact/compat`. Every adapter keeps the same contract:

- **The root is created once, outside the UI**, typically near `main.tsx`. The adapter hands it to the component tree through the framework's own context.
- **A component reads the root's `api`**, never the root handle's controls: `useRoot()` in React and Vue, `getRoot()` in Svelte.
- **A signal becomes the framework's reactive value**, and the component re-renders when a value it reads changes. The adapter ends the subscription when the component goes.
- **Actions pass through unchanged.** A component calls a controller method, or `mutate` and `run` on a mutation; the adapter adds no state of its own.

The adapter is the **only** code that knows about a UI framework. Everything else is pure TS. `.wiki/decisions/framework-adapters.md` records how each adapter maps a signal, and the parity suite in `packages/integration/tests/adapter-parity/` drives the same scenarios through React, Preact, Vue and Svelte and asserts the same DOM.

| Adapter | A `ReadSignal<T>` becomes | Re-render granularity |
|---|---|---|
| React | a value read through `useSyncExternalStore` | per field read during render (`useQuery`, `useInfiniteQuery`); per hook elsewhere |
| Vue | a read-only `Ref<T>` | per ref, which Vue tracks on its own |
| Svelte | itself: a signal already satisfies the store contract | per `$store` |

There is no vanilla DOM adapter. One was specced here, built, measured and dropped: any consumer shipping `@kontsedal/olas-core` has already spent the bundle budget a hand-rolled binder was meant to save, so a real framework costs nothing extra. A consumer who wants a smaller runtime uses the React adapter through `preact/compat`. See `.wiki/decisions/no-vanilla-adapter.md`.

### 16.1 React (`@kontsedal/olas-react`)

```tsx
// main.tsx
const root = createRoot(appController, { deps, queries: queryEngine() })

declare module '@kontsedal/olas-react' {
  interface Register {
    root: typeof root
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)

// inside any component
function UserProfile() {
  const app = useRoot()                             // the root's api, typed through Register
  const { data, isLoading } = useQuery(app.userProfile.user)
  const isEditing = useValue(app.userProfile.isEditing)
  return /* ... */
}
```

Hooks build on `useSyncExternalStore`, so reads are concurrent-safe and do not tear.

- **`useRoot()`** returns `root.api` from the nearest `<OlasProvider>`, and throws outside one. The `Register` augmentation types it once for the app. Without a registration it returns `unknown`, and `useRoot<Api>()` names the type per call. `createOlasContext<Api>(displayName?)` gives each of several roots its own `Provider` and a typed `useRoot`.
- **`useValue(signal, options?)`** reads any `ReadSignal`: a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`. `select` projects the value and `isEqual` decides when a new value re-renders.
- **`useQuery(subscription)`** returns the whole `AsyncState` as plain values, with the actions `refetch`, `reset` and `cancel`. The values are `data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `isPaused`, `isEnabled`, `lastUpdatedAt` and `hasPendingMutations`. **It re-renders only for the fields the component read during render.** The result is a tracked snapshot. Its getters record each field read, and the subscription notifies React only when one of those moves. A read after commit returns the live value. Until the component reads anything, every change notifies.
- **`useQuery(subscription, { suspense: true })`**, or `useSuspenseQuery(subscription)`, suspends until the first value and types `data` as present. On a disabled query it suspends until the query is enabled and loaded (§5.2), with a one-time development warning.
- **`useInfiniteQuery(subscription)`** does the same for an infinite subscription, adding `pages`, `flat`, the paging flags, `fetchNextPage` and `fetchPreviousPage`. A list that renders `flat` and `hasNextPage` does not re-render while `isFetchingPreviousPage` flips.
- **`useField(field)`** returns the field's state as plain values plus its methods, in one subscription. `useFieldInput(field, { transform?, name? })` returns `value`, `onChange`, `onBlur`, `name` and `aria-invalid`, ready to spread onto a native input.
- **`useMutation(mutation, callbacks?)`** returns the mutation's state (`status`, `isPending`, `isIdle`, `isSuccess`, `isError`, `data`, `error`, `lastVariables`) and two triggers. `mutate(vars)` is for an event handler: it returns nothing, and a failure lands on `error` and in `onError`, never as an unhandled rejection. `run(vars)` returns the run's promise, and the caller owns its rejection. Concurrency is configured on the mutation in the controller.

`useField` in practice:

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

**Suspension helpers.** Unmounting a component disposes nothing: the root lives on, and sub-controllers are owned by their parent. For UI-driven suspension (hidden tabs, router caches):

- `<SuspendOnUnmount controller={handle}>` resumes `handle` when the first consumer mounts and suspends it when the last one unmounts. It takes anything with `suspend()` and `resume()`, such as an `attach` handle (§11.1) or the root.
- `useSuspendOnHidden(handle)` suspends while `document.visibilityState` is `'hidden'` and resumes on visible.

Without these, you call `suspend()` and `resume()` yourself; the adapter doesn't drive lifecycle implicitly.

**SSR and streaming.** `<HydrationBoundary def={appController} options={rootOptions}>` builds the client root from `options`, including `options.hydrate`, provides it, and disposes it on unmount. It survives a StrictMode remount, and by default it installs the streaming intake. On the server, `createStreamingHydrator({ nonce? })` returns a `plugin` for the server root and a `flush()` that drains the settled entries as one `<script>` tag. `createStreamingTransform(flush)` places those tags into a `renderToReadableStream` stream only where the HTML so far sits between elements, because a chunk can end inside a tag or an attribute. `OLAS_BOOTSTRAP_SCRIPT` goes into React's `bootstrapScriptContent`, and `installStreamingIntake(root)` connects a client root that is not built by a `HydrationBoundary`. The payload goes through `serializeForScript`, and the `nonce` covers a Content-Security-Policy (§22).

### 16.2 Vue (`@kontsedal/olas-vue`)

```ts
// main.ts
const root = createRoot(appController, { deps, queries: queryEngine() })
createApp(App).use(olasPlugin(root)).mount('#app')

// <script setup> in any component
const app = useRoot()
const { data, isLoading } = useQuery(app.user)
const count = useValue(app.count) // count.value in script, {{ count }} in a template
```

`olasPlugin(root)` provides the root to the whole app. `useRoot()` returns its `api` and is typed by the same `Register` augmentation, declared on `@kontsedal/olas-vue`. `useValue(signal)` returns a read-only `Ref<T>`, and `useQuery`, `useInfiniteQuery`, `useField` and `useMutation` return one ref per field (`Refs<T>`) plus the actions. Vue's own dependency tracking re-renders a template only for the refs it read, so the adapter tracks nothing itself. A ref's getter reads `signal.peek()`, so a write is visible to the next read before Vue flushes. `useField(field).value` is a writable ref that writes through `field.set`, which makes it work with `v-model`. `useMutation` returns `mutate` and `run` with the React adapter's semantics. Every subscription ends with the current effect scope. A hook called outside one still returns working refs, but nothing ends their subscriptions, so a development build warns once per hook, naming it.

### 16.3 Svelte (`@kontsedal/olas-svelte`)

```svelte
<script>
  import { getRoot, queryStore } from '@kontsedal/olas-svelte'
  const app = getRoot()
  const count = app.count // a signal is a store as it is
  const user = queryStore(app.user)
</script>

<p>{$count}</p>
{#if $user.isLoading}Loading…{:else}{$user.data?.name}{/if}
```

An Olas `ReadSignal` already satisfies Svelte's store contract: `subscribe(run)` calls `run` with the current value at once and on every change, and returns the unsubscribe. So `$signal` works on a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray` with no wrapper. A `Field` also has `set`, which makes it a writable store for `bind:value`. `setRoot(root)` provides the root to the components below, and `getRoot()` returns its `api`; both are called during component initialization, and `getRoot()` is typed by `Register` on `@kontsedal/olas-svelte`. `queryStore`, `infiniteQueryStore`, `fieldStore` and `mutationStore` turn a multi-signal object into one store of its state, with the actions beside it. `mutationStore` carries `mutate`, `run` and `reset`.

### 16.4 Preact, and adapter parity

Preact uses the React adapter through `preact/compat`: alias `react`, `react-dom` and the JSX runtimes to `preact/compat` in the bundler. `packages/react/tests/preact-compat.test.tsx` runs the hooks that way. It pins that compat's `useSyncExternalStore` keeps the fine-grained `useQuery`, that compat's `Suspense` retries `useSuspenseQuery` once the data lands, and that `SuspendOnUnmount` suspends on unmount. It does not cover `HydrationBoundary`'s StrictMode path, because compat's `StrictMode` does nothing.

The parity suite runs six scenarios through React, Preact, Vue and Svelte. They cover a signal, the unsubscribe on unmount, a query, an infinite query, a field with validation, and a fire-and-forget mutation. A pass shows that each adapter reads the same signals and re-renders on the same writes. It also shows that each passes the same actions through and lets go of its subscriptions on unmount. It does not measure speed, and it does not show that each view is idiomatic for its framework.

### 16.5 Canonical patterns

Things that aren't framework primitives but show up in every non-trivial app. Documenting the recommended approach so projects converge on one shape instead of inventing four.

#### Routing as a reactive service

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

`@kontsedal/olas-router` is that adapter for TanStack Router and React Router v6, shaped as scopes rather than a deps service. `createRouterAdapter(initial?)` returns a `plugin` that provides `RouteParamsScope`, `RouteSearchScope` and `RoutePathnameScope` (§13.1), and a `Bridge` component that pushes the router's state into them. A controller reads `ctx.inject(RouteParamsScope)` as a signal. The router still owns the address bar; seed `initial` on the server, where the `Bridge`'s effect does not run.

#### Real-time updates → cache patches

The recurring shape "WebSocket event arrives → patch some queries". `@kontsedal/olas-realtime` ships it as `createRealtimePatcher`, over a `RealtimeService` the app provides as `deps.realtime`:

```ts
import { createRealtimePatcher } from '@kontsedal/olas-realtime'

const newsfeed = bindQuery(ctx, newsfeedQuery, { origin: 'realtime' })
const comments = bindQuery(ctx, commentsQuery, { origin: 'realtime' })

createRealtimePatcher<FeedEvent>(ctx, 'feed-events', {
  'like-added': (ev) => newsfeed.write('top-stories', (pages) => /* patch */),
  'comment-added': (ev) => comments.write(ev.postId, (prev) => [...prev ?? [], ev.comment]),
  'post-deleted': () => newsfeed.invalidateAll(),
})
```

The patcher subscribes inside `ctx.effect`, so the subscription ends with the controller, and it runs each handler untracked. Each handler receives its own variant of the event union, `Extract<TEvent, { type: K }>`, and a `'*'` handler sees every event. `channel` is a name or a `ReadSignal<string>`, and a new name moves the subscription to the new channel: a per-route room is a `computed` over the route params. The framework primitives underneath are `ctx.effect` and `write`. Note three choices in the example. `bindQuery` scopes the writes to this root, per §21.5. `write` rather than `setData`, because a realtime event is server truth with nothing to roll back. A fire-and-forget `setData` would leave a live snapshot per event (§6.4). The `origin` tag marks the writes as derived, and cross-tab leaves them alone, since every tab receives the same push (§13.2). `createConnectionState(ctx)` reads the transport's connection state as a signal, and `onReconnect(ctx, fn)` runs `fn` when it comes back. All of them on one `RealtimeService` share one `onConnectionChange` subscription.

#### Gesture / transient UI state

Some state legitimately belongs to a single component for a single interaction: the in-progress rectangle while marquee-selecting, the floating ghost element during drag, focus rings, hover. These have:
- Lifetime equal to the gesture
- No business-logic value (nothing to test in isolation)
- No need to survive a re-render of the parent feature

**Keep this state in components** — `useState`, `useRef`, framework-native. On gesture end, *commit* the result to the controller (e.g., `kanban.moveCard(cardId, newColumnId)`). The pattern is: component owns "what is the user doing right now"; controller owns "what does the world look like after they're done."

This keeps to "logic lives in controllers". A gesture is input, and the controller method `moveCard` is the logic, tested there.

#### Bulk operations

For "select N items, do thing to all of them":

- **If the API supports a batch endpoint** (preferred): one mutation with `vars: ID[]`. Optimistic update writes all N at once. One rollback on failure.
- **If only single-item endpoints exist**: `await Promise.all(ids.map(id => mutation.run({ id })))`. Mutations are `parallel` by default. Errors per-item are visible via the rejected promise; `mutation.error` only reflects the *last* error (limitation of a single mutation instance). For richer per-item tracking, run mutations inside a controller and track an `Array<MutationOutcome>` signal.

Avoid pretending a single mutation tracks N concurrent runs cleanly — the `Mutation` API tracks one logical operation. For N independent operations, run N separate mutations or hand-roll the orchestration.

#### Code splitting with `ctx.lazyChild`

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
- On success, `api.value` becomes the controller's API. Components subscribe normally via `useValue(editor.api)`.
- On import and construction failure, `status` flips to `'error'` and `error.value` carries the cause; `root.onError` fires with `kind: 'construction'`.
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

#### HMR (development)

Olas roots typically live at module scope. When HMR replaces a controller's module, the running root holds the *old* controller definition. The pattern:

Treat the root as a "device" — on HMR boundary modules, `root.dispose()` and `createRoot(...)` again. UI state resets; the cache survives when you `dehydrate()` the old root and pass the state as the new root's `hydrate`. Roughly 10 lines of Vite plugin glue.

Document the rebuild pattern in your project's HMR setup.

#### Multi-select for large lists

Selection state (which items are selected, the "anchor" for shift-click range select) recurs in every table and list with bulk actions. Use `createSelection` from `@kontsedal/olas-core`:

```ts
import { createSelection } from '@kontsedal/olas-core'

const issuesController = defineController((ctx) => {
  const issues = createQuery(ctx, issuesQuery)
  const sel = createSelection<string>() // returns the Selection object below

  const bulkArchive = createMutation(ctx, {
    mutate: (_: void, { signal, deps }) =>
      deps.api.archiveMany([...sel.selectedIds.value], { signal }),
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
  handleClick(
    id: string,
    mods: { shift?: boolean; meta?: boolean },
    ordered: readonly string[] | ReadonlyMap<string, number>,
  ): void
}

function createSelection<T>(opts?: { initial?: readonly string[] }): Selection<T>
```

The `handleClick` method encapsulates the standard semantics:
- plain click → select only `id`
- meta-click → toggle `id` in selection
- shift-click → range from anchor (last clicked) to `id`, using `ordered` to define the range. `ordered` may be the row ids in order, or a `Map` from id to index, which a large list can build once.

`isSelected(id)` hands back the same signal for an id while anything holds it, so a row that renders `useValue(sel.isSelected(id))` keeps one subscription across renders.

`createSelection` is a plain function, not bound to `ctx` — the signals it owns aren't lifecycle-bound. Put it in a controller's closure; it dies with the closure.

#### Inline editing

Click a cell, edit, save or cancel. The pattern across tables, kanban cards, profile fields:

```ts
function createInlineEdit<T>(
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

  const commit = createMutation(ctx, {
    mutate: (_: void, { signal }) => save(draft.value as T, signal),
    onSuccess: () => {
      draft.set(undefined)
      isEditing.set(false)
    },
  })

  return { isEditing, draft, start, cancel, commit }
}
```

Use cases:
- Editable table rows: one `createInlineEdit` per row, instantiated on demand in the row controller (or in a controller made with `ctx.attach`).
- Inline title editing on a card.
- Tag editing on a profile field.

The `current` thunk re-reads server data on edit start, so concurrent updates don't get clobbered.

#### Live streaming buffers (logs, metrics, presence)

Tail mode: a WebSocket or SSE stream firing 10–1000 events/sec, rendered live with backpressure. `@kontsedal/olas-realtime` ships it as `createLiveStream`, over the same `deps.realtime` service:

```ts
import { createLiveStream } from '@kontsedal/olas-realtime'

const logs = createLiveStream<LogLine>(ctx, 'logs', { capacity: 10_000, flushMs: 16 })

logs.events.value // readonly LogLine[], newest last
logs.pause()      // tears the subscription down; the buffer stays
logs.resume()
logs.clear()      // empties the buffer; the subscription stays
```

Key points:
- `flushMs` (default 16) coalesces N events into one signal write, which prevents 1000 renders/sec. `rafFlush: true` coalesces against `requestAnimationFrame` instead.
- `capacity` (default 1000) caps memory; oldest entries drop, and `onDrop` receives them.
- Pause/resume controls the subscription, not the buffer. Events that arrive during a pause are not received, so recover a gap with `onReconnect(...)` and a query `invalidate` rather than the buffer.
- A channel signal's change moves the subscription and empties the buffer, since the buffered events came from the old channel.
- For "merge with historical query" (load page-1 history then tail forward), compose with a `createCache` and a `computed(() => [...history.data.value ?? [], ...logs.events.value])`.

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

  await profile.api.save.run({ name: 'New name' })

  expect(mockApi.updateUser).toHaveBeenCalledWith('user-123', { name: 'New name' })
  expect(profile.api.user.isStale.value).toBe(true)

  profile.dispose()
})
```

`createTestController(def, options)` builds an isolated root around one controller and returns the same handle `createRoot` does, so the controller's api is on `.api`. Unlike `createRoot`, it gives the root a live query engine by default; pass `queries: queryEngine({ defaults })` to test against root-wide defaults, or `queries: null` for the no-engine path. `props` may be omitted for a controller that takes none, and `plugins`, `scopes` and `hydrate` pass through (§13.1, §20.12).

For tests that need a real tree (parent + children), use the regular `createRoot` and exercise via the root's api:

```ts
const root = createRoot(myApp, { deps: mockDeps, queries: queryEngine() })
await root.api.todoList.toggle.run({ id: '1', done: true })
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

  const login = createTestController(loginController, { deps: { api, session } })

  // empty submit — fails validation, no network
  await login.api.submit.run()
  expect(login.api.form.isValid.value).toBe(false)
  expect(api.signIn).not.toHaveBeenCalled()

  // fill in and submit
  login.api.form.fields.email.set('user@example.com')
  login.api.form.fields.password.set('supersecret')
  await login.api.submit.run()
  expect(api.signIn).toHaveBeenCalledWith({ email: 'user@example.com', password: 'supersecret' })

  login.dispose()
})

// Asserting optimistic update + rollback
test('liking a post optimistically updates then rolls back on error', async () => {
  const api = { likePost: vi.fn().mockRejectedValue(new Error('500')) }
  const ctrl = createTestController(postController, { deps: { api }, props: { id: 'p1' } })

  // seed cache — `replace`, not `setData` or `write`: a seed is not an
  // optimistic guess, and a fire-and-forget `setData` would leave a snapshot
  // pending. `replace` also supersedes the fetch construction started, which
  // a `write` would leave running to land over the seed (§6.4).
  ctrl.bindQuery(postQuery).replace('p1', { id: 'p1', likes: 10, liked: false })

  await expect(ctrl.api.like.run()).rejects.toThrow('500')
  expect(ctrl.api.post.data.value).toEqual({ id: 'p1', likes: 10, liked: false }) // rolled back

  ctrl.dispose()
})

// Driving an effect by mutating its tracked signal
test('debounced search refetches after delay', async () => {
  vi.useFakeTimers()
  const api = { search: vi.fn().mockResolvedValue([]) }
  const ctrl = createTestController(searchController, { deps: { api } })

  ctrl.api.query.set('foo')
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

A plugin is tested the same way, on a test root: `createTestController(def, { plugins })`. `@kontsedal/olas-core/testing` also ships `mockFetchPlugin`, which answers fetches by query `id` without their fetchers, and `createPluginRecorder`, which records every plugin event a root emits (§13.1). `PLUGINS.md` shows both.

---

## 18. Non-goals

The following are deliberately out of scope. They aren't "we'll do them later" — they're not the kind of thing this design is for. (Ideas for additional optional packages live in `BACKLOG.md`; the items below are exclusions, not deferrals.) Some exclude a feature from **core** only: the capability ships as its own package, and core stays small for the apps that do not need it.

- Async controller factories. Setup is always sync. `@kontsedal/olas-eslint-plugin`'s `no-async-controller-factory` reports an `async` factory.
- A `command` primitive separate from mutations. Non-cache writes (analytics, navigation) go through `ctx.deps`.
- Framework-specific SSR in core. `dehydrate`/`hydrate` is core's boundary. The React adapter's streaming helpers are built on it (§15, §16.1).
- UI framework code in core. Each framework gets its own adapter package: React, Vue and Svelte, with Preact on the React one through `preact/compat` (§16).
- **React Server Components (RSC).** Controllers rely on signals and client-side lifecycle. They run in the browser — wrap any RSC tree in client components before reaching Olas.
- **Built-in router.** Routing belongs in deps as a service (§16.5). Plug in `react-router`, TanStack Router, or your own. `@kontsedal/olas-router` bridges the first two into route scopes, and the router keeps the address bar.
- **Gesture and transient UI state.** State whose lifetime equals a single interaction (in-progress drag rectangle, hover, focus) belongs in components, not controllers. See §16.5.
- **Multi-item mutation orchestration.** The `Mutation` primitive tracks one logical operation. For "fire N mutations and track each result," compose them in a controller (§16.5).
- **Offline-first sync with conflict resolution.** Core has no persistent outbox, and no package resolves conflicts. Mutations are best-effort against the network. `@kontsedal/olas-mutation-queue` persists the runs of opted-in mutations and replays them after a reload or a reconnect (§13.3). Its delivery is at-least-once until success, and deduplication and conflict resolution stay with the server. The merge-and-sync model of a CRDT or an operational-transform engine is not part of Olas.

### 18.1 Entity normalization

The same entity, a `Post` or a `User`, can appear in many independent queries: `newsfeedQuery`, `userProfileQuery`, `searchQuery`, `notificationsQuery`, `commentsQuery`. Updating that entity, such as liking the post, means patching every query that contains it. Olas core does **not** ship normalized storage; each query owns its own data. Normalization is out of scope for core, and ships as a plugin package.

Two equally-supported patterns:

**Userland helper (no extra dependency).** Write a small helper per entity that knows which queries it lives in. Verbose but explicit and grep-able:

```ts
const patchPostEverywhere = (ctx: Ctx, id: string, patch: Partial<Post>) => {
  const newsfeed = bindQuery(ctx, newsfeedQuery)
  newsfeed.write('top-stories', (pages) => /* patch */)
  newsfeed.write('most-recent', (pages) => /* patch */)
  bindQuery(ctx, userProfileQuery).write(authorId, (u) => /* patch */)
  // ... explicit list of touch sites
}
```

**`@kontsedal/olas-entities`.** A plugin (§13.1) that observes every cache write through `onWrite`, whatever its `source`, including a write another tab sent. It walks the data via per-entity `idOf` predicates, and maintains a normalized store plus a reverse index from entity id to the queries holding it. It exposes:

- `defineEntity<T>({ name, idOf })` — module-scope entity descriptor.
- `entitiesPlugin({ entities: [Post, User, ...] })` — install via `RootOptions.plugins`. Each root gets its own store.
- The store, a service under the `Entities` scope: `ctx.inject(Entities)` in a controller, `root.inject(Entities)` outside one.
- `entities.signal(Post, id) → ReadSignal<Post | undefined>` — reactive per-id reads. `entities.list(Post, { filter? })` reads every stored `Post` as one signal.
- `entities.update(Post, id, patchOrUpdater, options?)` — accepts a `Partial<T>` patch or a `(prev: T) => T` updater. A patch shallow-merges by default; pass `{ merge: 'deep' }` to recursively merge plain objects, where arrays and non-plain values replace rather than merge. It backpropagates to every query holding the entity through `host.queries.write`, batched into one round of subscriber notifications. Each entry is patched as it is at the time of the call: the plugin replaces every node `idOf` claims with that id in the entry's current data, so a patch lands on an entity that moved since the entry was last walked, and an entry that no longer holds it gets no write. The writes carry the plugin's name as `origin`, so the plugin skips them when they come back through `onWrite`, and cross-tab does not mirror them (§13.2). Infinite queries are included, because the page arrays are walked transparently. In a development build (§23) each update reports on the plugin's devtools lane which entity it patched and how many entries it reached.
- `entities.upsert`, `get`, `remove`, `entries` and `bindings` round out the surface (the last two are devtools snapshots). `remove` drops the entity from the store and patches no query.

```ts
const Post = defineEntity<Post>({ name: 'Post', idOf: (v: any) => v?.id ?? null })
createRoot(app, { deps, queries: queryEngine(), plugins: [entitiesPlugin({ entities: [Post] })] })

// In a controller:
const entities = ctx.inject(Entities)
const post = entities.signal(Post, 'p1')         // reactive, normalized

// In a mutation handler — shallow merge:
entities.update(Post, 'p1', { liked: true })    // patches feedQuery, profileQuery, …

// Or compute the next value from the previous (non-shallow updates):
entities.update(Post, 'p1', (prev) => ({ ...prev, likes: prev.likes + 1 }))
```

Both patterns share the same core; neither is a framework. The userland helper is the right choice for about five queries and few entity types; the plugin scales further by removing the per-touch-site boilerplate.

Future-work ideas live in `BACKLOG.md`, not here. The spec describes what *is*.

---

# Part II — Implementation

## 19. Packages & build tooling

### 19.1 Monorepo

`pnpm` workspaces. One repo, multiple packages, shared TS config and tooling. Versioning via `changesets`. Packages version independently: a release bumps the packages a changeset names, plus any whose peer range a bumped dependency left.

### 19.2 Packages

Fourteen packages are published. `packages/integration` is private and holds the cross-package test suites.

| Package | Purpose |
| --- | --- |
| `@kontsedal/olas-core` | Everything: signals wrapper, controllers, ctx, lifecycle, caches, queries (incl. infinite), mutations, emitters, fields, forms, field arrays, validators, timing signals, error handling, dehydrate/hydrate, the plugin host, the devtools event bus. `/testing` holds the test helpers. |
| `@kontsedal/olas-react` | React adapter: `OlasProvider`, `useRoot`, `useValue`, `useQuery`, `useSuspenseQuery`, `useInfiniteQuery`, `useField`, `useFieldInput`, `useMutation`, `SuspendOnUnmount`, `useSuspendOnHidden`, `HydrationBoundary`, streaming SSR. Built on `useSyncExternalStore`; runs Preact through `preact/compat`. §16.1. |
| `@kontsedal/olas-vue` | Vue adapter: `olasPlugin`, `useRoot`, `useValue`, `useQuery`, `useInfiniteQuery`, `useField`, `useMutation`; signals as read-only refs. §16.2. |
| `@kontsedal/olas-svelte` | Svelte adapter: `setRoot`/`getRoot`, `queryStore`, `infiniteQueryStore`, `fieldStore`, `mutationStore`; a signal is a store as it is. §16.3. |
| `@kontsedal/olas-persist` | `createPersisted` with `localStorageAdapter()` and `indexedDbAdapter()`, `clearPersisted`, and the `persistQueryCachePlugin` query-cache persister. §13.4. |
| `@kontsedal/olas-zod` | `zodValidator(schema)` and `createZodForm(ctx, schema)` — Zod schemas as the single source of truth for form types + validation. §8.7. |
| `@kontsedal/olas-devtools` | In-app `<DevtoolsPanel>` + floating launcher consuming `root.debug` — causal timeline, controller tree, cache inspector, mutation and field logs, omnibox. §14. |
| `@kontsedal/olas-cross-tab` | `BroadcastChannel`-backed plugin mirroring cache writes and invalidations across browser tabs. §13.2. |
| `@kontsedal/olas-mutation-queue` | Plugin that persists opted-in mutation runs and replays them after a reload or reconnect. §13.3. |
| `@kontsedal/olas-entities` | Plugin that walks query data via per-entity `idOf`, normalizes into a reactive per-id signal store, and backpropagates `entities.update(Post, id, patch)` to every query holding the entity. §18.1. |
| `@kontsedal/olas-realtime` | Composables over a consumer-supplied `RealtimeService` — `createRealtimePatcher` (WebSocket / SSE → cache patch), `createLiveStream` (tail-buffer with capacity + coalesced flush) and `createConnectionState`. §16.5. |
| `@kontsedal/olas-router` | `createRouterAdapter`: a plugin providing route params, search and pathname scopes, plus a `Bridge` for TanStack Router or React Router v6. §16.5. |
| `@kontsedal/olas-eslint-plugin` | Eight syntax-only lint rules, with `recommended` and `strict` flat configs. |
| `@kontsedal/olas-codemod` | The 0.8 → 1.0 migration CLI on ts-morph: `npx @kontsedal/olas-codemod 1.0`. |

A vanilla binding needs no package: every signal exposes `subscribe()` and `peek()` (§16).

### 19.3 Why one core package, not several

Splitting into `signals`, `runtime`, `query` and `forms` would give marginal bundle-size wins and real DX cost (more imports, version-sync issues, more changesets per release). Tree-shaking handles unused exports inside a single package: a bundle that imports no form or query primitive leaves forms and the query engine out (§3.2, §23).

### 19.4 Sub-path exports

Each published package ships from a single `src/index.ts` (§19.8). The only sub-path export is `@kontsedal/olas-core/testing` (test-only helpers, kept grep-able). A new sub-path requires both a `package.json#exports` entry and a `tsdown` entry so the type and runtime files are emitted under the same alias.

### 19.5 Build tooling

| Concern     | Choice                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Bundler     | **tsdown** — ESM and declarations in one pass. Output `dist/*.js` and `dist/*.d.ts` per package.    |
| Test runner | **vitest** — ESM-first, vite ecosystem, expect-style API.                                           |
| Linter / formatter | **biome** — one Rust-based tool for lint + format.                                            |
| Versioning  | **changesets** — automated bumps + changelogs for monorepos.                                        |
| TypeScript  | strict mode, target ES2022, bundler module resolution, `stripInternal`. Shared `tsconfig.base.json` at repo root. |
| Node        | `>= 20.19`.                                                                                          |
| CI          | GitHub Actions (`.github/workflows/ci.yml`): install → build → typecheck → lint → doc snippets → test → examples → publint → attw → smoke:dist → check:public-types → size. A second job loads the built dist on Node 20.19, 22 and 24. |

### 19.6 Module format

**ESM only.** Every package builds `format: ['esm']`, and each `exports` entry is `{ types, default }`. Node 20.19 and later load an ES module through `require()`, so a CommonJS consumer still works without a CommonJS build. One format also means one module instance, with no dual-package hazard. `.wiki/decisions/esm-only-build.md` records the decision and the dist checks that guard it: `attw --profile esm-only`, `publint`, `pnpm smoke:dist`, `pnpm check:public-types` and `pnpm size`.

### 19.7 Peer dependencies

Declared explicitly so users dedupe correctly. Each package's `package.json` holds the exact ranges.

| Package | Peer dependencies |
|---|---|
| `@kontsedal/olas-core` | `@preact/signals-core` `^1.8.0` |
| `@kontsedal/olas-react` | `@kontsedal/olas-core`, `react` `>=18` |
| `@kontsedal/olas-vue` | `@kontsedal/olas-core`, `vue` `>=3.4` |
| `@kontsedal/olas-svelte` | `@kontsedal/olas-core`, `svelte` `>=4` |
| `@kontsedal/olas-persist` | `@kontsedal/olas-core` |
| `@kontsedal/olas-zod` | `@kontsedal/olas-core`, `zod` `^4.0.0` |
| `@kontsedal/olas-devtools` | `@kontsedal/olas-core`, `@kontsedal/olas-react`, `react` `>=18` |
| `@kontsedal/olas-cross-tab` | `@kontsedal/olas-core` |
| `@kontsedal/olas-mutation-queue` | `@kontsedal/olas-core`, `@kontsedal/olas-persist` |
| `@kontsedal/olas-entities` | `@kontsedal/olas-core` |
| `@kontsedal/olas-realtime` | `@kontsedal/olas-core` |
| `@kontsedal/olas-router` | `@kontsedal/olas-core`, `react` `>=18` |
| `@kontsedal/olas-eslint-plugin` | `eslint` `>=9` |
| `@kontsedal/olas-codemod` | none; a CLI with `ts-morph` as a dependency |

### 19.8 Public entry per package

Single `index.ts` entry per package, with one deliberate exception: `@kontsedal/olas-core/testing` exports `createTestController`, the test plugins and the other test-only helpers. Splitting these into a sub-path makes "you imported testing utilities into production code" loud and grep-able.

### 19.9 Repo layout

```
olas/
  package.json                 # workspace root, private, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  biome.json
  .size-limit.json             # bundle-size budgets (pnpm size)
  .changeset/
  .github/workflows/           # ci.yml, version.yml, publish.yml
  packages/
    core/
      src/
        index.ts               # single public entry
        signals/
        controller/
        query/                 # the query engine, dehydrate/hydrate, mutations
        plugin/                # the plugin contract (types.ts) and host (host.ts)
        forms/
        timing/
        errors.ts
        devtools.ts
        html.ts                # serializeForScript
        testing.ts             # @kontsedal/olas-core/testing sub-path export
      tests/
      bench/
      tsdown.config.ts
      tsconfig.json
      package.json
    react/                     # OlasProvider, hooks, SuspendOnUnmount, HydrationBoundary, streaming
    vue/                       # olasPlugin + ref-returning hooks
    svelte/                    # setRoot/getRoot + store views
    persist/                   # createPersisted, storage adapters, persistQueryCachePlugin
    zod/                       # zodValidator, createZodForm
    devtools/                  # in-app DevtoolsPanel + DevtoolsLauncher
    cross-tab/                 # BroadcastChannel-backed cache-sync plugin
    mutation-queue/            # durable mutation replay plugin
    entities/                  # entity-normalization plugin
    realtime/                  # createRealtimePatcher, createLiveStream, createConnectionState
    router/                    # createRouterAdapter + route scopes
    eslint-plugin/             # lint rules and configs
    codemod/                   # 0.8 → 1.0 migration CLI
    integration/               # private: cross-package tests, adapter parity
  examples/
    kanban/                    # React + mutations + zod forms + entities + cross-tab + devtools
    reader-ssr/                # React + SSR dehydrate/hydrate
    stock-ticker/              # vanilla TS, no UI framework
    virtualized-table/         # React + rows-are-data (§11.2) at 50k rows
    vue-tasks/                 # Vue 3 SFCs over one controller
  SPEC.md
  README.md
  API.md
  PLUGINS.md
  LICENSE
```

---

## 20. Type-level API

The full public TypeScript surface. Internal types are not listed; anything in this section is exported from `@kontsedal/olas-core`, or from the package its subsection names. `BRAND` and `PHANTOM` in the listings are `Symbol.for` keys that core does not export: a value carries its kind under `BRAND`, and `PHANTOM` pins a type parameter for inference (`.wiki/decisions/brand-markers-not-classes.md`).

### 20.1 Signals

```ts
type ReadSignal<T> = {
  readonly value: T
  peek(): T // read without registering a dependency
  subscribe(handler: (value: T) => void): () => void        // fires with the current value, then on every change
  subscribeChanges(handler: (value: T) => void): () => void // fires on changes only
}

type Signal<T> = ReadSignal<T> & {
  value: T // writable
  set(value: T): void // bound: stable identity, safe to pass (`onChange={s.set}`)
  update(fn: (prev: T) => T): void // bound, like `set`
}

type Computed<T> = ReadSignal<T>

function signal<T>(initial: T): Signal<T>
function computed<T>(fn: () => T): Computed<T>
function effect(fn: () => void | (() => void)): () => void // returns dispose
function batch<T>(fn: () => T): T // batched writes, single notification
function untracked<T>(fn: () => T): T // run fn outside the current tracking scope

type TimingOptions = {
  signal?: AbortSignal // aborting it stops the timer and releases the source
  leading?: boolean    // debounced: default false; throttled: default true
  trailing?: boolean   // default true
}
type TimingSignal<T> = ReadSignal<T> & {
  cancel(): void  // drop the pending emission
  flush(): void   // emit the pending value now
  dispose(): void // release the source subscription; idempotent
}

function debounced<T>(source: ReadSignal<T>, ms: number, options?: TimingOptions): TimingSignal<T>
function throttled<T>(source: ReadSignal<T>, ms: number, options?: TimingOptions): TimingSignal<T>
```

`untracked(fn)` runs `fn` with auto-tracking suppressed — any signals read inside don't become dependencies of the surrounding `computed` or `effect`. Useful for "read these signals once to log them" or "read a snapshot of state inside an effect without subscribing to it." For a single-signal peek, prefer `signal.peek()`; `untracked` is for the multi-signal and nested-call case.

`Signal<T>` extends `ReadSignal<T>` — a `Signal` is assignable wherever a `ReadSignal` is expected, but not vice versa. This is what makes caches' `data: ReadSignal<T>` un-writable from the outside.

Standalone `effect()` is for use outside controllers (rare). Inside a controller use `ctx.effect()`, which is auto-disposed.

### 20.2 Controllers & `Ctx`

```ts
interface AmbientDeps {
  [key: string]: unknown // augmented by the app, §20.3
}

type Ctx<TDeps = AmbientDeps> = {
  // Lifetime-owned primitives are NOT methods — they are standalone functions
  // taking `ctx` first, so a controller that never builds one does not retain
  // its subsystem. See §3.2 and the list under "Primitives taking ctx" below.

  // events
  emitter<T = void>(): Emitter<T>
  on<T>(emitter: Emitter<T>, handler: (value: T) => void): void // unsubscribed on dispose

  // tree composition
  child<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): Api

  attach<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): { api: Api; dispose: () => void; suspend: () => void; resume: () => void }

  collection<Item, K, Props, Api>(
    options: CollectionHomogeneousOptions<Item, K, Props, Api, TDeps>,
  ): Collection<K, Api>
  collection<Item, K, R extends CollectionFactoryResult>(
    options: CollectionFactoryOptions<Item, K, R, TDeps>,
  ): Collection<K, CollectionFactoryApi<R>>

  lazyChild<Props, Api>(
    loader: () => Promise<ControllerDef<Props, Api>>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): LazyChild<Api>

  effect(fn: () => void | (() => void)): void

  // devtools — expose named live values to the "Variables" view (dev-only, §14)
  debug(values: Record<string, unknown>): void

  // scopes (typed cross-tree data — see §10.3)
  provide<T>(scope: Scope<T>, value: T): void
  inject<T>(scope: Scope<T>): T

  // lifecycle
  onDispose(fn: () => void): void
  onSuspend(fn: () => void): void
  onResume(fn: () => void): void

  // DI
  readonly deps: TDeps
}

// Primitives taking ctx. Each registers its teardown on the controller, so
// everything here is disposed when the controller is (§3.4).
function createField<T>(ctx: Ctx, initial: T, options?: FieldOptions<T>): Field<T>
function createForm<S extends FormSchema>(ctx: Ctx, schema: S, options?: FormOptions<S>): Form<S>
function createFieldArray<I extends Field<any> | Form<any>>(
  ctx: Ctx,
  itemFactory: (initial?: ItemInitial<I>) => I,
  options?: FieldArrayOptions<I>,
): FieldArray<I>

function createCache<T>(
  ctx: Ctx,
  fetcher: (ctx: FetchCtx) => Promise<T>,
  options?: LocalCacheOptions<T>,
): LocalCache<T> // needs no query engine

function createQuery<Args extends unknown[], T>(
  ctx: Ctx,
  source: Query<Args, T>,
  keyOrOptions?: (() => readonly [...Args]) | QuerySubscriptionOptions<Args>,
): QuerySubscription<T>
function createQuery<Args extends unknown[], T, U>(
  ctx: Ctx,
  source: Query<Args, T>,
  options: QuerySelectOptions<readonly [...Args], T, U>,
): QuerySubscription<U>
function createQuery<Args extends unknown[], TPage, TItem>(
  ctx: Ctx,
  source: InfiniteQuery<Args, TPage, TItem>,
  keyOrOptions?: (() => readonly [...Args]) | QuerySubscriptionOptions<Args>,
): InfiniteQuerySubscription<TPage, TItem>

function createMutation<V, R>(ctx: Ctx, spec: MutationSpec<V, R>): Mutation<V, R>
function createMutation<V, R>(ctx: Ctx, def: MutationDef<V, R>, hooks?: MutationHooks<V, R>): Mutation<V, R>

function bindQuery<Args extends unknown[], T>(
  ctx: Ctx,
  query: Query<Args, T>,
  options?: BindQueryOptions,
): QueryActions<Args, T>
function bindQuery<Args extends unknown[], TPage, TItem>(
  ctx: Ctx,
  query: InfiniteQuery<Args, TPage, TItem>,
  options?: BindQueryOptions,
): InfiniteQueryActions<Args, TPage, TItem>

type Scope<T> = {
  readonly [BRAND]: 'scope'
  readonly name?: string   // used in error messages
  readonly default?: T
  readonly hasDefault: boolean // true iff defineScope got a `default`, even `default: undefined`
}
type ScopeOptions<T> = { default?: T; name?: string }

function defineScope<T>(options?: ScopeOptions<T>): Scope<T>

// Homogeneous form: one controller def for all items.
type CollectionHomogeneousOptions<Item, K, Props, Api, TDeps = AmbientDeps> = {
  readonly source: ReadSignal<readonly Item[]>
  readonly keyOf: (item: Item) => K
  readonly controller: ControllerDef<Props, Api>
  readonly propsOf: (item: Item) => Props // not re-applied for an unchanged key
  readonly deps?: Partial<TDeps>
}

// Heterogeneous form: the factory picks the controller def per item. It runs on
// every source change; a key whose controller changes is rebuilt (§11.1).
type CollectionFactoryOptions<Item, K, R, TDeps = AmbientDeps> = {
  readonly source: ReadSignal<readonly Item[]>
  readonly keyOf: (item: Item) => K
  readonly factory: (item: Item) => R
  readonly deps?: Partial<TDeps>
}
type CollectionFactoryResult = { controller: ControllerDef<any, any>; props: any }
type CollectionFactoryApi<R> = R extends { controller: ControllerDef<any, infer A> } ? A : never

type Collection<K, Api> = {
  readonly items: ReadSignal<ReadonlyArray<{ readonly key: K; readonly api: Api }>>
  readonly size: ReadSignal<number>
  get(key: K): Api | undefined
  has(key: K): boolean
  suspendItem(key: K): void // survives a whole-tree suspend/resume (§4.1)
  resumeItem(key: K): void
  isItemSuspended(key: K): boolean
}

type LazyChild<Api> = {
  readonly status: ReadSignal<'idle' | 'loading' | 'ready' | 'error'>
  readonly api: ReadSignal<Api | undefined>
  readonly error: ReadSignal<unknown | undefined>
  load(): Promise<Api>
  dispose(): void
}

type ControllerDef<Props, Api> = {
  readonly [BRAND]: 'controller'
  readonly [PHANTOM]?: { props: Props; api: Api } // phantom for inference
}

type DefineControllerOptions = {
  name?: string // the controller's name in the devtools tree, events and error paths
}

function defineController<Props = void, Api = unknown>(
  factory: (ctx: Ctx, props: Props) => Api,
  options?: DefineControllerOptions,
): ControllerDef<Props, Api>

// helpers to extract types from a ControllerDef (useful for fakes / tests)
type CtrlProps<C> = C extends ControllerDef<infer P, unknown> ? P : never
type CtrlApi<C> = C extends ControllerDef<unknown, infer A> ? A : never
```

`Api` is inferred from the factory's return type. `Props` is inferred from the second parameter, and defaults to `void`, the shape `createRoot` requires. There are no decorators, no visibility annotations — the returned object **is** the public API. Without a `name`, a controller is named after its factory function, else `anonymous`.

`child()`'s third arg lets a subtree override deps for itself and descendants (`Partial<TDeps>` — only the keys being overridden). `attach` and both `collection` forms take the same override.

### 20.3 Dependency injection

Two styles:

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

Now every `Ctx` everywhere has `ctx.deps: { api, session, logger }`. No generics needed in controller signatures. The same augmentation types `deps` in query fetchers, `mutate` and `createCache` (§5.2, §6).

**Style B — a narrower `Ctx` in a helper (for libraries).** A composable that needs only some services types its parameter with them, as `@kontsedal/olas-realtime` does with `Ctx<{ realtime: RealtimeService }>`:

```ts
function createUserLoader(ctx: Ctx<{ api: ApiClient }>, id: string) {
  return () => ctx.deps.api.getUser(id)
}
```

A controller passes its own `ctx`, which type-checks once the app's `AmbientDeps` includes those services. `defineController` itself types its factory's `ctx` as the ambient `Ctx`, so a factory annotated with a narrower `Ctx<…>` does not compile.

The default `AmbientDeps` is an interface with a `string` index signature of `unknown` when no module augmentation is present — so untyped `ctx.deps.foo` doesn't error but isn't type-safe either.

### 20.4 Caches & Queries

```ts
type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

type AsyncState<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<AsyncStatus>
  isLoading: ReadSignal<boolean>           // first load, no data yet
  isFetching: ReadSignal<boolean>          // any fetch in flight
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean>
  isPaused: ReadSignal<boolean>            // a fetch is parked waiting for the network (§5.5)
  isEnabled: ReadSignal<boolean>           // false while `enabled` returns false; always true for a LocalCache

  refetch: () => Promise<T>       // rejects with QueryDisabledError while disabled
  reset: () => void               // clear error, settle status; no fetch
  cancel: () => void              // abort the in-flight fetch; data stays
  firstValue: () => Promise<T>    // resolves on first success; waits while disabled
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
  invalidate(): Promise<void>
  setData(updater: (prev: T | undefined) => T): Snapshot
  dispose(): void // idempotent; also called when controller disposes
}

type LocalCacheOptions<T> = {
  key?: () => readonly unknown[] // tracked; a change refetches
  staleTime?: number
  keepPreviousData?: boolean
  initialData?: T | undefined
}

// Query — module-scoped, sharable across the tree
type Query<Args extends unknown[], T> = {
  readonly [BRAND]: 'query'
  invalidate(...args: Args): Promise<void>
  invalidateAll(): Promise<void>
  /** Optimistic write — returns a Snapshot the caller must settle (§6.4). */
  setData(...args: [...Args, updater: (prev: T | undefined) => T]): Snapshot
  /** Canonical write — no snapshot, `hasPendingMutations` untouched (§6.4). */
  write(...args: [...Args, updater: (prev: T | undefined) => T]): void
  /** Canonical whole-record write; supersedes a fetch in flight (§6.4). */
  replace(...args: [...Args, value: T]): void
  /** Synchronous read; `undefined` when nothing is cached. No subscribe, no fetch (§5.5). */
  peek(...args: Args): T | undefined
  cancel(...args: Args): void
  cancelAll(): void
  prefetch(...args: Args): Promise<T>
}

// What bindQuery(ctx, query) and root.bindQuery(query) return: the same
// operations, bound to one root (§21.5).
type QueryActions<Args extends unknown[], T> = Omit<Query<Args, T>, typeof BRAND>

type BindQueryOptions = {
  origin?: string // stamped on the handle's writes and invalidations for plugins (§13.1)
}

type RetryPolicy = number | ((attempt: number, error: unknown) => boolean)
type RetryDelay = number | ((attempt: number) => number)
type RefetchInterval<T> = number | ((data: T | undefined) => number) // see §5.9
type NetworkMode = 'online' | 'always' | 'offlineFirst' // see §5.5

type FetchCtx = { signal: AbortSignal; deps: AmbientDeps }

// Per-query plugin settings; empty in core, augmented by plugin packages (§13.1)
interface QueryMeta {}

type QuerySpec<Args extends unknown[], T> = {
  id: string                 // required; stable and hand-written (§5.2)
  key: (...args: Args) => unknown[]
  fetcher: (ctx: FetchCtx, ...args: Args) => Promise<T>
  staleTime?: number
  gcTime?: number
  refetchInterval?: RefetchInterval<T>
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
  keepPreviousData?: boolean // default false; see §5.2
  retry?: RetryPolicy        // default 0 (no retry)
  retryDelay?: RetryDelay    // default 1000
  networkMode?: NetworkMode  // default 'online'; see §5.5
  structuralShare?: boolean  // default true; see §5.6
  meta?: QueryMeta
}

function defineQuery<Args extends unknown[], T>(
  spec: QuerySpec<Args, T>,
): Query<Args, T>

// Root-wide defaults, passed as queryEngine({ defaults }) (§5.9, §20.8)
type QueryDefaults = Pick<
  QuerySpec<never[], unknown>,
  | 'staleTime' | 'gcTime' | 'refetchOnWindowFocus' | 'refetchOnReconnect'
  | 'keepPreviousData' | 'retry' | 'retryDelay' | 'networkMode' | 'structuralShare'
>   // refetchInterval is deliberately excluded — see §5.9

// subscription returned by createQuery(ctx, ...) — same shape regardless of source
type QuerySubscription<T> = AsyncState<T>

// Options form of `createQuery`'s third argument. The thunk form is shorthand for { key }.
type QuerySubscriptionOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean  // tracking scope; when false, no fetch, status='idle'
  keepDataWhileDisabled?: boolean  // keep last data while disabled instead of blanking (default false)
}

// With `select`, the subscription reports select(data); the cache keeps the raw value
type QuerySelectOptions<Args extends readonly unknown[], T, U> = QuerySubscriptionOptions<Args> & {
  select: (data: T) => U
}

// refetch() on a disabled subscription (§5.2)
class QueryDisabledError extends Error {
  readonly queryId: string
}

// Infinite / paginated queries
type InfiniteQuerySpec<Args extends unknown[], PageParam, TPage, TItem = TPage> = {
  id: string                 // required; unique across regular and infinite queries
  key: (...args: Args) => unknown[]
  fetcher: (ctx: InfiniteFetchCtx<PageParam>, ...args: Args) => Promise<TPage>
  initialPageParam: PageParam
  getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
  getPreviousPageParam?: (firstPage: TPage, allPages: TPage[]) => PageParam | null
  itemsOf?: (page: TPage) => TItem[] // for the .flat selector
  staleTime?: number
  gcTime?: number
  refetchInterval?: RefetchInterval<TPage[]> // thunk receives the pages array; §5.9
  refetchOnWindowFocus?: boolean // a focus refetch re-fetches every loaded page
  refetchOnReconnect?: boolean
  keepPreviousData?: boolean // default false; see §5.2
  retry?: RetryPolicy
  retryDelay?: RetryDelay
  networkMode?: NetworkMode  // default 'online'; see §5.5
  structuralShare?: boolean  // default true; applies to the head-page refresh
  meta?: QueryMeta
}

type InfiniteFetchCtx<PageParam> = {
  pageParam: PageParam
  signal: AbortSignal
  deps: AmbientDeps
}

type InfiniteQuery<Args extends unknown[], TPage, TItem> = {
  readonly [BRAND]: 'infiniteQuery'
  invalidate(...args: Args): Promise<void>
  invalidateAll(): Promise<void>
  setData(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): Snapshot
  write(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): void
  replace(...args: [...Args, pages: TPage[]]): void
  peek(...args: Args): TPage[] | undefined
  cancel(...args: Args): void
  cancelAll(): void
  prefetch(...args: Args): Promise<TPage>
}

type InfiniteQueryActions<Args extends unknown[], TPage, TItem> = Omit<
  InfiniteQuery<Args, TPage, TItem>,
  typeof BRAND
>

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

`defineQuery` and `defineInfiniteQuery` throw on a missing or empty `id`. An infinite `write` or `replace` that changes the page count trims or pads `pageParams` with the last param, as `setData` does.

### 20.5 Mutations

```ts
type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'

// What `mutate` receives besides the variables
type MutateCtx = {
  signal: AbortSignal // fires on supersede, reset() or dispose (§6.2)
  deps: AmbientDeps   // the owning controller's deps; the root's on a replay
}

// Per-mutation plugin settings; empty in core, augmented by plugin packages (§13.1)
interface MutationMeta {}

type MutationSpec<V, R> = {
  id?: string // devtools label and plugin routing; required on a definition
  mutate: (vars: V, ctx: MutateCtx) => Promise<R>
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
  meta?: MutationMeta
  detached?: boolean                // default false — runs outlive the owner's dispose (§6.5)
}

// A module-scope mutation: the write and its policy, no hooks (§6)
type MutationDefinition<V, R> = Pick<
  MutationSpec<V, R>,
  'mutate' | 'concurrency' | 'retry' | 'retryDelay' | 'meta'
> & { id: string }

// What the owning controller adds: createMutation(ctx, def, hooks)
type MutationHooks<V, R> = Pick<
  MutationSpec<V, R>,
  'onMutate' | 'onSuccess' | 'onError' | 'onSettled' | 'detached'
>

type MutationDef<V, R> = MutationDefinition<V, R> & {
  readonly [BRAND]: 'mutation' // non-enumerable, so a spread yields a plain spec
}

function defineMutation<V, R>(definition: MutationDefinition<V, R>): MutationDef<V, R>

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
  status: ReadSignal<AsyncStatus> // outcome of the latest run
  lastVariables: ReadSignal<V | undefined>
  reset(): void   // aborts in-flight runs and rejects queued serial ones, then clears
  dispose(): void // idempotent; aborts in-flight unless detached; also called when controller disposes
}

type MutationRun<V, R> = (
  ...args: unknown extends V ? [V?] : [V] extends [void] ? [] : [V]
) => Promise<R>

// run() after dispose: the write never happened (§6.2)
class MutationDisposedError extends Error {
  readonly mutationId: string | undefined
  readonly controllerPath: readonly string[]
}
```

The `Snapshot` type is shared with caches' `setData` — a snapshot from `userQuery.setData(...)` plugs into `onMutate`'s return naturally. `defineMutation` throws on a missing or empty `id`, and registers the definition in a process-wide registry, where `host.mutations` finds it (§13.1).

### 20.6 Emitters

```ts
type Emitter<T> = {
  emit: [T] extends [void] ? () => void : (value: T) => void
  on(handler: (value: T) => void): () => void
  once(handler: (value: T) => void): () => void
  dispose(): void // idempotent; later emit / on / once are no-ops
}

type EmitterErrorReporter = (err: unknown) => void

// standalone — for emitters that live outside any controller (e.g. in deps)
function createEmitter<T = void>(options?: { onError?: EmitterErrorReporter }): Emitter<T>
```

The conditional on `emit` means `ctx.emitter<void>()` gives you `emit()` (no arg), while `ctx.emitter<{ id: string }>()` gives you `emit({ id })`.

A handler that throws does not stop the others: the emitter reports the throw to `onError`, or to `console.error` without one, and calls the remaining handlers. `ctx.emitter` routes the throw to the root's `onError` with `kind: 'emitter'`.

`createEmitter` has the same shape as `ctx.emitter` but no controller binding — handlers registered via `.on()` are kept until they're explicitly unsubscribed (or the emitter itself is GC'd). Use this for emitters in `deps`; use `ctx.emitter` for emitters owned by a controller.

### 20.7 Fields, forms & validators

```ts
// Non-empty `path` routes the message onto a descendant field/form/array;
// empty `path` lands in the node's `topLevelErrors`. See §8.3.
type FormIssue = { path: (string | number)[]; message: string }

type ValidatorResult = string | null | FormIssue[]

type Validator<T> = (
  value: T,
  signal: AbortSignal,
) => ValidatorResult | Promise<ValidatorResult>

type Field<T> = ReadSignal<T> & {
  errors: ReadSignal<string[]> // validator errors first, server errors after
  isValid: ReadSignal<boolean>
  isDirty: ReadSignal<boolean>
  touched: ReadSignal<boolean>
  isValidating: ReadSignal<boolean>

  set(value: T): void // bound: stable identity, safe to pass (`onChange={field.set}`)
  setAsInitial(value: T): void // new baseline: writes the value, re-anchors reset(), stays clean
  reset(): void
  markTouched(): void
  revalidate(): Promise<boolean>
  setErrors(errors: ReadonlyArray<string>): void // server errors; cleared by the next set() or reset()
  dispose(): void // idempotent; aborts pending validators; also called when controller disposes
}

type ValidateOn = 'change' | 'blur' | 'submit'

type FieldOptions<T> = {
  validators?: ReadonlyArray<Validator<T>>
  validateOn?: ValidateOn // default 'change'; see §8.1
}

// helper for async server-side validation with debounce
function debouncedValidator<T>(
  fn: (value: T, signal: AbortSignal) => Promise<string | null>,
  ms: number,
): (value: T, signal: AbortSignal) => Promise<string | null> // assignable to Validator<T>

// stdlib validators, each with an optional message as its last argument
function required<T>(message?: string): Validator<T> // rejects '', null, undefined, []; false passes
function mustBeTrue(message?: string): Validator<boolean>
function minLength(n: number, message?: string): Validator<string | readonly unknown[]>
function maxLength(n: number, message?: string): Validator<string | readonly unknown[]>
function min(n: number, message?: string): Validator<number>
function max(n: number, message?: string): Validator<number>
function email(message?: string): Validator<string>
function pattern(re: RegExp, message?: string): Validator<string>

// any Standard Schema (Zod 4, Valibot 1, ArkType 2, …) as a validator
function validator<I, O>(schema: StandardSchemaV1<I, O>): Validator<I>

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

type FormValidator<S extends FormSchema> = Validator<FormValue<S>>

type FormOptions<S extends FormSchema> = {
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  validators?: FormValidator<S>[] // form-level (cross-field) validators
  resetOnInitialChange?: 'when-clean' | 'never' | 'always' // default 'when-clean' (§8.4)
}

// A form IS a ReadSignal of its value, like a Field
type Form<S extends FormSchema> = ReadSignal<FormValue<S>> & {
  readonly fields: { [K in keyof S]: S[K] }
  readonly errors: ReadSignal<FormErrors<S>>     // per-field errors (mirrors schema shape)
  readonly topLevelErrors: ReadSignal<string[]>  // form-level (cross-field) validator output
  readonly flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>
  readonly isValid: ReadSignal<boolean>          // all leaves valid AND topLevelErrors empty
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly dirtyFields: ReadSignal<string[]>     // dotted paths of the dirty leaves
  readonly isSubmitting: ReadSignal<boolean>
  readonly submitCount: ReadSignal<number>
  readonly submitError: ReadSignal<unknown>

  set(partial: DeepPartial<FormValue<S>>): void          // deep merge, batched
  setAsInitial(partial: DeepPartial<FormValue<S>>): void // new baseline for the leaves it names
  reset(): void
  clearSubtree(path: string): void // reset one subtree; '' resets the whole form
  markAllTouched(): void
  validate(): Promise<boolean>
  submit<R = unknown>(
    handler: (value: FormValue<S>) => R | Promise<R>,
    options?: SubmitOptions,
  ): Promise<SubmitResult<Awaited<R>>>
  setErrors(errors: Record<string, ReadonlyArray<string>>): void // server errors by dotted path

  // Nested access only: `form.fields.a.fields.b.fields.c`. Path-typed
  // `form.fieldAt('a.b.c')` is not provided.

  dispose(): void // idempotent; disposes all leaf fields/sub-forms/field-arrays
}

type SubmitResult<R> =
  | { readonly ok: true; readonly data: R }
  | { readonly ok: false; readonly reason: 'invalid' | 'busy' | 'disposed' }
  | { readonly ok: false; readonly reason: 'error'; readonly error: unknown }

type SubmitOptions = {
  validateBeforeSubmit?: boolean   // default true
  resetOnSuccess?: boolean         // default false
  onError?: 'rethrow' | 'capture'  // default 'capture'
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

type FieldArrayValidator<I> = Validator<FieldArrayValue<I>>

type FieldArrayOptions<I> = {
  initial?: Array<ItemInitial<I>>
  validators?: FieldArrayValidator<I>[] // array-level (whole-collection) validators
}

// A field array IS a ReadSignal of its items' values
type FieldArray<I extends Field<any> | Form<any>> = ReadSignal<FieldArrayValue<I>> & {
  readonly items: ReadSignal<ReadonlyArray<I>>
  readonly errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  readonly topLevelErrors: ReadSignal<string[]>  // array-level validator output
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly size: ReadSignal<number>

  add(initial?: ItemInitial<I>): void
  insert(index: number, initial?: ItemInitial<I>): void
  remove(index: number): void
  move(from: number, to: number): void
  at(index: number): I | undefined
  clear(): void

  set(values: ReadonlyArray<ItemInitial<I>>): void          // overlapping items keep identity
  setAsInitial(values: ReadonlyArray<ItemInitial<I>>): void // rebuild from a clean baseline
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

`Field<T>`, `Form<S>` and `FieldArray<I>` *are* `ReadSignal`s of their value — `useValue(field)` in the UI works, `field.value` reads, `field.set(x)` writes. Direct `.value = ...` is not exposed; writes must go through `set` so dirty, touched and validation update. `FieldTransform<T>` (`{ parse, format }`) converts between a field's value and an input's string, for the React adapter's `useFieldInput`.

Nested field access is via the `form.fields.address.fields.city`-style path. Path-typed lookup (`form.fieldAt('address.city')`) is not part of the API — the template-literal-type machinery is implementation-heavy and the nested access covers ~95% of cases.

### 20.8 Root & options

```ts
// The handle createRoot returns. Frozen.
type Root<Api> = {
  readonly api: Api // what the root controller's factory returned
  bindQuery<Args extends unknown[], T>(query: Query<Args, T>, options?: BindQueryOptions): QueryActions<Args, T>
  bindQuery<Args extends unknown[], TPage, TItem>(
    query: InfiniteQuery<Args, TPage, TItem>,
    options?: BindQueryOptions,
  ): InfiniteQueryActions<Args, TPage, TItem>
  inject<T>(scope: Scope<T>): T // resolve a scope as the root controller would
  dispose(): void // idempotent
  suspend(options?: SuspendOptions): void
  resume(): void
  dehydrate(): DehydratedState
  hydrate(state: DehydratedState): void // apply entries to the live cache (§15)
  waitForIdle(): Promise<void> // no fetch, mutation or tracked plugin work in flight
  readonly debug: DebugBus // §14, §20.9
}

type SuspendOptions = {
  maxIdleTime?: number // dispose the root if not resumed within this many ms (§4.3)
}

type RootOptions<TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  hydrate?: DehydratedState
  /**
   * The query engine. Omit it and this root has no cache: `createQuery`,
   * `createMutation` and `bindQuery` throw a message naming the fix, and the
   * engine never enters the bundle. `createCache` still works.
   */
  queries?: QueryEngine
  /** Set up in this order before the root factory; disposed in reverse (§13.1). */
  plugins?: readonly OlasPlugin[]
  /** Scope bindings seeded before the root factory; they win over a plugin's (§10.3). */
  scopes?: ReadonlyArray<readonly [Scope<unknown>, unknown]>
}

type QueryEngineOptions = {
  defaults?: QueryDefaults // spec.X ?? defaults.X ?? built-in (§5.9)
}

// A definition, not an instance: each adopting root gets its own client
type QueryEngine = { readonly [BRAND]: 'queryEngine' }

function queryEngine(options?: QueryEngineOptions): QueryEngine

function createRoot<Api, TDeps extends Record<string, unknown> = AmbientDeps>(
  def: ControllerDef<void, Api>,
  options: RootOptions<TDeps>,
): Root<Api>
```

`Root<Api>` is a handle. `api` is the controller's public API, and the rest is the root's own surface: lifecycle, SSR, scope lookup, imperative query operations and the devtools bus. Keeping the two apart means a controller may return anything, including members named `dispose` or `suspend`. The root can also grow new controls without taking a name from anyone's api (`.wiki/decisions/root-handle-separate.md`). Root controllers take no props (`ControllerDef<void, Api>`) — any startup config goes in `deps`.

The plugin contract (§13.1), exported from `@kontsedal/olas-core`:

```ts
type OlasPlugin = {
  readonly name: string // unique within a root; the origin of its writes
  setup(host: PluginHost): PluginHooks | void
}

function definePlugin(plugin: OlasPlugin): OlasPlugin // identity helper

type PluginHost = {
  readonly deps: AmbientDeps
  provide<T>(scope: Scope<T>, value: T): void // only during setup
  reportError(err: unknown): void             // → onError as { kind: 'plugin', pluginName }
  onDispose(fn: () => void): void             // after the plugin's dispose hook
  track(work: Promise<unknown>): void         // root.waitForIdle() waits for it
  readonly network: NetworkHost
  readonly queries: QueryHost | null          // null without a query engine
  readonly mutations: MutationHost | null     // null without a query engine
  debug(payload: unknown): void               // dev-only devtools lane
}

type NetworkHost = {
  isOnline(): boolean                         // navigator.onLine, or true without a navigator
  onReconnect(fn: () => void): () => void
  onFocus(fn: () => void): () => void
}

type QueryRef = {
  readonly id: string
  readonly kind: 'query' | 'infinite'
  readonly meta: QueryMeta
}

// `key` is the output of the query's key(...), not its arguments
type QueryHost = {
  get(id: string): QueryRef | undefined
  keys(id: string): ReadonlyArray<readonly unknown[]>
  peek(id: string, key: readonly unknown[]): unknown
  write(id: string, key: readonly unknown[], updater: (prev: unknown) => unknown, options?: WriteOptions): void
  replace(id: string, key: readonly unknown[], value: unknown, options?: WriteOptions): void
  invalidate(id: string, key: readonly unknown[]): Promise<void>
  hydrate(state: DehydratedState): void
  dehydrate(): DehydratedState
  hashKey(key: readonly unknown[]): string
}

type WriteOptions = {
  pageParams?: readonly unknown[] // an infinite query's params, one per page
}

type MutationRef = {
  readonly id: string | undefined // undefined for an inline spec without one
  readonly meta: MutationMeta
}

type MutationHost = {
  has(id: string): boolean
  get(id: string): MutationRef | undefined
  run(id: string, variables: unknown): Promise<unknown> // through the engine's runner
}

type WriteSource = 'fetch' | 'hydrate' | 'optimistic' | 'rollback' | 'write' | 'replace'

type WriteEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly data: unknown          // after the write; the pages for an infinite query
  readonly updatedAt: number
  readonly source: WriteSource
  readonly origin: string | undefined
  readonly pageParams?: readonly unknown[]
}

type InvalidateEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly origin: string | undefined
}

type RemoveEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly reason: 'gc'
}

type ActivityEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
}

type MutationEvent = {
  readonly mutation: MutationRef
  readonly runId: string
  readonly variables: unknown
  readonly phase: 'start' | 'success' | 'error' | 'cancel'
  readonly result?: unknown
  readonly error?: unknown
  readonly origin: string | undefined
}

type FetchContext = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly args: readonly unknown[]
  readonly pageParam?: unknown // infinite queries
  readonly signal: AbortSignal
  readonly attempt: number     // 0, then one more per retry
}

type MutateContext = {
  readonly mutation: MutationRef
  readonly runId: string
  readonly variables: unknown
  readonly signal: AbortSignal
  readonly attempt: number
  readonly origin: string | undefined
}

type PluginHooks = {
  onWrite?(event: WriteEvent): void
  onInvalidate?(event: InvalidateEvent): void
  onRemove?(event: RemoveEvent): void
  onActivate?(event: ActivityEvent): void
  onDeactivate?(event: ActivityEvent): void
  onMutation?(event: MutationEvent): void
  wrapFetch?(context: FetchContext, next: () => Promise<unknown>): Promise<unknown>
  wrapMutate?(context: MutateContext, next: () => Promise<unknown>): Promise<unknown>
  dispose?(): void
}
```

### 20.9 Errors & devtools

```ts
type ErrorContext = {
  kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'
  controllerPath: readonly string[]
  queryId?: string            // cache kinds
  key?: readonly unknown[]    // cache kinds: the entry's key(...) output
  eventId: string             // unique per dispatch
  timestamp: number           // epoch ms
  attempt?: number            // 0-based retry attempt, for cache and mutation kinds
  cause?: unknown
  pluginName?: string         // plugin kind
}

type ErrorHandler = (err: unknown, context: ErrorContext) => void

type DebugEventMeta = {
  seq?: number     // stamped by the bus on delivery (§14.2)
  t?: number
  causeId?: string
}

type DebugEventBody =
  | { type: 'controller:constructed'; path: readonly string[]; props: unknown; debug?: Record<string, unknown> }
  | { type: 'controller:suspended'; path: readonly string[] }
  | { type: 'controller:resumed'; path: readonly string[] }
  | { type: 'controller:disposed'; path: readonly string[] }
  | { type: 'controller:debug'; path: readonly string[]; values: Record<string, unknown> }
  | { type: 'cache:subscribed'; queryKey: readonly unknown[]; subscriberPath: readonly string[] }
  | { type: 'cache:fetch-start'; queryId?: string; queryKey: readonly unknown[] }
  | { type: 'cache:fetch-success'; queryId?: string; queryKey: readonly unknown[]; durationMs: number }
  | { type: 'cache:fetch-error'; queryId?: string; queryKey: readonly unknown[]; error: unknown; durationMs: number }
  | { type: 'cache:set-data'; queryId?: string; queryKey: readonly unknown[]; source: WriteSource; data: unknown }
  | { type: 'cache:invalidated'; queryId?: string; queryKey: readonly unknown[] }
  | { type: 'cache:gc'; queryId?: string; queryKey: readonly unknown[] }
  | { type: 'snapshot:push'; queryKey: readonly unknown[] }
  | { type: 'snapshot:rollback'; queryKey: readonly unknown[] }
  | { type: 'snapshot:finalize'; queryKey: readonly unknown[] }
  | { type: 'mutation:run'; path: readonly string[]; name?: string; vars: unknown }
  | { type: 'mutation:success'; path: readonly string[]; name?: string; result: unknown }
  | { type: 'mutation:error'; path: readonly string[]; name?: string; error: unknown }
  | { type: 'mutation:rollback'; path: readonly string[]; name?: string }
  | { type: 'field:validated'; path: readonly string[]; field: string; valid: boolean; errors: string[] }
  | { type: 'plugin:event'; plugin: string; payload: unknown }

// DebugEventMeta distributed over every variant, so `switch (event.type)` still narrows
type DebugEvent = DebugEventBody extends infer B
  ? B extends DebugEventBody ? B & DebugEventMeta : never
  : never

type DebugCacheEntry = {
  queryId: string
  key: readonly unknown[]
  status: 'idle' | 'pending' | 'success' | 'error'
  data: unknown
  error: unknown
  lastUpdatedAt: number | undefined
  isStale: boolean
  isFetching: boolean
  hasPendingMutations: boolean
}

type DebugBus = {
  subscribe(handler: (event: DebugEvent) => void): () => void // replays the live controller tree first
  queryEntries(): DebugCacheEntry[]
}
```

Discriminated union keyed by `type` — devtools consumers `switch` on it. Adding new event variants is non-breaking; consumers ignore unknown types. The `name` on `mutation:*` events is the mutation's `id`.

> Production note: emission sites are elided from the production build of
> `@kontsedal/olas-core` — see §23 *Devtools and production builds*.
> Subscribers attach but receive no events.

```ts
type DehydratedEntry = {
  id: string                 // the query's id
  key: readonly unknown[]
  data: unknown              // the pages, for an infinite query
  lastUpdatedAt: number
  pageParams?: readonly unknown[] // present for an infinite query, one per page
}

type DehydratedState = {
  version: 1
  entries: DehydratedEntry[]
}
```

Versioned so future changes are detectable: `root.hydrate` checks `version` and skips a payload it does not recognise.

### 20.10 UI adapters

**React (`@kontsedal/olas-react`)**, §16.1:

```ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): ReactElement

interface Register {} // augment with `root: typeof root` to type useRoot()
type RegisteredApi = Register extends { root: Root<infer Api> } ? Api : unknown

function useRoot<Api = RegisteredApi>(): Api // the root's api; throws outside a provider

// one typed provider per root, for an app with several
function createOlasContext<Api>(displayName?: string): {
  Provider: (props: { root: Root<Api>; children: ReactNode }) => ReactNode
  useRoot: () => Api
  Context: Context<Root<Api> | null>
}

function useValue<T>(signal: ReadSignal<T>, options?: { isEqual?: (a: T, b: T) => boolean }): T
function useValue<T, U>(
  signal: ReadSignal<T>,
  options: { select: (value: T) => U; isEqual?: (a: U, b: U) => boolean },
): U

// re-renders only for the fields the component reads (§16.1)
type UseQueryResult<T> = {
  data: T | undefined
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  isPaused: boolean
  isEnabled: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
  reset: () => void
  cancel: () => void
}
type UseSuspenseQueryResult<T> = Omit<UseQueryResult<T>, 'data'> & { data: T }

function useQuery<T>(subscription: AsyncState<T>): UseQueryResult<T>
function useQuery<T>(subscription: AsyncState<T>, options: { suspense: true }): UseSuspenseQueryResult<T>
function useSuspenseQuery<T>(subscription: AsyncState<T>): UseSuspenseQueryResult<T>

type UseInfiniteQueryResult<TPage, TItem> = UseQueryResult<TPage[]> & {
  pages: TPage[]
  flat: TItem[]
  hasNextPage: boolean
  hasPreviousPage: boolean
  isFetchingNextPage: boolean
  isFetchingPreviousPage: boolean
  fetchNextPage: () => Promise<void>
  fetchPreviousPage: () => Promise<void>
}
function useInfiniteQuery<TPage, TItem>(
  subscription: InfiniteQuerySubscription<TPage, TItem>,
): UseInfiniteQueryResult<TPage, TItem>
// …and a { suspense: true } overload returning UseSuspenseInfiniteQueryResult

type UseFieldResult<T> = {
  value: T
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
  set: (value: T) => void
  setAsInitial: (value: T) => void
  reset: () => void
  markTouched: () => void
  revalidate: () => Promise<boolean>
  setErrors: (errors: ReadonlyArray<string>) => void
}
function useField<T>(field: Field<T>): UseFieldResult<T>

type UseFieldInputResult = {
  value: string
  onChange: (e: ChangeEvent<{ value: string }>) => void
  onBlur: () => void
  name: string | undefined
  'aria-invalid': boolean | undefined // set once the field is touched and has errors
}
function useFieldInput<T extends string>(
  field: Field<T>,
  options?: { transform?: FieldTransform<T>; name?: string },
): UseFieldInputResult
// …and an overload requiring `transform` for a non-string field

type UseMutationCallbacks<V, R> = {
  onSuccess?: (data: R, variables: V) => void
  onError?: (error: unknown, variables: V) => void
  onSettled?: (data: R | undefined, error: unknown | undefined, variables: V) => void
}
type UseMutationResult<V, R> = {
  data: R | undefined
  error: unknown | undefined
  status: AsyncStatus
  isPending: boolean
  isIdle: boolean
  isSuccess: boolean
  isError: boolean
  lastVariables: V | undefined
  mutate: MutateFn<V>   // fire-and-forget: a failure lands in state, never an unhandled rejection
  run: MutationRun<V, R> // returns the run's promise
  reset: () => void
}
type MutateFn<V> = (...args: Parameters<MutationRun<V, unknown>>) => void
function useMutation<V, R>(mutation: Mutation<V, R>, callbacks?: UseMutationCallbacks<V, R>): UseMutationResult<V, R>

// opt-in suspension
type SuspendableController = { suspend(): void; resume(): void }
function SuspendOnUnmount(props: { controller: SuspendableController; children: ReactNode }): ReactElement
function useSuspendOnHidden(controller: SuspendableController): void

// SSR
function HydrationBoundary<Api>(props: {
  def: ControllerDef<void, Api>
  options: RootOptions<Record<string, unknown>>
  streaming?: boolean // default true: install the streaming intake
  children: ReactNode
}): ReactNode

type StreamingHydratorOptions = { nonce?: string }
type StreamingHydrator = {
  plugin: OlasPlugin // for the server root's `plugins`
  flush(): string    // pending entries as one <script> tag, or ''
  dispose(): void
}
function createStreamingHydrator(options?: StreamingHydratorOptions): StreamingHydrator
function createStreamingTransform(flush: () => string): TransformStream<Uint8Array, Uint8Array>
function installStreamingIntake<Api>(root: Root<Api>): () => void
const OLAS_BOOTSTRAP_SCRIPT: string // for React's bootstrapScriptContent
const STREAMING_GLOBAL: '__OLAS_HYDRATION__'
```

**Vue (`@kontsedal/olas-vue`)**, §16.2:

```ts
function olasPlugin(root: Root<unknown>): { install(app: App): void }

interface Register {}
type RegisteredApi = Register extends { root: Root<infer Api> } ? Api : unknown
function useRoot<Api = RegisteredApi>(): Api // throws when no plugin provided a root

// each field of T as a read-only ref
type Refs<T> = { readonly [K in keyof T]: Readonly<Ref<T[K]>> }

function useValue<T>(signal: ReadSignal<T>, options?: { isEqual?: (a: T, b: T) => boolean }): Readonly<Ref<T>>

type UseQueryReturn<T> = Refs<{
  data: T | undefined
  error: unknown
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  isPaused: boolean
  isEnabled: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
}> & { refetch: () => Promise<T>; reset: () => void; cancel: () => void }
function useQuery<T>(subscription: AsyncState<T>): UseQueryReturn<T>

// useQuery's refs plus pages, flat, the paging flags as refs, and the paging actions
function useInfiniteQuery<TPage, TItem>(
  subscription: InfiniteQuerySubscription<TPage, TItem>,
): UseInfiniteQueryReturn<TPage, TItem>

type UseFieldReturn<T> = {
  value: WritableComputedRef<T> // assigning writes through field.set, for v-model
} & Refs<{
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
}> & {
  set: (value: T) => void
  setAsInitial: (value: T) => void
  reset: () => void
  markTouched: () => void
  revalidate: () => Promise<boolean>
  setErrors: (errors: ReadonlyArray<string>) => void
}
function useField<T>(field: Field<T>): UseFieldReturn<T>

type UseMutationReturn<V, R> = Refs<{
  data: R | undefined
  error: unknown
  status: AsyncStatus
  isPending: boolean
  lastVariables: V | undefined
}> & { mutate: MutateFn<V>; run: MutationRun<V, R>; reset: () => void }
function useMutation<V, R>(mutation: Mutation<V, R>): UseMutationReturn<V, R>
```

**Svelte (`@kontsedal/olas-svelte`)**, §16.3:

```ts
function setRoot(root: Root<unknown>): void // during component initialization

interface Register {}
type RegisteredApi = Register extends { root: Root<infer Api> } ? Api : unknown
function getRoot<Api = RegisteredApi>(): Api // throws when no ancestor called setRoot

// each store is a ReadSignal of the state, with the actions beside it
type QueryState<T> = {
  data: T | undefined
  error: unknown
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  isPaused: boolean
  isEnabled: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
}
type QueryStore<T> = ReadSignal<QueryState<T>> & {
  refetch: () => Promise<T>
  reset: () => void
  cancel: () => void
}
function queryStore<T>(subscription: AsyncState<T>): QueryStore<T>

// QueryState<TPage[]> plus pages, flat and the paging flags; the paging actions beside it
function infiniteQueryStore<TPage, TItem>(
  subscription: InfiniteQuerySubscription<TPage, TItem>,
): InfiniteQueryStore<TPage, TItem>

type FieldState<T> = {
  value: T
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
}
type FieldStore<T> = ReadSignal<FieldState<T>> & {
  set: (value: T) => void
  setAsInitial: (value: T) => void
  reset: () => void
  markTouched: () => void
  revalidate: () => Promise<boolean>
  setErrors: (errors: ReadonlyArray<string>) => void
}
function fieldStore<T>(field: Field<T>): FieldStore<T>

type MutationState<V, R> = {
  data: R | undefined
  error: unknown
  status: AsyncStatus
  isPending: boolean
  lastVariables: V | undefined
}
type MutationStore<V, R> = ReadSignal<MutationState<V, R>> & {
  mutate: MutateFn<V>
  run: MutationRun<V, R>
  reset: () => void
}
function mutationStore<V, R>(mutation: Mutation<V, R>): MutationStore<V, R>
```

**Fakes for UI tests.** `@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)` that produce shape-correct fakes:

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
  // optional key enumeration (e.g. mutation-queue replay, clearPersisted)
  keys?(): Iterable<string> | Promise<Iterable<string>>
}

function localStorageAdapter(): StorageAdapter // SSR-safe: no-ops without localStorage
function indexedDbAdapter(options?: IndexedDbAdapterOptions): StorageAdapter

type IndexedDbAdapterOptions = {
  databaseName?: string              // default 'olas-persist'
  storeName?: string                 // default 'kv'
  channelName?: string | null        // BroadcastChannel for cross-tab onChange; null disables it
  indexedDB?: IDBFactory             // default globalThis.indexedDB; without one, every method no-ops
  broadcastChannel?: typeof BroadcastChannel
}

type PersistErrorOp = 'load' | 'deserialize' | 'serialize' | 'write' | 'migrate' | 'remoteChange'

type PersistOptions<T> = {
  storage?: StorageAdapter | undefined // default: localStorageAdapter()
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  crossTab?: boolean // requires storage.onChange
  version?: number // enable the `{$olas,v,d}` envelope; migrate on version mismatch
  migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
  throttleMs?: number // at most one write per window; flushed on dispose. Default 0
  onError?: (err: unknown, op: PersistErrorOp, key: string) => void // else swallowed
}

type Persisted = {
  ready: ReadSignal<boolean> // true once initial load is complete
}

// structural interface accepted by createPersisted —
// satisfied by Signal<T>, Field<T>, or any custom read/write/subscribe trio.
type PersistableSource<T> = {
  readonly value: T
  set(value: T): void
  subscribe(handler: (value: T) => void): () => void
}

function createPersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: PersistOptions<T>,
): Persisted

type ClearPersistedOptions = {
  prefix?: string // non-empty
  all?: boolean   // required when no prefix is given
  onError?: (err: unknown, key: string) => void
}
function clearPersisted(storage?: StorageAdapter, options?: ClearPersistedOptions): Promise<void>

// the query cache (§13.4)
type QueryCacheErrorOp = 'restore' | 'write'
type PersistQueryCacheOptions = {
  storage?: StorageAdapter   // default localStorageAdapter()
  key?: string               // default 'olas/query-cache'
  buster?: string            // a cache stored under another buster is discarded. Default ''
  maxAgeMs?: number          // default 24 hours
  throttleMs?: number        // default 1000
  include?: (query: QueryRef) => boolean // default: meta.persist === true
  restore?: boolean          // default true
  onError?: (error: unknown, op: QueryCacheErrorOp) => void // default: a dev warning
}
function persistQueryCachePlugin(options?: PersistQueryCacheOptions): OlasPlugin
function restoreQueryCache(options?: PersistQueryCacheOptions): Promise<DehydratedState | undefined>
const PERSIST_QUERY_CACHE_PLUGIN_NAME: 'olas-persist-query-cache'
```

### 20.12 Miscellaneous exports

```ts
// from @kontsedal/olas-core
function isAbortError(err: unknown): boolean
// — true for a DOMException named 'AbortError', and for any object whose `name`
//   is 'AbortError'. Used to filter superseded latest-wins mutations and aborted fetches.

function createEmitter<T = void>(options?: { onError?: EmitterErrorReporter }): Emitter<T>
// — see §20.6

function serializeForScript(value: unknown): string
// — `JSON.parse("…")` over the JSON, escaped for an inline <script> (§15, §22).
//   Throws what JSON.stringify throws, for a BigInt or a cycle.

type Selection<T = unknown> = {
  selectedIds: ReadSignal<ReadonlySet<string>>
  size: ReadSignal<number>
  isSelected(id: string): ReadSignal<boolean> // the same signal per id while anything holds it
  select(id: string): void
  deselect(id: string): void
  toggle(id: string): void
  clear(): void
  selectAll(ids: readonly string[]): void
  handleClick(
    id: string,
    mods: { shift?: boolean; meta?: boolean },
    ordered: readonly string[] | ReadonlyMap<string, number>,
  ): void
}
function createSelection<T = unknown>(options?: { initial?: readonly string[] }): Selection<T>
// — multi-select with shift/meta-click range semantics; see §16.5

// from @kontsedal/olas-core/testing  (sub-entry exception: testing is the one sub-path we ship)
type TestControllerOptions<Props, TDeps> = {
  deps: TDeps
  onError?: RootOptions<TDeps>['onError']
  queries?: QueryEngine | null // default: a live engine; null for the no-engine path
  plugins?: RootOptions<TDeps>['plugins']
  scopes?: RootOptions<TDeps>['scopes']
  hydrate?: RootOptions<TDeps>['hydrate']
} & ([Props] extends [void] ? { props?: Props } : { props: Props })

function createTestController<Props, Api, TDeps extends Record<string, unknown> = Record<string, unknown>>(
  def: ControllerDef<Props, Api>,
  options: TestControllerOptions<Props, TDeps>,
): Root<Api>
// — constructs an isolated root wrapping a single controller. Returns the same
//   handle createRoot does, so the api is on `.api`.

function fakeField<T>(initial: T, overrides?: Partial<{ errors: string[] /* … */ }>): Field<T>
function fakeAsyncState<T>(overrides?: Partial<{ data: T | undefined /* … */ }>): AsyncState<T>

function mockFetchPlugin(
  handlers?: Record<string, MockFetchHandler>, // by query id
  options?: MockFetchOptions,                  // { passthrough?: boolean; delayMs?: number }
): MockFetchPlugin
function createPluginRecorder(): PluginRecorder // records every plugin event a root emits
```

The testing helper is the **only** sub-path export we ship (`@kontsedal/olas-core/testing`). It's separated because importing it in production builds is a smell — tree-shakers should drop it, but a sub-path makes the separation explicit.

---

## 21. Internal architecture

This section describes how `@kontsedal/olas-core` is organized internally. None of these types are exported — they're implementation detail. Listed here so contributors (and devtools) know the boundaries.

### 21.1 Modules

```
src/
  signals/
    index.ts             # public: signal, computed, effect, batch, untracked, types
    runtime.ts           # wraps @preact/signals-core
    readonly.ts          # readOnly(signal) — internal projection helper
    types.ts             # ReadSignal, Signal, Computed
  controller/
    define.ts            # defineController()
    root.ts              # createRoot(): the root handle, plugin setup, dispose order
    instance.ts          # ControllerInstance: the lifecycle list and the Ctx object
    internals.ts         # the handle the ctx-taking primitives reach a controller through
    types.ts             # Ctx, Root, RootOptions, Field, Collection, LazyChild
  query/
    engine.ts            # queryEngine(): the only value import of QueryClient
    client.ts            # QueryClient: per-root entries, gc, hydration, dehydrate, the plugin engine half
    entry.ts             # Entry: per-key state machine + signals
    infinite.ts          # InfiniteEntry + the infinite query types
    define.ts            # defineQuery(), defineInfiniteQuery()
    actions.ts           # the imperative handles, unbound and bound
    bind.ts              # createQuery, createCache, createMutation, bindQuery
    use.ts               # the subscriptions createQuery returns
    local.ts             # LocalCache: anonymous Entry tied to a controller
    mutation.ts          # MutationImpl: concurrency, snapshots, retry; defineMutation
    mutation-registry.ts # the process-wide defineMutation registry, by id
    keys.ts              # key serialization (stable hash for Map lookup)
    structural-share.ts  # structuralShare(prev, next)
    focus-online.ts      # shared window focus and reconnect listeners
    missing-engine.ts    # the "this root has no query engine" error; imports nothing
    errors.ts            # QueryDisabledError
    types.ts
  plugin/
    types.ts             # the public plugin contract
    host.ts              # PluginSet: setup, delivery, isolation, middleware, track, disposal
  forms/
    field.ts             # Field + validator runner
    form.ts              # Form, FieldArray
    form-types.ts        # the form types
    bind.ts              # createField, createForm, createFieldArray
    validators.ts        # required, minLength, email, validator(schema), etc. (stdlib)
    standard-schema.ts   # the Standard Schema v1 types
  timing/
    debounced.ts
    throttled.ts
  brand.ts               # the BRAND, PHANTOM and INTERNAL symbol keys
  expiry-timer.ts        # scheduleExpiry (§21.5)
  emitter.ts             # Emitter implementation
  errors.ts              # ErrorContext, root error dispatcher
  devtools.ts            # DebugEvent emitter
  html.ts                # serializeForScript
  scope.ts               # defineScope
  selection.ts           # createSelection
  utils.ts               # isAbortError, abortableSleep
  index.ts               # public entry — re-exports
  testing.ts             # the /testing sub-path
  test-plugins.ts        # mockFetchPlugin, createPluginRecorder
```

### 21.2 Module responsibilities

| Module             | Owns                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `signals/`         | Reactive primitives. Single source of truth for `Signal` / `ReadSignal` / `Computed`. |
| `controller/`      | The lifecycle: construction, suspension, disposal. Owns `Ctx` shape and `child()` semantics. Builds the root handle and runs plugin setup and teardown in order (§13.1). |
| `query/engine.ts`  | The `QueryEngine` value. The only module that imports `QueryClient` by value, so a root without an engine never bundles the client. |
| `query/client.ts`  | Per-root entry registry. Subscribe/unsubscribe semantics, GC timers, invalidation routing, the hydration buffer and `dehydrate`. Supplies the query and mutation halves of the plugin host. |
| `query/entry.ts`   | One cache entry's state machine. Owns the AsyncState signals and the fetch-id race protection. |
| `query/define.ts`  | `defineQuery` and the `Query` value. Each definition carries a `Set<QueryClient>` of the roots that bound it, for unbound operations (§21.5). |
| `query/mutation.ts`| Mutation execution: concurrency modes (parallel / latest-wins / serial), snapshot stack for rollback, retry, and the plugin events and middleware of each run. |
| `plugin/`          | The plugin contract and `PluginSet`, which delivers events, composes middleware and isolates each plugin's throws. |
| `forms/`           | Field state and validator orchestration (sync + async, debouncing pending validators). |
| `timing/`          | Pure signal projections — no controller knowledge, no lifecycle hooks. |
| `emitter.ts`       | Just a `Set<Handler>`. No imports from anything. |
| `errors.ts`        | Type definitions + a tiny dispatch function. Used by controller and query. |
| `devtools.ts`      | Per-root debug-event multiplexer. Subscribed to by users via `root.debug`. |

### 21.3 Dependency direction

```
                     ┌──────────────┐
                     │   signals/   │  (no deps)
                     └──────┬───────┘
            ┌───────────────┼──────────────────────┐
            ▼               ▼                      ▼
        timing/         forms/               query/entry.ts
                            ▲                      ▲
                            │                      │
                       forms/bind.ts         query/client.ts ◄── query/engine.ts
                            │                      ▲    ▲
                            │                      │    └─ query/bind.ts
                            ▼                      │          │
                   controller/internals.ts ◄───────┼──────────┘
                            ▲                      │ (type only)
                            │                      │
                       controller/ ────────────────┘
                            │
                            ├──► plugin/host.ts ──► query/focus-online.ts
                            ├──► query/missing-engine.ts
                            ├──► errors.ts, devtools.ts
                            └──► emitter.ts (used by ctx)
```

Rules:

- **`controller/` never imports the query engine by value.** `createRoot` reaches a `QueryClient` only through the `QueryEngine` passed in `RootOptions.queries`. `query/engine.ts` is the one value importer of the client. `packages/core/tests/tree-shaking.test.ts` pins that neither `instance.ts` nor `root.ts` reaches `engine.ts`.
- **The ctx-taking primitives depend on `controller/internals.ts`, not the other way.** `query/bind.ts` and `forms/bind.ts` reach a controller's lifecycle list, path and error handler through `ctx`. Nothing in `controller/` imports them, which is why a controller that builds no form ships no form code.
- **The query engine knows only abstract subscribers.** `query/client.ts`, `entry.ts`, `infinite.ts` and `mutation.ts` import no controller module. A subscription created by `createQuery(ctx, ...)` registers its own teardown on the controller.
- **`plugin/host.ts` imports no engine module but the shared focus and reconnect listeners.** A root with plugins and no engine therefore still bundles no client.
- **`signals/` imports nothing else.** Swappable runtime.
- **`emitter.ts` imports nothing.** Pure data structure.
- **`devtools.ts` is a sink.** Other modules push to it; it doesn't pull.

### 21.4 Runtime objects: who holds what

A live root consists of:

```
Root handle (frozen)
├── api                    (what the root factory returned)
├── QueryClient            (one per root, or none without an engine)
├── PluginSet              (one per root with plugins)
├── DevtoolsEmitter        (one per root)
├── onError handler        (one per root, default console.error)
├── deps                   (immutable per root)
└── rootController: ControllerInstance
        ├── parent: null
        ├── entries: LifecycleList   (children, effects, subscriptions, caches, mutations,
        │                             fields, onDispose/onSuspend/onResume hooks —
        │                             one list, in registration order, §4)
        ├── scopes                   (provided here, or seeded by plugins and RootOptions.scopes)
        └── path: ['root']
```

Each child `ControllerInstance` inherits a *reference* to the root's `QueryClient`, `DevtoolsEmitter`, and `onError` — passed in at construction. Deps are merged from parent + override and stored on the instance.

### 21.5 The query-client / query-value binding

Queries are module-scoped definitions. Each root owns its cache entries. `bindQuery(ctx, query)` and `root.bindQuery(query)` return a typed imperative handle for only that root, without subscribing or fetching. Regular handles expose `invalidate`, `invalidateAll`, `cancel`, `cancelAll`, `setData`, `write`, `replace`, `peek`, and `prefetch`; infinite handles expose the same set over pages. Bound prefetch can run before the first subscription. Bound handles fail after root disposal. `{ origin }` stamps the handle's writes and invalidations for plugins (§13.1).

Each definition carries a `Set<QueryClient>`. Binding a handle or an entry registers its client; disposal unregisters it. Unbound methods resolve only when at most one client is registered. With multiple clients a synchronous method throws and a promise method rejects, before reading data, running an updater, or starting work. With no clients, reads return undefined and writes, cancellation and invalidation do nothing, while prefetch rejects. An intentional broadcast requires explicitly iterating bound root handles.

Each client also indexes the queries it has bound by `id`, which is what `host.queries.get(id)` reads. There is no process-wide query registry, so `host.queries` reaches only its own root's entries: `host.queries.invalidate(id, key)` refetches in that root alone, including the mutation queue's replay reconciliation. Cross-tab transport remains explicit plugin behavior. The `defineMutation` registry is process-wide, because a replay must find a definition before any controller exists.

Cache keys use a recursive tagged encoding: every primitive, array, object and supported special value has its own type tag. Object properties are sorted; user data cannot impersonate special-value tags. Cycles, functions, symbols, Map/Set and unsupported class instances throw. The hash string (`host.queries.hashKey`) is opaque, and its format is not a persistence protocol.

Expiry scheduling is shared. `scheduleExpiry` in `expiry-timer.ts` creates **no timer at all** for a non-finite delay, and walks a finite one in chunks against an absolute deadline. A delay above the platform's signed 32-bit limit therefore cannot overflow into an immediate fire. Every user-supplied duration goes through it: the staleness timer in `Entry` and `InfiniteEntry`, the gc timer in `ClientEntry` and `InfiniteClientEntry`, the `refetchInterval` chain, the retry backoff in `abortableSleep`, and `suspend({ maxIdleTime })`. So `staleTime: Infinity` stays fresh until explicitly invalidated, and `gcTime: Infinity` retains a released entry for the life of the root. This applies to regular and infinite entries, initial hydration and streamed hydration.

### 21.6 Cache entry state machine

Each `Entry<T>` holds (simplified):

```ts
class Entry<T> {
  data: Signal<T | undefined>
  error: Signal<unknown | undefined>
  status: Signal<AsyncStatus>
  isLoading: Signal<boolean>
  isFetching: Signal<boolean>
  isStale: Signal<boolean>
  isPaused: Signal<boolean>
  lastUpdatedAt: Signal<number | undefined>
  hasPendingMutations: Signal<boolean>

  private currentFetchId = 0     // monotonic, latest-wins
  private currentAbort: AbortController | null = null // dropped once its request settles

  refetch(): Promise<T> { ... }
  invalidate(): void { ... }
  setData(updater): Snapshot { ... }
  private startFetch(): void {
    this.currentFetchId += 1
    const myId = this.currentFetchId
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort
    // The client's fetcher calls spec.fetcher({ signal, deps }, ...args)
    // through every plugin's wrapFetch (§13.1), once per retry attempt.
    this.fetcher(abort.signal, attempt).then(
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

The `currentFetchId` counter is how §5.6 (race protection) is implemented — stale results check their id against the latest before writing. Subscriber counting and the gc timer live one level up, on the client's `ClientEntry`.

### 21.7 Mutation runner

```ts
class MutationImpl<V, R> {
  private inflight = new Set<{ abort: AbortController; snapshot: Snapshot | undefined }>()
  private serialQueue: Array<{ vars: V; resolve; reject }> = []

  run(vars: V): Promise<R> {
    switch (this.spec.concurrency ?? 'parallel') {
      case 'parallel': // every run independent
      case 'latest-wins': // aborts the in-flight run first
      case 'serial': // queues
    }
  }
}
```

The snapshot stack for rollback lives on the cache entry, ordered by application time (§6.4). On rollback, only the failed mutation's snapshot is invoked. Snapshots themselves close over the pre-update value of any caches they touched. A run gets a `runId` whenever a plugin observes mutations, and always in development. The same id is the devtools `causeId` and the `runId` plugins see on `onMutation` and `wrapMutate`.

### 21.8 Devtools event flow

Every controller, query client, and mutation runner gets a reference to the root's `DevtoolsEmitter`. Events are emitted synchronously at relevant points (no batching). The emitter is a `Set<(event: DebugEvent) => void>`.

Users opt in via `root.debug.subscribe(handler)`. With no subscribers, the emitter calls are roughly free (one Set size check).

### 21.9 SSR flow

```ts
// dehydrate (server)
root.dehydrate(): DehydratedState
// walks the regular and infinite entries, and serializes each settled one
// (status 'success') with its query id, key, data, lastUpdatedAt and, for an
// infinite entry, pageParams

// hydrate (client)
createRoot(def, { queries: queryEngine(), hydrate: state })
// the client buffers the entries by id + key hash; an entry that binds a key
// adopts its payload: data, status='success', lastUpdatedAt, one 'hydrate' write
// no fetches kicked off until subscribers arrive (then staleTime applies)
```

`root.waitForIdle()` loops until nothing moves:
- it waits until no entry is fetching and the root's mutation in-flight count is zero, `serial` queues included;
- then it waits for the work plugins `track`ed (§13.1), which can start fetches of its own;
- it throws after 100 rounds, rather than let `dehydrate()` ship a payload that looks complete and is not.

A fetch that starts *after* `waitForIdle` resolves does not retroactively block it; intentional.

---

## 22. Trust model

Olas trusts its own process. It treats everything that reaches it from outside as data, and it checks that data before use. Three classes of input, from most to least trusted:

**Trusted as authored.**
- A `DehydratedState` passed to `createRoot({ hydrate })` or `root.hydrate`. It comes from the app's own server, so core checks its `version` and the shape of each entry. It skips an entry it cannot read, such as one whose key is nested too deep to hash, and hydrates the rest.
- Every script in the page. Same-origin code can already push to the streaming intake, write storage and post on a `BroadcastChannel`. Olas does not defend against it.

**Untrusted: query and mutation data.** A fetcher's result usually holds strings someone else wrote. Olas never evaluates that data, and never lets a key in it change a prototype. `structuralShare`, `Form.set`, `setAsInitial` and the entities deep merge copy only own keys, and they write a `__proto__` key as a plain data property. Where Olas writes data into HTML, it escapes it for that context:
- `serializeForScript(value)` returns `JSON.parse("…")` over the JSON, with every character that could end the string, the script or an attribute written as a `\uXXXX` escape. Use it for any state inlined into a page.
- The streaming hydrator serializes each batch that way, and `createStreamingTransform` writes a batch only where the HTML so far sits between elements. React writes in fixed-size chunks, so a chunk can end inside a tag or an attribute value. `createStreamingHydrator({ nonce })` puts a CSP nonce on every tag it emits.

**Possibly corrupt: same-origin state other code can write.** Storage and `BroadcastChannel` messages may come from a user's edit, an old build, or a script that ran once. Olas treats them as possibly corrupt, not hostile. Before use, each package checks structure, types, ranges and depth, and drops or reports what does not fit:
- `persistQueryCachePlugin` rejects an entry dated in the future, which would otherwise stay fresh for any `staleTime`. It reports every restore failure through `onError`, on sync and async storage alike.
- `createPersisted` reports a stored value its source refuses as a `'deserialize'` error, and still settles `ready`.
- The mutation queue checks each entry's shape, attempt count and timestamps, and requires its storage key to match its contents. It replays only definitions whose `meta.persist` is `true`, looked up through `host.mutations.get`. Stored data can delay or repeat an opted-in write; it cannot choose which operation runs.
- `crossTabPlugin` ignores a message whose `msgId` is not a safe non-negative integer. It reports a message it cannot apply through `onWarn`, and never lets it throw out of the channel's handler. Its `validate(queryId, data)` option lets a tab reject a payload shape it did not expect.

A malformed value never throws out of `createRoot`, never leaves a root or signal wedged, and never bypasses `onError` or `onWarn`. The security tests pin each rule above: `streaming-security.test.tsx` in react, `security.test.ts` in mutation-queue and cross-tab, `query-cache-security.test.ts` and `persisted-security.test.ts` in persist, `merge-security.test.ts` in entities, and the "W15 regression" blocks in core's `regressions.test.ts`.

Olas does not check that restored data matches a query's type. The tools for that are the consumer's: `persistQueryCachePlugin`'s `buster`, versioned channel names, `createPersisted`'s `version` and `migrate`, and cross-tab's `validate`.

---

## 23. Performance characteristics

Honest estimates so users know what they're paying for. All numbers are order-of-magnitude — actual perf depends on platform, payload size, and usage pattern.

### Bundle size

`size-limit` holds a brotli budget for each entry, and CI fails a build over it (`pnpm size`, `.size-limit.json`). Each budget sits about 5% over the size measured when it was set (`.wiki/decisions/esm-only-build.md`). The budgets, with the runtime peers left out:

| Entry | Budget, brotli |
|---|---|
| core: `createRoot`, `defineController`, `signal`, `computed` | 5.4 kB |
| core: controllers + `createField`, `createForm`, `createFieldArray` | 9.2 kB |
| core: controllers + `queryEngine`, `defineQuery`, `createQuery`, `createMutation` | 16.6 kB |
| core: everything | 22.3 kB |
| react | 3.8 kB |
| vue | 0.9 kB |
| svelte | 0.85 kB |
| persist: `createPersisted` / `persistQueryCachePlugin` | 1.05 kB / 1.25 kB |
| zod | 1.35 kB, plus Zod itself |
| cross-tab / entities / mutation-queue | 1.4 kB / 2.2 kB / 3.3 kB |
| realtime / router | 1.05 kB / 0.65 kB |
| devtools | 18.8 kB, loaded behind the app's own dev gate |

For a "kitchen sink" app, everything in core plus react, `createPersisted` and zod stays within about 28.5 kB, plus Zod itself.

Tree-shaking removes unused parts of core, at the level of the free functions (§3.2). A controllers-only bundle carries neither forms nor the query engine, and `pnpm smoke:dist` pins that against the published `dist`. Forms enter with `createField`, `createForm` or `createFieldArray`, and cost about 4 kB. The query engine enters only with `queryEngine`.

### Measured speed

`.wiki/decisions/benchmarks.md` records a dated comparison with raw `@preact/signals-core`, MobX and TanStack Query core, with the method and the machine. On that run raw preact was about 1.3× faster than Olas at signal fan-out, which is the cost of the wrapper. Olas was about 2× faster than TanStack Query at a write observed by 10,000 subscribers, and TanStack Query was about 1.1× faster at a 1,000-query fetch cycle. `pnpm bench` runs the suites; no CI job does, because wall-clock timing is noisy.

### Per-primitive overhead

| Primitive | Approx allocation | Approx signals |
|---|---|---|
| `ControllerInstance` | ~500 B base + its lifecycle list | 0 |
| `signal()` | ~80 B + boxed value | 1 |
| `computed()` | ~120 B + dep-tracking node | 1 |
| `effect()` | ~150 B + dep-tracking + closure | 0 (it consumes signals) |
| `createCache(ctx, fetcher)` | ~400 B (Entry state machine) | 8 |
| `createQuery(ctx, query)` | ~80 B (subscription record) | 0 (shares Entry's signals) |
| `createMutation(ctx, spec)` | ~250 B (runner) | 4 |
| `createField(ctx, initial)` | ~300 B | 6 |
| `createForm(ctx, { a, b, c })` | ~500 B + leaf cost | 6 + child signals (computed) |
| `ctx.emitter()` | ~100 B + handlers Set | 0 |

These add up. A controller with 5 fields, 2 mutations, and 3 cache subscriptions is roughly `500 + 5×300 + 2×250 + 3×80 = 2,740 B` plus ~40 signals. For 1,000 such controllers, that's ~3 MB and 40,000 signals — workable but not free. **Per §11.2, prefer plain signals/maps for high-cardinality homogeneous items.**

### "How many controllers is too many?"

- **Under 100:** never a concern.
- **100–1,000:** fine, but profile if you mount/unmount frequently.
- **1,000–10,000:** consider reducing — use a `ctx.collection` with per-item controllers only if each item has its own logic; otherwise model items as data inside a parent.
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
- Subscribed entries are never gc'd. A suspended controller releases its entries, so they age out like a disposed one's — see §4.1.

### Devtools events

- `root.debug.subscribe(handler)` makes the per-event cost roughly free when no one is listening (one Set size check, < 100 ns).
- With one subscriber, expect ~1–5 µs per event (allocation of the event object + handler invocation).
- For a noisy controller (many cache events and sec), this matters. Use the devtools subscription only in dev, not in prod.

### Form perf

- `form.value` is one big `computed` reading every leaf. Re-derives only when *some* leaf changes. UI subscribing to the whole form (`useValue(form)`) re-renders on any change to anything — typically the wrong thing to do; subscribe to specific fields via `useField(form.fields.x)`.
- `form.set(partial)` batches its leaf writes (one notification pass).
- Validators run in tracking scopes; their dependency on other signals is automatic but they re-run whenever those signals change, which can be more often than expected for cross-field validators.

### Devtools and production builds

The packages with dev-only code (core, cross-tab, entities, mutation-queue, persist, react, vue and zod) each ship two builds from one source, behind export conditions:

| Condition | File | `__DEV__` |
|---|---|---|
| `default` | `dist/index.js` | `false`: every `if (__DEV__)` branch is stripped at build time |
| `development` | `dist/dev/index.js` | `true`: devtools events and dev-only warnings are kept |

`__DEV__` is fixed per build in each package's `tsdown.config.ts`, so neither build depends on the environment it was built in. The types are the same for both, and only the default build emits declarations.

**Which build an app gets.** A bundler that resolves the `development` condition in dev gets the dev build: Vite's dev server, webpack and Rspack in development mode, and Next.js in dev. `vite build` and a webpack production build resolve the default. esbuild and Rollup resolve `development` only when told to (`conditions: ['development']`), and Node with `--conditions=development`. A browser with no bundler, or a CDN, gets the default build.

What each build means for the devtools:

- **Development build.** `root.debug.subscribe(handler)` receives every event (§14). `ctx.debug(...)` and a plugin's `host.debug(...)` reach the panel. `@kontsedal/olas-devtools` shows the controller tree, the timeline and every lane.
- **Default build.** `root.debug.subscribe(handler)` still exists and accepts the handler, but it is never called. The snapshot replay (live controllers at subscribe time) is empty too, because the `controller:constructed` and `controller:suspended/resumed/disposed` emission sites that feed the `DevtoolsEmitter`'s `liveControllers` map are inside the same guard. `ctx.debug(...)` and `host.debug(...)` are no-ops. `root.debug.queryEntries()` still returns the live cache snapshot, since that path does not depend on emission.

Consumers never define `__DEV__` themselves: both builds have it inlined. `pnpm smoke:dist` fails a build that leaves a `__DEV__` reference in code. It also fails when core has no `development` condition, when the default build emits a devtools event, or when the development build emits none.
