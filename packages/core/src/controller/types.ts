import type { Emitter } from '../emitter'
import type { ErrorContext } from '../errors'
import type { OlasPlugin } from '../plugin/types'
import type { BindQueryOptions } from '../query/client'
import type { QueryEngine } from '../query/engine'
import type { InfiniteQuery, InfiniteQueryActions } from '../query/infinite'
import type { Query, QueryActions } from '../query/types'
import type { Scope } from '../scope'
import type { ReadSignal } from '../signals/types'
import type { CTX_INTERNALS, CtxInternals } from './internals'

/**
 * App-wide deps available on every controller's `ctx.deps`.
 *
 * Default shape carries an index signature so untyped reads compile (as
 * `unknown`). Users augment this interface in their app to add typed services:
 *
 * ```ts
 * declare module '@kontsedal/olas-core' {
 *   interface AmbientDeps {
 *     api: ApiClient
 *     session: SessionStore
 *   }
 * }
 * ```
 */
export interface AmbientDeps {
  [key: string]: unknown
}

/**
 * A reactive form field. Extends `ReadSignal<T>` for the current value, plus
 * five signals for state (errors / isValid / isDirty / touched / isValidating)
 * and four methods (`set`, `reset`, `markTouched`, `revalidate`). Created via
 * `createField(ctx, initial, { validators, validateOn })`. Spec §8, §20.7.
 */
export type Field<T> = ReadSignal<T> & {
  /**
   * All errors currently surfaced on this field — validator errors first,
   * server errors after. See `setErrors` for the server-error channel.
   */
  errors: ReadSignal<string[]>
  isValid: ReadSignal<boolean>
  isDirty: ReadSignal<boolean>
  touched: ReadSignal<boolean>
  isValidating: ReadSignal<boolean>
  set(value: T): void
  /**
   * Reseat the field as if this value had been its constructor `initial`:
   * writes the value, re-anchors `reset()`'s target, leaves `isDirty` false.
   * `Form` uses this when applying its own `initial` (constructor + reset),
   * so a form populated from server data isn't born dirty. Useful for any
   * "load this value as the new baseline" pattern.
   */
  setAsInitial(value: T): void
  reset(): void
  markTouched(): void
  revalidate(): Promise<boolean>
  /**
   * Pin externally-sourced errors on the field — typically server-side
   * validation results returned from a failed submit. These errors live in
   * a separate channel from validator output, so a re-run of local
   * validators (triggered by a new value or `revalidate()`) does NOT clear
   * them. They're cleared automatically the next time the user writes to
   * the field (via `set`), or explicitly via `setErrors([])` / `reset()`.
   */
  setErrors(errors: ReadonlyArray<string>): void
  /** Idempotent. Called by the owning controller's dispose. */
  dispose(): void
}

/** Options for `root.suspend(options?)`. */
export type SuspendOptions = {
  /** Dispose the root if it is not resumed within this many milliseconds. */
  maxIdleTime?: number
}

/**
 * The handle returned by `defineController(...)`. Pass it to `createRoot(...)`
 * or `ctx.child(...)` to instantiate. Phantom types preserve `Props` / `Api`
 * for inference via `CtrlProps<C>` / `CtrlApi<C>`.
 */
export type ControllerDef<Props, Api> = {
  readonly [BRAND]: 'controller'
  readonly [PHANTOM]?: { props: Props; api: Api }
}

/** Extract a controller's Props type. */
export type CtrlProps<C> = C extends ControllerDef<infer P, unknown> ? P : never

/** Extract a controller's Api type. */
export type CtrlApi<C> = C extends ControllerDef<unknown, infer A> ? A : never

/**
 * The reactive surface returned by `ctx.collection(...)`. `items` is the
 * canonical ordered view (source-order, with any construction-failed items
 * filtered out); `size` mirrors `items.length`; `get` / `has` are
 * imperative key lookups. SPEC §11.1.
 */
export type Collection<K, Api> = {
  readonly items: ReadSignal<ReadonlyArray<{ readonly key: K; readonly api: Api }>>
  readonly size: ReadSignal<number>
  get(key: K): Api | undefined
  has(key: K): boolean
  /**
   * Suspend a specific collection item by key — pauses its effects without
   * disposing it (mirrors `attach.suspend()`). Useful for virtualized
   * lists where rows scrolled out of view should stop running their
   * effects but stay reconstructible without re-fetching their state.
   *
   * No-op if the key isn't in the collection. Neither the collection
   * reconcile nor a whole-tree `suspend()`/`resume()` cascade (e.g.
   * SuspendOnUnmount) will auto-resume a suspended item — call `resumeItem(key)`
   * to bring it back (spec §4.1).
   */
  suspendItem(key: K): void
  /** Resume a previously-suspended item. No-op if not suspended / not present. */
  resumeItem(key: K): void
  /** Whether the item is currently suspended. False when not present. */
  isItemSuspended(key: K): boolean
}

/**
 * Homogeneous form of `ctx.collection`: one controller def for every item,
 * with `propsOf` projecting each item to the controller's `Props`. Construct
 * happens once per new key — `propsOf` is **not** re-applied for unchanged
 * keys.
 */
export type CollectionHomogeneousOptions<Item, K, Props, Api, TDeps = AmbientDeps> = {
  readonly source: ReadSignal<readonly Item[]>
  readonly keyOf: (item: Item) => K
  readonly controller: ControllerDef<Props, Api>
  readonly propsOf: (item: Item) => Props
  readonly factory?: never
  readonly propsFor?: never
  readonly deps?: Partial<TDeps>
}

/**
 * Heterogeneous form of `ctx.collection`: a single `factory` decides per-item
 * which controller + props to construct. When a key's factory result picks a
 * *different* controller than last time, the existing child is disposed and
 * the new one constructed (type-discriminant rebuild).
 *
 * `R` is the factory's *return type* (typically inferred as the union of the
 * branches' `{ controller, props }` shapes). `Api` is then projected out as
 * the union of every branch's controller Api via `CollectionFactoryApi<R>` —
 * unlike a single `Api` generic, the union doesn't collapse to the first
 * branch.
 */
export type CollectionFactoryOptions<Item, K, R, TDeps = AmbientDeps> = {
  readonly source: ReadSignal<readonly Item[]>
  readonly keyOf: (item: Item) => K
  readonly controller?: never
  readonly propsOf?: never
  readonly factory: (item: Item) => R
  readonly deps?: Partial<TDeps>
}

/** Constraint for the factory form's return shape. */
export type CollectionFactoryResult = { controller: ControllerDef<any, any>; props: any }

/** Extract the union of every branch's controller Api. Distributes over R. */
export type CollectionFactoryApi<R> = R extends {
  controller: ControllerDef<any, infer A>
}
  ? A
  : never

/**
 * Handle returned by `ctx.lazyChild(...)`. `status` walks `idle → loading →
 * (ready | error)`; `api` becomes defined once `status === 'ready'`. SPEC §16.5.
 */
export type LazyChild<Api> = {
  readonly status: ReadSignal<'idle' | 'loading' | 'ready' | 'error'>
  readonly api: ReadSignal<Api | undefined>
  readonly error: ReadSignal<unknown | undefined>
  load(): Promise<Api>
  dispose(): void
}

/**
 * `ctx` is the lifecycle-bound surface every controller factory receives.
 * Every primitive constructed through `ctx` is owned by the controller and
 * disposed when the controller disposes. The primitives are free functions
 * that take `ctx` first (`createField`, `createQuery`, `createMutation` and
 * the rest); `ctx` itself carries the tree and the lifetime.
 */
export type Ctx<TDeps = AmbientDeps> = {
  /**
   * @internal Escape hatch for the `ctx`-taking primitives (`createField`,
   * `createQuery`, …). Not for application code — the shape can change in a
   * patch release. See `controller/internals.ts`.
   */
  readonly [CTX_INTERNALS]: CtxInternals

  emitter<T = void>(): Emitter<T>

  child<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): Api

  /**
   * Like `child(...)` but additionally returns a handle that lets the parent
   * control the attached sub-tree's lifecycle independently — `dispose()`
   * tears it down early, and `suspend()` / `resume()` freeze and thaw it.
   * The child is still disposed automatically when the parent disposes;
   * `dispose()` / `suspend()` / `resume()` are idempotent.
   *
   * `<SuspendOnUnmount controller={…}>` in `@kontsedal/olas-react` consumes the
   * returned `{ suspend, resume }` directly — no hand-rolled `isPaused`
   * signal needed on the child's `Api`. Useful for "openable" sub-
   * controllers driven by a user gesture (modal, side panel, wizard).
   *
   * `suspend()` cascades through the attached controller's lifecycle
   * entries: cache subscriptions pause `refetchInterval` and release the
   * entry, effects are torn down, `onSuspend(...)` handlers fire. `resume()`
   * re-runs effects, re-acquires cache entries (a stale entry refetches),
   * and fires `onResume(...)`. Spec §4.1, §16.5.
   */
  attach<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): { api: Api; dispose: () => void; suspend: () => void; resume: () => void }

  /**
   * Diff-by-key set of child controllers driven by a reactive `source`.
   * On every change to `source`, the collection:
   *   - **new keys** → construct a child via `controller` + `propsOf(item)`
   *     (or `factory(item)` for the heterogeneous form);
   *   - **removed keys** → dispose that child;
   *   - **unchanged keys** → leave it alone (`propsOf` is NOT re-applied).
   *
   * For per-item type-discriminated children, use the `factory` form —
   * type changes for an existing key dispose and reconstruct.
   *
   * Construction errors (factory or controller throw) are routed to
   * `onError` with `kind: 'construction'` and the item is **skipped** —
   * the collection's surface shows one fewer entry. The diff loop does
   * not re-throw. SPEC §11.1, §12.1.6.
   */
  collection<Item, K, Props, Api>(
    options: CollectionHomogeneousOptions<Item, K, Props, Api, TDeps>,
  ): Collection<K, Api>
  collection<Item, K, R extends CollectionFactoryResult>(
    options: CollectionFactoryOptions<Item, K, R, TDeps>,
  ): Collection<K, CollectionFactoryApi<R>>

  /**
   * Code-split child controller. The loader is invoked on `load()`
   * (idempotent), then the controller is constructed with the supplied
   * `props`. `status` / `api` / `error` are reactive signals; subscribe
   * via `useValue(child.api)` in your view layer.
   *
   * Parent disposal disposes the loaded child (if any) and flags any
   * in-flight load so its eventual settle is dropped on the floor.
   * Construction or import failures route through `onError` with
   * `kind: 'construction'`. SPEC §16.5.
   */
  lazyChild<Props, Api>(
    loader: () => Promise<ControllerDef<Props, Api>>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): LazyChild<Api>

  effect(fn: () => void | (() => void)): void

  /**
   * Expose a bag of named values to the devtools "Variables" view for this
   * controller. Pass live references — signals/computeds/fields render their
   * current value and update reactively in the panel; plain values show a
   * snapshot. Names come from the object keys; call it more than once to merge.
   *
   * Dev-only: a no-op in production builds (stripped like the rest of the
   * debug bus), so it costs nothing and retains nothing there.
   *
   * ```ts
   * const count = signal(0)
   * const doubled = computed(() => count.value * 2)
   * ctx.debug({ count, doubled })
   * ```
   */
  debug(values: Record<string, unknown>): void

  on<T>(emitter: Emitter<T>, handler: (value: T) => void): void

  // scopes — typed cross-tree data (§10.3)
  provide<T>(scope: Scope<T>, value: T): void
  inject<T>(scope: Scope<T>): T

  onDispose(fn: () => void): void
  onSuspend(fn: () => void): void
  onResume(fn: () => void): void

  readonly deps: TDeps
}

import type { BRAND, PHANTOM } from '../brand'
import type { DebugBus } from '../devtools'
import type { DehydratedState } from '../query/types'

/**
 * Configuration passed to `createRoot(def, options)`. `deps` is required and
 * available everywhere as `ctx.deps`. `onError` receives errors from effects,
 * mutations, caches, emitter handlers, and construction. `hydrate` replays a
 * `DehydratedState` produced on the server. Spec §20.8.
 */
export type RootOptions<TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  hydrate?: DehydratedState
  /**
   * The query engine. Omit it and this root has no cache: `createQuery`,
   * `createMutation` and `bindQuery` throw a message naming the fix, and
   * `query/client.ts` — the largest module in the package — never enters the
   * bundle.
   *
   * ```ts
   * createRoot(app, { deps, queries: queryEngine() })
   * ```
   *
   * Query defaults (`staleTime`, `retry`, focus and reconnect refetch, …)
   * are configured on the engine: `queryEngine({ defaults })`. The client is
   * created eagerly inside `createRoot`, before the factory runs.
   */
  queries?: QueryEngine
  /**
   * Plugins, set up in this order before the root controller's factory runs
   * and disposed in reverse when the root disposes. A plugin's query and
   * mutation hooks need `queries`; without it, `host.queries` is `null`.
   * Spec §13.
   */
  plugins?: readonly OlasPlugin[]
  /**
   * Pre-seed scopes on the root controller before its factory runs. Useful
   * for cross-cutting values an adapter wants to provide once (theme tokens,
   * a fake of a plugin's service in a test) without forcing the user's root
   * controller to call `ctx.provide(...)`.
   *
   * Bindings are flat `[scope, value]` tuples; later bindings for the same
   * scope override earlier ones, and all of them override a value a plugin
   * `provide`d. `ctx.inject` from any descendant resolves these via the normal
   * scope chain walk. SPEC §10.3.
   */
  scopes?: ReadonlyArray<readonly [Scope<unknown>, unknown]>
}

/**
 * The handle `createRoot(...)` returns. The root controller's public api lives
 * on `api`; everything else is the root's own surface — lifecycle, SSR, scope
 * lookup, imperative query operations and the devtools bus. Keeping the two
 * apart means a controller may return anything, including members named
 * `dispose` or `suspend`, and the root can grow new controls without taking a
 * name from anyone's api. Spec §20.8.
 */
export type Root<Api> = {
  /** What the root controller's factory returned. */
  readonly api: Api
  /**
   * Bind imperative query operations to this root without subscribing or
   * fetching. `options.origin` tags the handle's writes for plugins.
   */
  bindQuery<Args extends unknown[], T>(
    query: Query<Args, T>,
    options?: BindQueryOptions,
  ): QueryActions<Args, T>
  bindQuery<Args extends unknown[], TPage, TItem>(
    query: InfiniteQuery<Args, TPage, TItem>,
    options?: BindQueryOptions,
  ): InfiniteQueryActions<Args, TPage, TItem>
  /**
   * Resolve a scope as the root controller would through `ctx.inject(...)`:
   * a value it provided, a value seeded through `RootOptions.scopes` or a
   * plugin, else the scope's default. Throws when none exists.
   */
  inject<T>(scope: Scope<T>): T
  /** Tear down the whole tree and the query client. Idempotent. */
  dispose(): void
  /**
   * Freeze the tree: effects stop, subscriptions release their entries,
   * `onSuspend` handlers run. With `maxIdleTime`, the root disposes itself if it
   * is not resumed within that many milliseconds. Spec §4.1, §4.3.
   */
  suspend(options?: SuspendOptions): void
  /** Thaw a suspended tree: effects re-run, stale entries refetch. */
  resume(): void
  /** Serialize the query cache for SSR. Spec §15. */
  dehydrate(): DehydratedState
  /**
   * Apply dehydrated entries to this root's cache. An entry whose key is
   * already bound is written through and supersedes any inflight fetch; the
   * rest are buffered until a subscription binds that key. Used by streaming
   * SSR, where each resolved `<Suspense>` boundary pushes its entries into
   * the live client root, and by warm starts from storage. Idempotent.
   */
  hydrate(state: DehydratedState): void
  /**
   * Resolves when no fetch, no mutation and no work a plugin `track`ed is in
   * flight. Spec §15.
   */
  waitForIdle(): Promise<void>
  /** The devtools event bus. Dev-only events; see spec §14. */
  readonly debug: DebugBus
}
