/**
 * `QueryClientPlugin` — a slot for layered cache concerns (cross-tab sync,
 * server-push patches, persistence-like layers) that need to observe
 * `setData` / `invalidate` / `gc` and apply remote writes back into the
 * cache without re-triggering their own outbound side-effects.
 *
 * Plugins are installed via `RootOptions.plugins[]`; lifecycle is bound to
 * the root's `QueryClient` (`init` is called once after construction;
 * `dispose` is called from `QueryClient.dispose`).
 *
 * SPEC §13.2.
 */

/**
 * Surface the plugin gets at `init` time. Used to push remote-originated
 * cache writes through the normal `setData`/`invalidate` paths without
 * triggering the plugin's own outbound hooks for those writes (the inbound
 * writes are marked `isRemote: true` and rebroadcast must be skipped).
 *
 * `subscribedKeys(queryId)` walks the per-root entry registry for the
 * matching query and returns every bound entry's `keyArgs`. Cross-tab
 * plugins use this to scope outbound traffic (e.g. only echo invalidations
 * for queries the local tab actually has entries for).
 */
export type QueryClientPluginApi = {
  /**
   * Apply a remote snapshot. The plugin's own `onSetData` IS fired for the
   * resulting cache write, but the event carries `isRemote: true` — plugins
   * MUST skip rebroadcast in that case.
   */
  applyRemoteSetData(queryId: string, keyArgs: readonly unknown[], data: unknown): void
  applyRemoteInvalidate(queryId: string, keyArgs: readonly unknown[]): void
  /**
   * Apply a local-originated `setData` to the entry identified by
   * `(queryId, keyArgs)`. The resulting plugin events fire with
   * `isRemote: false` and `source: 'set'` — cross-tab plugins WILL
   * rebroadcast (the write is treated as if a controller called
   * `client.setData(...)` directly).
   *
   * Drops silently when the queryId is unknown, the registered query is
   * infinite, or no local entry exists for that key. The `updater`
   * receives the previous data (typed as `unknown` because plugins are
   * type-erased) and returns the next.
   *
   * Use case: entity-normalization plugins that want to backpropagate an
   * `entity.update(...)` patch into every query holding that entity.
   * Mutations / optimistic updates already go through the public
   * `client.setData` and don't need this API.
   */
  setEntryData(
    queryId: string,
    keyArgs: readonly unknown[],
    updater: (prev: unknown) => unknown,
  ): void
  /**
   * Snapshot of currently bound entry keys for a query (by `queryId`). Empty
   * array when the query isn't registered, has no client entries, or the
   * `queryId` doesn't match any registered query.
   *
   * @example
   * ```ts
   * // Plugin sees an incoming invalidate; only echo it outward if any local
   * // controller is actually subscribed to that key — otherwise the message
   * // is unilateral noise.
   * const plugin: QueryClientPlugin = {
   *   init(api) { this.api = api },
   *   onInvalidate(ev) {
   *     if (ev.isRemote) return
   *     const subscribed = this.api.subscribedKeys(ev.queryId)
   *     if (subscribed.length === 0) return // no local subscribers → don't send
   *     transport.send({ type: 'invalidate', queryId: ev.queryId, keyArgs: ev.keyArgs })
   *   },
   * }
   * ```
   */
  subscribedKeys(queryId: string): readonly (readonly unknown[])[]
}

export type SetDataEvent = {
  queryId: string
  keyArgs: readonly unknown[]
  data: unknown
  /**
   * `'data'` for regular queries, `'infinite'` for paginated queries.
   * Cross-tab plugins skip `'infinite'` in v1 — page-array payloads are
   * too heavy to be a safe default.
   */
  kind: 'data' | 'infinite'
  /**
   * True iff this write originated from `applyRemoteSetData`. Plugins MUST
   * skip rebroadcast in that case — otherwise the message would echo back.
   */
  isRemote: boolean
  /**
   * Origin of the write. `'set'` covers explicit `client.setData` (mutations,
   * optimistic updates, plugin-initiated patches). `'fetch'` fires when the
   * query fetcher resolved successfully and wrote the result into the entry
   * — emitted after the data signal is settled. `'remote'` is the
   * `applyRemoteSetData` path (cross-tab / server-push); equivalent to
   * `isRemote === true`.
   *
   * Layered plugins use this to decide whether to react: cross-tab broadcasts
   * only on `'set'`, an entity-normalization plugin observes all sources.
   */
  source: 'set' | 'fetch' | 'remote'
}

export type InvalidateEvent = {
  queryId: string
  keyArgs: readonly unknown[]
  kind: 'data' | 'infinite'
  isRemote: boolean
}

export type GcEvent = {
  queryId: string
  keyArgs: readonly unknown[]
  kind: 'data' | 'infinite'
}

/**
 * Emitted when a persistable mutation (`spec.persist === true`) starts
 * executing — before the user's `mutate` is invoked. Plugins use this to
 * persist the variables to durable storage; if the page reloads mid-run,
 * the queue replays from these entries.
 *
 * `runId` is unique per execution (a single `mutation.run(...)` call OR a
 * replay attempt). `attempt` counts retry passes within a single runId.
 */
export type MutationEnqueueEvent = {
  mutationId: string
  runId: string
  variables: unknown
  attempt: number
}

/**
 * Emitted after a persistable mutation settles. Plugins use this to drop
 * the run from the durable queue (on `'success'` or `'error'` after retries
 * exhaust), or to leave it pending (on `'cancelled'` — e.g. parent dispose
 * mid-flight).
 */
export type MutationSettleEvent = {
  mutationId: string
  runId: string
  outcome: 'success' | 'error' | 'cancelled'
  /** Only present on `'error'` — the final thrown value after retries. */
  error?: unknown
}

/**
 * Plugin contract. Every hook is optional. Hooks are wrapped in try/catch
 * by `QueryClient`; thrown exceptions are routed through the root's
 * `onError` handler with `kind: 'plugin'`.
 */
export type QueryClientPlugin = {
  /**
   * Optional human-readable identifier surfaced in `ErrorContext.pluginName`
   * when this plugin's callback throws. Without it, `pluginName` is left
   * `undefined`. Recommended for shipped plugins so Sentry/OTel adapters
   * can attribute errors back to the right package.
   */
  readonly name?: string
  /**
   * Called once after the `QueryClient` is constructed. Use it to wire up
   * transport listeners and capture the `QueryClientPluginApi`. SPEC §13.2.
   *
   * Persistable-mutation replay typically happens HERE — module-scope
   * `defineMutation(...)` calls have already registered their handlers by
   * the time `createRoot(...)` runs, so `init` can walk durable storage
   * and re-invoke registered mutates for any pending entries.
   */
  init?(api: QueryClientPluginApi): void
  onSetData?(event: SetDataEvent): void
  onInvalidate?(event: InvalidateEvent): void
  onGc?(event: GcEvent): void
  /**
   * Fired when a persistable mutation (`spec.persist === true`) starts
   * executing. SPEC §13.3.
   */
  onMutationEnqueue?(event: MutationEnqueueEvent): void
  /** Fired after a persistable mutation settles. SPEC §13.3. */
  onMutationSettle?(event: MutationSettleEvent): void
  /** Called from `QueryClient.dispose`. Tear down transports / listeners here. */
  dispose?(): void
}

/**
 * Internal helper — fetch the `queryId` from a query's spec without
 * peeking into private types. Returns `undefined` for queries that didn't
 * declare a `queryId`; plugin events are then skipped (a plugin can't route
 * by name without one).
 */
export function readQueryId(query: { readonly __spec: { queryId?: string } }): string | undefined {
  return query.__spec.queryId
}

/**
 * Shape of values stored in the `queryId → Query` registry. Either a
 * regular `Query` or an `InfiniteQuery`, both branded by `__olas`.
 */
export type RegisteredQuery = {
  readonly __olas: 'query' | 'infiniteQuery'
  readonly __spec: { queryId?: string; crossTab?: boolean }
}

const queryRegistry = new Map<string, RegisteredQuery>()

/**
 * Register a query by its `queryId`. Internal — called from `defineQuery` /
 * `defineInfiniteQuery`. Replaces any previous registration with the same
 * id (matches Olas's "full root rebuild" HMR story; a mid-flight remote
 * message routed against the old `Query` simply misses).
 */
export function registerQueryById(queryId: string, query: RegisteredQuery): void {
  queryRegistry.set(queryId, query)
}

/**
 * Look up a query by its declared `queryId`. Returns `undefined` when no
 * query with that id has been defined yet (e.g. the module isn't imported
 * in the receiving tab).
 */
export function lookupRegisteredQuery(queryId: string): RegisteredQuery | undefined {
  return queryRegistry.get(queryId)
}

/**
 * Test-only — drop a registered entry. Lets tests defining the same
 * `queryId` across cases avoid bleed. Not exported from `@kontsedal/olas-core`.
 */
export function _unregisterQueryById(queryId: string): void {
  queryRegistry.delete(queryId)
}

// ────────────────────────────────────────────────────────────────────────────
// Mutation registry — parallel to query registry. Persistable mutations
// (`spec.persist === true`) register themselves at module-import time via
// `defineMutation(...)` so the mutation-queue plugin can replay pending
// runs at `init` time, BEFORE controllers reconstruct.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shape stored in the `mutationId → handler` registry. Only the `mutate`
 * function and the id are needed for replay — lifecycle hooks like
 * `onSuccess` / `onError` are per-controller and can't be safely replayed
 * across page reloads (the controller doesn't exist yet).
 */
export type RegisteredMutation = {
  readonly mutationId: string
  /**
   * Replay-safe `mutate`. Matches `MutationSpec.mutate` 1:1 — receives the
   * variables and an `AbortSignal`. The mutation-queue plugin invokes this
   * directly on replay, so the implementation MUST NOT close over
   * controller-instance state. Module-level deps (a shared `api` client,
   * etc.) are fine.
   */
  readonly mutate: (vars: unknown, signal: AbortSignal) => Promise<unknown>
}

const mutationRegistry = new Map<string, RegisteredMutation>()

/** Register a mutation by its `mutationId`. Internal — called from `defineMutation`. */
export function registerMutationById(mutationId: string, entry: RegisteredMutation): void {
  mutationRegistry.set(mutationId, entry)
}

/**
 * Look up a registered mutation by id. Returns `undefined` when no
 * mutation with that id has been defined — typical when a queue entry
 * references a mutation whose module hasn't been imported (e.g. a
 * code-split route boundary). The plugin should leave such entries in
 * place and retry once the module loads.
 */
export function lookupRegisteredMutation(mutationId: string): RegisteredMutation | undefined {
  return mutationRegistry.get(mutationId)
}

/** Test-only — drop a registered mutation. Not exported from the package. */
export function _unregisterMutationById(mutationId: string): void {
  mutationRegistry.delete(mutationId)
}
