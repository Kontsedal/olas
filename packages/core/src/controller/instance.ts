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
import { effect as standaloneEffect } from '../signals'
import { getFactory, getName } from './define'
import type { ControllerDef, Ctx, Field } from './types'

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
        const m = createMutation<V, R>(
          spec,
          self.rootShared.onError,
          self.path,
          self.rootShared.queryClient.mutationsInflight$,
          self.rootShared.devtools,
        )
        self.entries.push({ kind: 'cleanup', dispose: () => m.dispose() })
        return m
      },

      emitter<T>(): Emitter<T> {
        const e = createEmitter<T>()
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
