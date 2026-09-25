import type { AmbientDeps } from '../controller/types'
import type { MutationMeta } from '../query/mutation'
import type { DehydratedState, QueryMeta, Snapshot } from '../query/types'
import type { Scope } from '../scope'

/**
 * A plugin: a named `setup` that runs once for every root the plugin is
 * installed in. The value is a definition, not an instance. Per-root state
 * lives in `setup`'s closure, so one plugin value can be shared by any
 * number of roots, including a `HydrationBoundary` that rebuilds its root.
 *
 * ```ts
 * const logger = definePlugin({
 *   name: 'logger',
 *   setup(host) {
 *     return {
 *       onWrite: (e) => console.log(e.query.id, e.source, e.key),
 *     }
 *   },
 * })
 *
 * createRoot(app, { deps, queries: queryEngine(), plugins: [logger] })
 * ```
 *
 * Spec §13.
 */
export type OlasPlugin = {
  /**
   * Unique among a root's plugins. It attributes errors (`ErrorContext.pluginName`),
   * labels devtools lanes, and is the `origin` stamped on every write the
   * plugin makes through its host.
   */
  readonly name: string
  /**
   * Called once per root, in `plugins` order, before the root controller's
   * factory runs — so a scope `provide`d here is visible to every
   * controller. A throw aborts `createRoot`; the plugins already set up are
   * disposed first, in reverse order.
   */
  setup(host: PluginHost): PluginHooks | void
}

/** What one root offers a plugin during and after `setup`. */
export type PluginHost = {
  /**
   * The root's `deps`.
   */
  readonly deps: AmbientDeps
  /**
   * Make a value available to every controller (`ctx.inject(scope)`) and to
   * `root.inject(scope)`. The way a plugin exposes a service. Only during
   * `setup`; a `RootOptions.scopes` binding for the same scope wins.
   */
  provide<T>(scope: Scope<T>, value: T): void
  /**
   * Route an error to the root's `onError` as `{ kind: 'plugin', pluginName }`.
   */
  reportError(err: unknown): void
  /**
   * Run `fn` when the plugin is disposed (after its `dispose` hook).
   */
  onDispose(fn: () => void): void
  /**
   * Count `work` as in flight until it settles, so `root.waitForIdle()`
   * waits for it — a startup restore or a replay, for example.
   */
  track(work: Promise<unknown>): void
  /**
   * Browser connectivity and focus, shared with the query engine's own triggers.
   */
  readonly network: NetworkHost
  /**
   * Query cache access, or `null` when the root has no query engine.
   */
  readonly queries: QueryHost | null
  /**
   * Run registered mutations, or `null` when the root has no query engine.
   */
  readonly mutations: MutationHost | null
  /**
   * Dev-only: publish a payload on this plugin's devtools lane. A no-op in production.
   */
  debug(payload: unknown): void
}

/** Connectivity and focus, as the query engine sees them. */
export type NetworkHost = {
  /**
   * `navigator.onLine`, or `true` where there is no navigator.
   */
  isOnline(): boolean
  /**
   * Call `fn` whenever the browser comes back online. Returns an unsubscribe.
   */
  onReconnect(fn: () => void): () => void
  /**
   * Call `fn` whenever the window regains focus or visibility. Returns an unsubscribe.
   */
  onFocus(fn: () => void): () => void
}

/** A query as a plugin sees it: its identity, kind and plugin settings. */
export type QueryRef = {
  readonly id: string
  readonly kind: 'query' | 'infinite'
  readonly meta: QueryMeta
}

/**
 * The root's query cache, addressed by query `id` and entry `key` (the output
 * of the query's `key(...)`). Writes are stamped with the calling plugin's
 * name as their `origin`.
 */
export type QueryHost = {
  /**
   * A query this root has used, by id: one it holds an entry for, or one a
   * `bindQuery` reached. `undefined` for a query this root has never touched.
   */
  get(id: string): QueryRef | undefined
  /**
   * Keys of every entry this root holds for the query.
   */
  keys(id: string): ReadonlyArray<readonly unknown[]>
  /**
   * An entry's current data, without subscribing. For an infinite query, its pages.
   */
  peek(id: string, key: readonly unknown[]): unknown
  /**
   * A canonical patch of an existing entry (spec §6.4) — no optimistic
   * snapshot, and an in-flight fetch is left alone. No-op when this root
   * holds no entry for the key.
   */
  write(
    id: string,
    key: readonly unknown[],
    updater: (prev: unknown) => unknown,
    options?: WriteOptions,
  ): void
  /**
   * Replace an existing entry's data with a value that is the whole record,
   * superseding any fetch in flight for it (spec §6.4). No-op when this root
   * holds no entry for the key.
   */
  replace(id: string, key: readonly unknown[], value: unknown, options?: WriteOptions): void
  /**
   * An optimistic write of an existing entry, as `setData` in a mutation's
   * `onMutate` (spec §6.4): a guess the plugin settles through the returned
   * `Snapshot`, with `rollback()` when it fails and `finalize()` when it
   * commits. It pushes an optimistic layer, reports `'optimistic'`, and
   * leaves the stale clock and an in-flight fetch alone (§5.9). The settle
   * reports `'rollback'` or `'commit'` as an app's does. A plugin that
   * mirrors another tab's guess uses it, so the guess stays a guess here.
   * `undefined` when this root holds no entry for the key.
   */
  setData(
    id: string,
    key: readonly unknown[],
    updater: (prev: unknown) => unknown,
    options?: WriteOptions,
  ): Snapshot | undefined
  /**
   * Mark an entry stale; it refetches now if it has subscribers, else on the
   * next subscribe (spec §5.7). Resolves when that refetch settles.
   */
  invalidate(id: string, key: readonly unknown[]): Promise<void>
  /**
   * Apply dehydrated entries, as `root.hydrate` does.
   */
  hydrate(state: DehydratedState): void
  /**
   * Serialize the cache, as `root.dehydrate` does.
   */
  dehydrate(): DehydratedState
  /**
   * The stable hash the engine keys entries by. Two keys collide exactly when their hashes do.
   */
  hashKey(key: readonly unknown[]): string
}

/** Runs mutations registered with `defineMutation`, with no controller involved. */
export type MutationHost = {
  /**
   * Whether a definition is registered under `id` — false until the module
   * calling `defineMutation({ id })` has been imported.
   */
  has(id: string): boolean
  /**
   * The definition registered under `id`, as plugins see a mutation: its id and
   * `meta`. `undefined` until the module calling `defineMutation({ id })` has
   * been imported. A plugin that replays stored runs checks the definition's
   * `meta` here, so stored data cannot pick a mutation that never opted in.
   */
  get(id: string): MutationRef | undefined
  /**
   * Run the mutation registered under `id` through the engine's runner: its
   * `retry` and `concurrency` apply, `mutate` receives the root's `deps`, the
   * run counts toward `root.waitForIdle()`, and its `onMutation` events carry
   * this plugin's name as `origin`. Rejects when nothing is registered under
   * `id` (its module has not been imported) or the run fails.
   */
  run(id: string, variables: unknown): Promise<unknown>
}

/**
 * What produced a cache write:
 *
 * - `'fetch'` — a fetcher resolved (every page batch, for an infinite query)
 * - `'hydrate'` — dehydrated data reached the entry (SSR, a warm start)
 * - `'optimistic'` — `setData`, a guess a mutation may roll back
 * - `'rollback'` — an optimistic layer was undone
 * - `'commit'` — an optimistic layer was committed as server truth: its
 *   snapshot was finalized, as a successful mutation does. It is reported once
 *   no optimistic layer on the entry is live, so `data` holds no pending guess.
 *   A commit made while another layer is live is reported by the settle that
 *   clears the last one, even when that settle is a rollback, and then in
 *   place of the `'rollback'`. `updatedAt` is when the server last answered
 *   (fetch, hydrated row or canonical write), since a commit does not restart
 *   the stale clock, or `0` when it never did.
 * - `'write'` — `write`, a canonical patch
 * - `'replace'` — `replace`, a canonical whole record
 */
export type WriteSource =
  | 'fetch'
  | 'hydrate'
  | 'optimistic'
  | 'rollback'
  | 'commit'
  | 'write'
  | 'replace'

/** A cache entry's data changed. */
export type WriteEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  /**
   * The data after the write. For an infinite query, the pages array.
   */
  readonly data: unknown
  /**
   * Epoch ms the entry's data is current as of.
   */
  readonly updatedAt: number
  readonly source: WriteSource
  /**
   * Who asked for the write: the `name` of the plugin whose host made it, the
   * `origin` passed to `bindQuery(ctx, query, { origin })`, or `undefined` for
   * the app itself and the engine's own fetches.
   */
  readonly origin: string | undefined
  /**
   * For an infinite query, the params of `data`'s pages, one per page. A
   * plugin that persists or relays infinite state needs both to restore it.
   */
  readonly pageParams?: readonly unknown[]
  /**
   * The entry's server truth after the write, as `dehydrate()` ships it: the
   * data beneath every live optimistic write, with canonical writes and
   * commits folded in, and when the server last said it (`0` when it never
   * did). With no optimistic write live, `data` is the same value. A plugin
   * that keeps server truth, such as a persister, stores this instead of
   * `data`, which holds any pending guess. `undefined` when the entry holds
   * neither data nor a server answer, such as an optimistic create into an
   * entry nothing has fetched.
   */
  readonly server?: {
    readonly data: unknown
    readonly updatedAt: number
    /**
     * For an infinite query, the params of the server pages.
     */
    readonly pageParams?: readonly unknown[]
  }
}

/** Options for `QueryHost.write`, `replace` and `setData`. */
export type WriteOptions = {
  /**
   * For an infinite query: the params of the new pages, one per page. Without
   * them, the entry's params are trimmed or padded to the new page count.
   */
  pageParams?: readonly unknown[]
}

/** A cache entry was invalidated. */
export type InvalidateEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly origin: string | undefined
}

/** A cache entry left the cache: its last subscriber went away and `gcTime` passed. */
export type RemoveEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly reason: 'gc'
}

/** An entry gained its first subscriber, or lost its last one. */
export type ActivityEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
}

/** A mutation as a plugin sees it. `id` is `undefined` for an inline spec without one. */
export type MutationRef = {
  readonly id: string | undefined
  readonly meta: MutationMeta
}

/**
 * One step of a mutation run. Every run emits `'start'` (after `onMutate`,
 * before the first `mutate` call) and then exactly one of `'success'`,
 * `'error'` (retries exhausted) or `'cancel'` (a supersede, `reset()`, or
 * the owner's disposal; `reason` says which).
 *
 * A `serial` run that has to wait behind another emits `'queued'` first, when
 * `run(...)` is called, under the `runId` it keeps. It then emits `'start'`
 * when its turn comes. A queued run that never starts still emits exactly one
 * outcome: `'cancel'` when `reset()` or the owner's disposal drops it, or
 * `'error'` when its `onMutate` throws.
 */
export type MutationEvent = {
  readonly mutation: MutationRef
  /**
   * Unique per run; shared by the run's events and its devtools timeline.
   */
  readonly runId: string
  readonly variables: unknown
  readonly phase: 'queued' | 'start' | 'success' | 'error' | 'cancel'
  /**
   * The resolved value, on `'success'`.
   */
  readonly result?: unknown
  /**
   * The final thrown value, on `'error'`.
   */
  readonly error?: unknown
  /**
   * Why the run was cancelled, on `'cancel'`. `'superseded'` means a newer
   * `latest-wins` run replaced it, and `'reset'` means `mutation.reset()`
   * dropped it. Both are the app discarding the run on purpose. `'dispose'`
   * means the controller that owned the run was disposed: the screen is
   * gone, and the write it asked for may still be wanted.
   */
  readonly reason?: 'superseded' | 'reset' | 'dispose'
  /**
   * The plugin that started the run through `host.mutations.run`, else `undefined`.
   */
  readonly origin: string | undefined
}

/** What a `wrapFetch` middleware sees about one fetch attempt. */
export type FetchContext = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  /**
   * The arguments the fetcher is called with.
   */
  readonly args: readonly unknown[]
  /**
   * For an infinite query, the page being fetched.
   */
  readonly pageParam?: unknown
  readonly signal: AbortSignal
  /**
   * 0 for the first attempt, then one more per retry.
   */
  readonly attempt: number
}

/** What a `wrapMutate` middleware sees about one `mutate` attempt. */
export type MutateContext = {
  readonly mutation: MutationRef
  readonly runId: string
  readonly variables: unknown
  readonly signal: AbortSignal
  /**
   * 0 for the first attempt, then one more per retry.
   */
  readonly attempt: number
  /**
   * The plugin that started the run through `host.mutations.run`, else `undefined`.
   */
  readonly origin: string | undefined
}

/**
 * What `setup` returns. Every hook is optional. Observation hooks are
 * synchronous and run after the change is visible to subscribers. A throw is
 * isolated to its plugin and reported to the root's `onError`. None run once
 * the root starts disposing.
 */
export type PluginHooks = {
  onWrite?(event: WriteEvent): void
  onInvalidate?(event: InvalidateEvent): void
  onRemove?(event: RemoveEvent): void
  /**
   * An entry gained its first subscriber.
   */
  onActivate?(event: ActivityEvent): void
  /**
   * An entry lost its last subscriber.
   */
  onDeactivate?(event: ActivityEvent): void
  /**
   * Every mutation run, with or without an `id`.
   */
  onMutation?(event: MutationEvent): void
  /**
   * Wrap every fetch attempt. Call `next()` to run the inner chain (the
   * fetcher, last); return its promise, transform it, retry it, or answer
   * without calling it. Plugins compose in `plugins` order, the first
   * outermost. A throw fails the attempt like a fetcher throw.
   */
  wrapFetch?(context: FetchContext, next: () => Promise<unknown>): Promise<unknown>
  /**
   * Wrap every `mutate` attempt, with the same composition rules as `wrapFetch`.
   */
  wrapMutate?(context: MutateContext, next: () => Promise<unknown>): Promise<unknown>
  /**
   * Tear down: called once, when the root disposes, in reverse `plugins` order.
   */
  dispose?(): void
}
