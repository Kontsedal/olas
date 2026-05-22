import type { Emitter } from '../emitter'
import type { ErrorContext } from '../errors'
import type {
  FieldArray,
  FieldArrayOptions,
  Form,
  FormOptions,
  FormSchema,
  ItemInitial,
} from '../forms/form-types'
import type { Validator } from '../forms/types'
import type { InfiniteQuery, InfiniteQuerySubscription } from '../query/infinite'
import type { Mutation, MutationSpec } from '../query/mutation'
import type { QueryClientPlugin } from '../query/plugin'
import type { LocalCache, Query, QuerySubscription, UseOptions } from '../query/types'
import type { Scope } from '../scope'
import type { Computed, ReadSignal, Signal } from '../signals/types'

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
 * `ctx.field(initial, validators?)`. Spec §8, §20.7.
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

/**
 * The handle returned by `defineController(...)`. Pass it to `createRoot(...)`
 * or `ctx.child(...)` to instantiate. Phantom types preserve `Props` / `Api`
 * for inference via `CtrlProps<C>` / `CtrlApi<C>`.
 */
export type ControllerDef<Props, Api> = {
  readonly __olas: 'controller'
  readonly __types?: { props: Props; api: Api }
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
   * No-op if the key isn't in the collection. The collection reconcile
   * will not auto-resume a suspended item; call `resumeItem(key)` to
   * bring it back.
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
 * disposed when the controller disposes.
 *
 * Phase 3 surface — caches, mutations, forms, collections, scopes, etc.
 * land in later phases.
 */
export type Ctx<TDeps = AmbientDeps> = {
  cache<T>(
    fetcher: (signal: AbortSignal) => Promise<T>,
    options?: {
      key?: () => readonly unknown[]
      staleTime?: number
      keepPreviousData?: boolean
      initialData?: T | undefined
    },
  ): LocalCache<T>

  // Select-projecting overload — picked when the options object has a
  // required `select` field. `key`'s return is `readonly [...Args]` so
  // callers writing `() => [id] as const` flow through cleanly.
  use<Args extends unknown[], T, U>(
    source: Query<Args, T>,
    options: {
      key?: () => readonly [...Args]
      enabled?: () => boolean
      select: (data: T) => U
    },
  ): QuerySubscription<U>
  use<Args extends unknown[], T>(
    source: Query<Args, T>,
    keyOrOptions?: (() => readonly [...Args]) | UseOptions<Args>,
  ): QuerySubscription<T>
  use<Args extends unknown[], TPage, TItem>(
    source: InfiniteQuery<Args, TPage, TItem>,
    keyOrOptions?: (() => readonly [...Args]) | UseOptions<Args>,
  ): InfiniteQuerySubscription<TPage, TItem>

  mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R>

  emitter<T = void>(): Emitter<T>

  /**
   * Convenience re-export of the standalone `signal(initial)` function bound
   * to the controller's surface. Identical semantics — there's no lifecycle
   * to manage for a plain signal — but having it on `ctx` makes "everything
   * I need is on ctx" feel honest and lets consumers avoid importing from
   * `@kontsedal/olas-core` separately.
   */
  signal<T>(initial: T): Signal<T>

  /**
   * Convenience re-export of the standalone `computed(fn)` function bound
   * to the controller's surface. Re-evaluates on tracked-dep change; same
   * caveat as `signal` — no lifecycle binding, just discoverability.
   */
  computed<T>(fn: () => T): Computed<T>

  field<T>(
    initial: T,
    validators?: ReadonlyArray<Validator<T>>,
    options?: { validateOn?: 'change' | 'blur' | 'submit' },
  ): Field<T>

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

  /**
   * Like `child(...)` but additionally returns a handle that lets the parent
   * control the attached sub-tree's lifecycle independently — `dispose()`
   * tears it down early, and `suspend()` / `resume()` freeze and thaw it.
   * The child is still disposed automatically when the parent disposes;
   * `dispose()` / `suspend()` / `resume()` are idempotent.
   *
   * `<KeepAlive controller={…}>` in `@kontsedal/olas-react` consumes the
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
   * Ephemeral child controller bound to either (a) the explicit `dispose()`
   * call returned in the tuple, or (b) the parent's disposal — whichever
   * comes first. Same lifecycle semantics as `ctx.attach` minus suspend /
   * resume (sessions are short-lived, not pause-able). Returns a `[api,
   * dispose]` tuple so the api shape is exactly the controller's return
   * type, with no wrapper to unpack.
   *
   * Use cases: modal forms, inline edit sessions, wizards, command palette.
   * SPEC §11.1.
   */
  session<Props, Api>(
    def: ControllerDef<Props, Api>,
    props: Props,
    options?: { deps?: Partial<TDeps> },
  ): readonly [api: Api, dispose: () => void]

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
   * via `use(child.api)` in your view layer.
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

  on<T>(emitter: Emitter<T>, handler: (value: T) => void): void

  // scopes — typed cross-tree data (§10.3)
  provide<T>(scope: Scope<T>, value: T): void
  inject<T>(scope: Scope<T>): T

  onDispose(fn: () => void): void
  onSuspend(fn: () => void): void
  onResume(fn: () => void): void

  readonly deps: TDeps
}

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
  /** Default for queries that don't set `refetchOnWindowFocus` on their spec (§5.9). */
  refetchOnWindowFocus?: boolean
  /** Default for queries that don't set `refetchOnReconnect` on their spec (§5.9). */
  refetchOnReconnect?: boolean
  /**
   * `QueryClientPlugin`s — cross-tab sync, server-push patches, etc.
   * Installed when the root's `QueryClient` is constructed; disposed when
   * the root disposes. SPEC §13.2.
   */
  plugins?: QueryClientPlugin[]
  /**
   * Pre-seed scopes on the root controller before its factory runs. Useful
   * for cross-cutting values an adapter wants to provide once (route
   * params from a router bridge, theme tokens, etc.) without forcing the
   * user's root controller to call `ctx.provide(...)`.
   *
   * Bindings are flat `[scope, value]` tuples; later bindings for the
   * same scope override earlier ones. `ctx.inject` from any descendant
   * resolves these via the normal scope chain walk. SPEC §10.3.
   */
  scopes?: ReadonlyArray<readonly [Scope<unknown>, unknown]>
}

/**
 * The root's public surface: the controller's `Api` plus lifecycle controls
 * (`dispose`, `suspend`, `resume`), SSR (`dehydrate`, `waitForIdle`), and
 * devtools (`__debug`). Spec §20.8.
 */
export type Root<Api> = Api & {
  dispose(): void
  suspend(options?: { maxIdle?: number }): void
  resume(): void
  dehydrate(): DehydratedState
  waitForIdle(): Promise<void>
  /**
   * Apply a single dehydrated query entry to this root's cache. Idempotent
   * across pre-bind / post-bind: if a `ClientEntry` for `queryId + keyArgs`
   * already exists, the data is written through and supersedes any inflight
   * fetch; otherwise it's buffered for the next `bindEntry`.
   *
   * Designed for streaming SSR — each `<Suspense>` boundary that resolves
   * on the server can push its entry into the live client root as the
   * bootstrap script executes. Also useful for `localStorage` warm-starts
   * and similar "I have fresh data from elsewhere, inject it" patterns.
   */
  applyDehydratedEntry(
    queryId: string,
    keyArgs: readonly unknown[],
    data: unknown,
    lastUpdatedAt: number,
  ): void
  readonly __debug: DebugBus
}
