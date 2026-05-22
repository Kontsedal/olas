import type { DevtoolsEmitter } from '../devtools'
import { createEmitter, type Emitter } from '../emitter'
import { dispatchError, type ErrorHandler } from '../errors'
import { bindFieldDevtoolsOwner, createField } from '../forms/field'
import {
  bindTreeToDevtools,
  bindTreeValidatorErrorReporter,
  createFieldArray,
  createForm,
} from '../forms/form'
import type {
  FieldArray,
  FieldArrayOptions,
  Form,
  FormOptions,
  FormSchema,
  ItemInitial,
} from '../forms/form-types'
import type { Validator } from '../forms/types'
import type { QueryClient } from '../query/client'
import type { InfiniteQuery } from '../query/infinite'
import { createLocalCache, type LocalCacheOptions } from '../query/local'
import { createMutation, type Mutation, type MutationSpec } from '../query/mutation'
import type { LocalCache, Query } from '../query/types'
import { createInfiniteUse, createUse } from '../query/use'
import type { Scope } from '../scope'
import { computed, signal, effect as standaloneEffect } from '../signals'
import { getFactory, getName } from './define'
import type {
  Collection,
  CollectionFactoryApi,
  CollectionFactoryOptions,
  CollectionFactoryResult,
  CollectionHomogeneousOptions,
  ControllerDef,
  Ctx,
  Field,
  LazyChild,
} from './types'

export type RootShared = {
  readonly devtools: DevtoolsEmitter
  readonly onError: ErrorHandler | undefined
  readonly queryClient: QueryClient
}

type LifecycleEntry =
  | {
      kind: 'effect'
      factory: () => void | (() => void)
      dispose: (() => void) | null
    }
  | { kind: 'cleanup'; dispose: () => void }
  | {
      /**
       * Cache subscription via `ctx.use`. Suspend/resume call the
       * `suspend`/`resume` hooks so the underlying entry's `refetchInterval`
       * and event listeners pause for the duration. Spec §4.1.
       */
      kind: 'subscription-cache'
      dispose: () => void
      suspend: () => void
      resume: () => void
    }
  | { kind: 'child'; instance: ControllerInstance }
  | { kind: 'onDispose'; fn: () => void }
  | { kind: 'onSuspend'; fn: () => void }
  | { kind: 'onResume'; fn: () => void }
  | { kind: 'subscription'; unsubscribe: () => void }

type State = 'constructing' | 'active' | 'suspended' | 'disposed'

export class ControllerInstance {
  readonly path: readonly string[]
  readonly deps: Record<string, unknown>

  private state: State = 'constructing'
  private readonly entries: LifecycleEntry[] = []
  private readonly rootShared: RootShared
  private readonly parent: ControllerInstance | null
  private childCounter = 0
  /** Scope values provided on this instance, keyed by `Scope.__id`. */
  private scopes: Map<symbol, unknown> | null = null

  /**
   * Pre-seed scopes from outside the factory — used by `createRoot`'s
   * `scopes:` option so an adapter (e.g. `@kontsedal/olas-router-tanstack`)
   * can publish cross-cutting values without forcing the user to call
   * `ctx.provide(...)` in their root controller. Idempotent per scope id:
   * later calls override.
   */
  seedScopes(bindings: ReadonlyArray<readonly [{ __id: symbol }, unknown]>): void {
    if (bindings.length === 0) return
    if (this.scopes === null) this.scopes = new Map()
    for (const [scope, value] of bindings) {
      this.scopes.set(scope.__id, value)
    }
  }

  constructor(
    parent: ControllerInstance | null,
    rootShared: RootShared,
    pathSegment: string,
    deps: Record<string, unknown>,
  ) {
    this.parent = parent
    this.rootShared = rootShared
    this.path = parent ? [...parent.path, pathSegment] : [pathSegment]
    this.deps = deps
  }

  /**
   * Run the factory and produce an api. On throw, the partially-constructed
   * state is rolled back (entries disposed in reverse) and the error is rethrown.
   */
  construct<Props, Api>(factory: (ctx: Ctx, props: Props) => Api, props: Props): Api {
    const ctx = this.buildCtx()
    let api: Api
    try {
      api = factory(ctx, props)
    } catch (err) {
      this.rollbackPartialConstruction()
      throw err
    }
    this.state = 'active'
    if (__DEV__) {
      this.rootShared.devtools.emit({
        type: 'controller:constructed',
        path: this.path,
        props: props as unknown,
      })
    }
    return api
  }

  private rollbackPartialConstruction(): void {
    // Tear down what was built before the throw, in reverse order.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (!entry) continue
      try {
        this.disposeEntry(entry)
      } catch {
        // Rollback paths can't throw further.
      }
    }
    this.entries.length = 0
    this.state = 'disposed'
  }

  dispose(): void {
    if (this.state === 'disposed') return
    this.state = 'disposed'

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (!entry) continue
      try {
        this.disposeEntry(entry)
      } catch (err) {
        dispatchError(this.rootShared.onError, err, {
          kind: 'effect',
          controllerPath: this.path,
        })
      }
    }
    this.entries.length = 0
    this.scopes = null

    if (__DEV__) {
      this.rootShared.devtools.emit({ type: 'controller:disposed', path: this.path })
    }
  }

  private disposeEntry(entry: LifecycleEntry): void {
    switch (entry.kind) {
      case 'effect':
        entry.dispose?.()
        entry.dispose = null
        break
      case 'cleanup':
        entry.dispose()
        break
      case 'subscription-cache':
        entry.dispose()
        break
      case 'child':
        entry.instance.dispose()
        break
      case 'subscription':
        entry.unsubscribe()
        break
      case 'onDispose':
        entry.fn()
        break
      case 'onSuspend':
      case 'onResume':
        // No work on dispose.
        break
    }
  }

  suspend(): void {
    if (this.state !== 'active') return
    this.state = 'suspended'

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (!entry) continue
      try {
        switch (entry.kind) {
          case 'effect':
            entry.dispose?.()
            entry.dispose = null
            break
          case 'subscription-cache':
            // Pause `refetchInterval` + focus/online listeners + release the
            // entry from this subscriber. Spec §4.1.
            entry.suspend()
            break
          case 'child':
            entry.instance.suspend()
            break
          case 'onSuspend':
            entry.fn()
            break
          default:
            break
        }
      } catch (err) {
        dispatchError(this.rootShared.onError, err, {
          kind: 'effect',
          controllerPath: this.path,
        })
      }
    }

    if (__DEV__) {
      this.rootShared.devtools.emit({ type: 'controller:suspended', path: this.path })
    }
  }

  resume(): void {
    if (this.state !== 'suspended') return
    this.state = 'active'

    for (const entry of this.entries) {
      try {
        switch (entry.kind) {
          case 'effect':
            entry.dispose = standaloneEffect(entry.factory)
            break
          case 'subscription-cache':
            // Re-acquire the entry, restart `refetchInterval`, and re-check
            // staleness (a stale entry refetches on resume — spec §4.1).
            entry.resume()
            break
          case 'child':
            entry.instance.resume()
            break
          case 'onResume':
            entry.fn()
            break
          default:
            break
        }
      } catch (err) {
        dispatchError(this.rootShared.onError, err, {
          kind: 'effect',
          controllerPath: this.path,
        })
      }
    }

    if (__DEV__) {
      this.rootShared.devtools.emit({ type: 'controller:resumed', path: this.path })
    }
  }

  // --- Ctx surface --------------------------------------------------------

  private buildCtx(): Ctx {
    const self = this
    const ctx: Ctx = {
      get deps() {
        return self.deps
      },

      effect(fn) {
        if (self.isTerminal()) return
        const entry: LifecycleEntry = {
          kind: 'effect',
          factory: () => fn(),
          dispose: null,
        }
        // Wrap with error reporting so an effect throw goes through onError.
        const wrapped = (): void | (() => void) => {
          try {
            return fn()
          } catch (err) {
            dispatchError(self.rootShared.onError, err, {
              kind: 'effect',
              controllerPath: self.path,
            })
            return undefined
          }
        }
        entry.factory = wrapped
        // If we're suspended, register the entry but defer activation to
        // `resume()` — otherwise the resume loop would overwrite a live
        // `dispose` ref (the just-activated effect), leaking it.
        if (self.state !== 'suspended') {
          entry.dispose = standaloneEffect(wrapped)
        }
        self.entries.push(entry)
      },

      cache<T>(
        fetcher: (signal: AbortSignal) => Promise<T>,
        options?: LocalCacheOptions<T>,
      ): LocalCache<T> {
        const cache = createLocalCache<T>(fetcher, options)
        self.entries.push({ kind: 'cleanup', dispose: () => cache.dispose() })
        return cache
      },

      use(query: any, keyOrOptions?: any): any {
        const brand = (query as { __olas?: string }).__olas
        if (brand === 'infiniteQuery') {
          const handle = createInfiniteUse(
            self.rootShared.queryClient,
            query as InfiniteQuery<unknown[], unknown, unknown>,
            keyOrOptions,
          )
          self.entries.push({
            kind: 'subscription-cache',
            dispose: handle.dispose,
            suspend: handle.suspend,
            resume: handle.resume,
          })
          return handle.subscription
        }
        const handle = createUse(
          self.rootShared.queryClient,
          query as Query<unknown[], unknown>,
          keyOrOptions,
        )
        self.entries.push({
          kind: 'subscription-cache',
          dispose: handle.dispose,
          suspend: handle.suspend,
          resume: handle.resume,
        })
        return handle.subscription
      },

      mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R> {
        const queryClient = self.rootShared.queryClient
        const m = createMutation<V, R>(
          spec,
          self.rootShared.onError,
          self.path,
          queryClient.mutationsInflight$,
          self.rootShared.devtools,
          // Lifecycle hooks for persistable mutations — only wired when
          // `spec.persist === true`. `createMutation` validates the
          // `mutationId` requirement before construction.
          spec.persist === true
            ? {
                emitEnqueue: (ev) => queryClient.emitMutationEnqueue(ev),
                emitSettle: (ev) => queryClient.emitMutationSettle(ev),
              }
            : undefined,
        )
        self.entries.push({ kind: 'cleanup', dispose: () => m.dispose() })
        return m
      },

      emitter<T>(): Emitter<T> {
        const e = createEmitter<T>({
          // Spec §20.6: emit-time handler throws must not block sibling
          // handlers. Route to the root's onError with kind: 'emitter' and
          // this controller's path.
          onError: (err) => {
            dispatchError(self.rootShared.onError, err, {
              kind: 'emitter',
              controllerPath: self.path,
            })
          },
        })
        self.entries.push({ kind: 'cleanup', dispose: () => e.dispose() })
        return e
      },

      field<T>(initial: T, validators?: ReadonlyArray<Validator<T>>): Field<T> {
        // Pass the reporter at construct time so the FIRST validator pass
        // (which runs synchronously in the FieldImpl constructor's
        // validator-effect) is covered.
        const f = createField(initial, validators, {
          onValidatorError: (err) => {
            dispatchError(self.rootShared.onError, err, {
              kind: 'effect',
              controllerPath: self.path,
            })
          },
        })
        self.entries.push({ kind: 'cleanup', dispose: () => f.dispose() })
        // Standalone fields (not inside a form) still publish field:validated
        // events. Use the controller path with field name "(field)" — the
        // devtools panel groups by path so this is fine.
        bindFieldDevtoolsOwner(f, {
          controllerPath: self.path,
          fieldName: '(field)',
          emitter: self.rootShared.devtools,
        })
        return f
      },

      form<S extends FormSchema>(schema: S, options?: FormOptions<S>): Form<S> {
        const reporter = (err: unknown): void => {
          dispatchError(self.rootShared.onError, err, {
            kind: 'effect',
            controllerPath: self.path,
          })
        }
        const f = createForm(schema, options, { onValidatorError: reporter })
        self.entries.push({ kind: 'cleanup', dispose: () => f.dispose() })
        // Make every leaf field publish `field:validated` to the devtools bus
        // with its key path inside the form. See spec §20.9.
        const stop = bindTreeToDevtools(
          f as unknown as Form<FormSchema>,
          '',
          self.path,
          self.rootShared.devtools,
        )
        self.entries.push({ kind: 'cleanup', dispose: stop })
        // Bind the reporter onto every leaf in the tree too (the form itself
        // got it via the constructor option; nested forms/arrays inside the
        // schema didn't, since they were constructed by the caller before
        // ctx.form ran). Idempotent — leaves that already got the reporter
        // via ctx.field get the same one set again.
        bindTreeValidatorErrorReporter(f as unknown as Form<FormSchema>, reporter)
        return f
      },

      fieldArray<I extends Field<any> | Form<any>>(
        itemFactory: (initial?: ItemInitial<I>) => I,
        options?: FieldArrayOptions<I>,
      ): FieldArray<I> {
        const reporter = (err: unknown): void => {
          dispatchError(self.rootShared.onError, err, {
            kind: 'effect',
            controllerPath: self.path,
          })
        }
        const fa = createFieldArray<I>(itemFactory, options, { onValidatorError: reporter })
        self.entries.push({ kind: 'cleanup', dispose: () => fa.dispose() })
        const stop = bindTreeToDevtools(
          fa as unknown as FieldArray<Field<unknown> | Form<FormSchema>>,
          '',
          self.path,
          self.rootShared.devtools,
        )
        self.entries.push({ kind: 'cleanup', dispose: stop })
        bindTreeValidatorErrorReporter(
          fa as unknown as FieldArray<Field<unknown> | Form<FormSchema>>,
          reporter,
        )
        return fa
      },

      provide<T>(scope: Scope<T>, value: T): void {
        if (self.scopes === null) self.scopes = new Map()
        self.scopes.set(scope.__id, value)
      },

      inject<T>(scope: Scope<T>): T {
        let node: ControllerInstance | null = self
        while (node !== null) {
          const map = node.scopes
          if (map?.has(scope.__id)) {
            return map.get(scope.__id) as T
          }
          node = node.parent
        }
        if (scope.hasDefault) return scope.default as T
        const label = scope.name ?? scope.__id.description ?? 'unnamed'
        throw new Error(
          `[olas] ctx.inject(): no provider for scope '${label}' and no default. Provide it on an ancestor via ctx.provide(${label}, ...) or pass a default to defineScope.`,
        )
      },

      on<T>(emitter: Emitter<T>, handler: (value: T) => void): void {
        const wrapped = (value: T) => {
          try {
            handler(value)
          } catch (err) {
            dispatchError(self.rootShared.onError, err, {
              kind: 'emitter',
              controllerPath: self.path,
            })
          }
        }
        const unsubscribe = emitter.on(wrapped)
        self.entries.push({ kind: 'subscription', unsubscribe })
      },

      child<Props, Api>(
        def: ControllerDef<Props, Api>,
        props: Props,
        options?: { deps?: Partial<Record<string, unknown>> },
      ): Api {
        const segment = self.makeChildSegment(getFactory(def), getName(def))
        const override = options?.deps
        const childDeps = override !== undefined ? { ...self.deps, ...override } : self.deps
        const childInstance = new ControllerInstance(self, self.rootShared, segment, childDeps)
        // child.construct() rolls back its own partial state on throw; we let
        // the throw propagate so the parent's rollback handles cleanup.
        const api = childInstance.construct(getFactory(def), props)
        self.entries.push({ kind: 'child', instance: childInstance })
        return api
      },

      attach<Props, Api>(
        def: ControllerDef<Props, Api>,
        props: Props,
        options?: { deps?: Partial<Record<string, unknown>> },
      ): { api: Api; dispose: () => void; suspend: () => void; resume: () => void } {
        const segment = self.makeChildSegment(getFactory(def), getName(def))
        const override = options?.deps
        const childDeps = override !== undefined ? { ...self.deps, ...override } : self.deps
        const childInstance = new ControllerInstance(self, self.rootShared, segment, childDeps)
        const api = childInstance.construct(getFactory(def), props)
        const entry: LifecycleEntry = { kind: 'child', instance: childInstance }
        self.entries.push(entry)
        let disposed = false
        return {
          api,
          dispose: () => {
            if (disposed) return
            disposed = true
            const idx = self.entries.indexOf(entry)
            if (idx >= 0) self.entries.splice(idx, 1)
            try {
              childInstance.dispose()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
          },
          // Suspend / resume cascade through the child instance's lifecycle
          // entries (same code path as `root.suspend()`); the child's state
          // machine handles the no-op cases (suspending a disposed child,
          // resuming an active child) on its own — no need to track an
          // extra flag here.
          suspend: () => {
            if (disposed) return
            try {
              childInstance.suspend()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
          },
          resume: () => {
            if (disposed) return
            try {
              childInstance.resume()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
          },
        }
      },

      session<Props, Api>(
        def: ControllerDef<Props, Api>,
        props: Props,
        options?: { deps?: Partial<Record<string, unknown>> },
      ): readonly [Api, () => void] {
        const segment = self.makeChildSegment(getFactory(def), getName(def))
        const override = options?.deps
        const childDeps = override !== undefined ? { ...self.deps, ...override } : self.deps
        const childInstance = new ControllerInstance(self, self.rootShared, segment, childDeps)
        const api = childInstance.construct(getFactory(def), props)
        const entry: LifecycleEntry = { kind: 'child', instance: childInstance }
        self.entries.push(entry)
        let disposed = false
        const dispose = (): void => {
          if (disposed) return
          disposed = true
          const idx = self.entries.indexOf(entry)
          if (idx >= 0) self.entries.splice(idx, 1)
          try {
            childInstance.dispose()
          } catch (err) {
            dispatchError(self.rootShared.onError, err, {
              kind: 'effect',
              controllerPath: self.path,
            })
          }
        }
        return [api, dispose] as const
      },

      collection<Item, K, Props, Api, R extends CollectionFactoryResult>(
        options:
          | CollectionHomogeneousOptions<Item, K, Props, Api>
          | CollectionFactoryOptions<Item, K, R>,
      ): Collection<K, Api> | Collection<K, CollectionFactoryApi<R>> {
        type ChildInfo = {
          instance: ControllerInstance
          api: Api
          entry: LifecycleEntry
          // For factory form: the controller def used to construct this child.
          // A different def on a future render means "rebuild with new type".
          def: ControllerDef<unknown, unknown>
        }
        const childMap = new Map<K, ChildInfo>()
        const items$ = signal<ReadonlyArray<{ key: K; api: Api }>>([])
        const size$ = computed(() => items$.value.length)

        const isFactoryForm =
          (options as CollectionFactoryOptions<Item, K, R>).factory !== undefined

        const buildChild = (
          item: Item,
        ): {
          instance: ControllerInstance
          api: Api
          def: ControllerDef<unknown, unknown>
        } | null => {
          let def: ControllerDef<unknown, unknown>
          let childProps: unknown
          if (isFactoryForm) {
            const factoryOpts = options as CollectionFactoryOptions<Item, K, R>
            const result = factoryOpts.factory(item) as CollectionFactoryResult
            def = result.controller as ControllerDef<unknown, unknown>
            childProps = result.props
          } else {
            const homoOpts = options as CollectionHomogeneousOptions<Item, K, Props, Api>
            def = homoOpts.controller as unknown as ControllerDef<unknown, unknown>
            childProps = homoOpts.propsOf(item)
          }
          const segment = self.makeChildSegment(getFactory(def), getName(def))
          const childDeps =
            options.deps !== undefined ? { ...self.deps, ...options.deps } : self.deps
          const instance = new ControllerInstance(self, self.rootShared, segment, childDeps)
          try {
            const api = instance.construct(
              getFactory(def) as (ctx: Ctx, props: unknown) => Api,
              childProps,
            )
            return { instance, api, def }
          } catch (err) {
            // SPEC §12.1.6: runtime construction errors in collection items
            // route to onError; the bad item is skipped.
            dispatchError(self.rootShared.onError, err, {
              kind: 'construction',
              controllerPath: self.path,
            })
            return null
          }
        }

        const removeKey = (key: K): void => {
          const info = childMap.get(key)
          if (info === undefined) return
          childMap.delete(key)
          const idx = self.entries.indexOf(info.entry)
          if (idx >= 0) self.entries.splice(idx, 1)
          try {
            info.instance.dispose()
          } catch (err) {
            dispatchError(self.rootShared.onError, err, {
              kind: 'effect',
              controllerPath: self.path,
            })
          }
        }

        const reconcile = (): void => {
          const source = options.source.value
          const itemByKey = new Map<K, Item>()
          for (const item of source) {
            const key = options.keyOf(item)
            if (!itemByKey.has(key)) itemByKey.set(key, item)
          }

          // Drop removed keys.
          for (const key of [...childMap.keys()]) {
            if (!itemByKey.has(key)) removeKey(key)
          }

          // Add new keys + rebuild factory-form type changes.
          for (const [key, item] of itemByKey) {
            const existing = childMap.get(key)
            if (existing !== undefined) {
              if (isFactoryForm) {
                const result = (options as CollectionFactoryOptions<Item, K, R>).factory(
                  item,
                ) as CollectionFactoryResult
                if ((result.controller as unknown) !== existing.def) {
                  removeKey(key)
                  const built = buildChild(item)
                  if (built !== null) {
                    const entry: LifecycleEntry = { kind: 'child', instance: built.instance }
                    self.entries.push(entry)
                    childMap.set(key, { ...built, entry })
                  }
                }
              }
              continue
            }
            const built = buildChild(item)
            if (built !== null) {
              const entry: LifecycleEntry = { kind: 'child', instance: built.instance }
              self.entries.push(entry)
              childMap.set(key, { ...built, entry })
            }
          }

          // Project to items signal in source order, deduped, skipping failures.
          const next: Array<{ key: K; api: Api }> = []
          const seen = new Set<K>()
          for (const item of source) {
            const key = options.keyOf(item)
            if (seen.has(key)) continue
            seen.add(key)
            const info = childMap.get(key)
            if (info !== undefined) next.push({ key, api: info.api })
          }
          items$.set(next)
        }

        // Register the diff loop as an 'effect' entry so it pauses on suspend
        // and re-runs on resume — mirrors how `ctx.effect` is wired.
        const wrapped = (): void => {
          try {
            reconcile()
          } catch (err) {
            dispatchError(self.rootShared.onError, err, {
              kind: 'effect',
              controllerPath: self.path,
            })
          }
        }
        const effectEntry: LifecycleEntry = {
          kind: 'effect',
          factory: wrapped,
          dispose: null,
        }
        if (self.state !== 'suspended') {
          effectEntry.dispose = standaloneEffect(wrapped)
        }
        self.entries.push(effectEntry)

        return {
          items: items$,
          size: size$,
          get: (key: K) => childMap.get(key)?.api,
          has: (key: K) => childMap.has(key),
        }
      },

      lazyChild<Props, Api>(
        loader: () => Promise<ControllerDef<Props, Api>>,
        props: Props,
        options?: { deps?: Partial<Record<string, unknown>> },
      ): LazyChild<Api> {
        const status$ = signal<'idle' | 'loading' | 'ready' | 'error'>('idle')
        const api$ = signal<Api | undefined>(undefined)
        const error$ = signal<unknown | undefined>(undefined)

        let childInstance: ControllerInstance | null = null
        let childEntry: LifecycleEntry | null = null
        let pendingLoad: Promise<Api> | null = null
        let disposed = false

        // Parent dispose flag; the child entry (when present) is disposed
        // via the parent's normal cascade, so we don't double-tear-down.
        const flagEntry: LifecycleEntry = {
          kind: 'onDispose',
          fn: () => {
            disposed = true
          },
        }
        self.entries.push(flagEntry)

        const handleFailure = (err: unknown): void => {
          status$.set('error')
          error$.set(err)
          dispatchError(self.rootShared.onError, err, {
            kind: 'construction',
            controllerPath: self.path,
          })
        }

        const load = (): Promise<Api> => {
          if (disposed) {
            return Promise.reject(new Error('[olas] ctx.lazyChild: cannot load after dispose'))
          }
          // Cached fulfilled or in-flight loads share a promise. A previously
          // *rejected* load doesn't — we clear `pendingLoad` in the catch
          // branch so the next `load()` reattempts the loader. Sticky
          // rejections trap consumers on a transient import-failure.
          if (pendingLoad !== null) return pendingLoad
          status$.set('loading')
          const attempt = loader().then(
            (def) => {
              if (disposed) {
                throw new Error('[olas] ctx.lazyChild: disposed during load')
              }
              const segment = self.makeChildSegment(getFactory(def), getName(def))
              const childDeps =
                options?.deps !== undefined ? { ...self.deps, ...options.deps } : self.deps
              const instance = new ControllerInstance(self, self.rootShared, segment, childDeps)
              try {
                const api = instance.construct(getFactory(def), props)
                childInstance = instance
                childEntry = { kind: 'child', instance }
                self.entries.push(childEntry)
                api$.set(api)
                status$.set('ready')
                return api
              } catch (err) {
                handleFailure(err)
                throw err
              }
            },
            (err) => {
              if (disposed) throw err
              handleFailure(err)
              throw err
            },
          )
          pendingLoad = attempt
          attempt.catch(() => {
            // Allow retry: drop the cached rejection if this is still the
            // current attempt. A successful load leaves `pendingLoad` in
            // place so repeat `load()` calls return the same fulfilled api.
            if (pendingLoad === attempt) pendingLoad = null
          })
          return attempt
        }

        const dispose = (): void => {
          if (disposed) return
          disposed = true
          if (childEntry !== null && childInstance !== null) {
            const idx = self.entries.indexOf(childEntry)
            if (idx >= 0) self.entries.splice(idx, 1)
            try {
              childInstance.dispose()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
            childInstance = null
            childEntry = null
          }
          // Splice the parent-dispose flag entry too — its only job was to
          // signal disposal to an in-flight loader, and `disposed` is now
          // already true. Leaving it behind leaks one closure per ever-
          // disposed lazyChild for the parent's remaining lifetime.
          const flagIdx = self.entries.indexOf(flagEntry)
          if (flagIdx >= 0) self.entries.splice(flagIdx, 1)
        }

        return {
          status: status$,
          api: api$,
          error: error$,
          load,
          dispose,
        }
      },

      onDispose(fn) {
        self.entries.push({
          kind: 'onDispose',
          fn: () => {
            try {
              fn()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
          },
        })
      },

      onSuspend(fn) {
        self.entries.push({
          kind: 'onSuspend',
          fn: () => {
            try {
              fn()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
          },
        })
      },

      onResume(fn) {
        self.entries.push({
          kind: 'onResume',
          fn: () => {
            try {
              fn()
            } catch (err) {
              dispatchError(self.rootShared.onError, err, {
                kind: 'effect',
                controllerPath: self.path,
              })
            }
          },
        })
      },
    }
    return ctx
  }

  private isTerminal(): boolean {
    return this.state === 'disposed'
  }

  // biome-ignore lint/complexity/noBannedTypes: Function is the precise type for "any function with a .name"
  private makeChildSegment(factory: Function, explicitName: string | undefined): string {
    const idx = this.childCounter++
    const base = explicitName ?? factory.name ?? ''
    return `${base !== '' ? base : 'anonymous'}[${idx}]`
  }
}
