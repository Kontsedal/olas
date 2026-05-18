import type { DevtoolsEmitter } from '../devtools'
import { type Emitter, createEmitter } from '../emitter'
import { type ErrorHandler, dispatchError } from '../errors'
import { createField } from '../forms/field'
import { createFieldArray, createForm } from '../forms/form'
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
import { type LocalCacheOptions, createLocalCache } from '../query/local'
import { type Mutation, type MutationSpec, createMutation } from '../query/mutation'
import type { LocalCache, Query } from '../query/types'
import { createInfiniteUse, createUse } from '../query/use'
import { effect as standaloneEffect } from '../signals'
import { getFactory } from './define'
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
    this.rootShared.devtools.emit({
      type: 'controller:constructed',
      path: this.path,
      props: props as unknown,
    })
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
    const wasSuspended = this.state === 'suspended'
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

    this.rootShared.devtools.emit({ type: 'controller:disposed', path: this.path })
    // Silence "unused" — `wasSuspended` may inform future logic; intentionally a no-op for now.
    void wasSuspended
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

    this.rootShared.devtools.emit({ type: 'controller:suspended', path: this.path })
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

    this.rootShared.devtools.emit({ type: 'controller:resumed', path: this.path })
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
        entry.dispose = standaloneEffect(wrapped)
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
          const { subscription, dispose: d } = createInfiniteUse(
            self.rootShared.queryClient,
            query as InfiniteQuery<unknown[], unknown, unknown>,
            keyOrOptions,
          )
          self.entries.push({ kind: 'cleanup', dispose: d })
          return subscription
        }
        const { subscription, dispose: d } = createUse(
          self.rootShared.queryClient,
          query as Query<unknown[], unknown>,
          keyOrOptions,
        )
        self.entries.push({ kind: 'cleanup', dispose: d })
        return subscription
      },

      mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R> {
        const m = createMutation<V, R>(
          spec,
          self.rootShared.onError,
          self.path,
          self.rootShared.queryClient.mutationsInflight$,
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
        const f = createField(initial, validators)
        self.entries.push({ kind: 'cleanup', dispose: () => f.dispose() })
        return f
      },

      form<S extends FormSchema>(schema: S, options?: FormOptions<S>): Form<S> {
        const f = createForm(schema, options)
        self.entries.push({ kind: 'cleanup', dispose: () => f.dispose() })
        return f
      },

      fieldArray<I extends Field<any> | Form<any>>(
        itemFactory: (initial?: ItemInitial<I>) => I,
        options?: FieldArrayOptions<I>,
      ): FieldArray<I> {
        const fa = createFieldArray<I>(itemFactory, options)
        self.entries.push({ kind: 'cleanup', dispose: () => fa.dispose() })
        return fa
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
        const segment = self.makeChildSegment(getFactory(def))
        const override = options?.deps
        const childDeps = override !== undefined ? { ...self.deps, ...override } : self.deps
        const childInstance = new ControllerInstance(self, self.rootShared, segment, childDeps)
        // child.construct() rolls back its own partial state on throw; we let
        // the throw propagate so the parent's rollback handles cleanup.
        const api = childInstance.construct(getFactory(def), props)
        self.entries.push({ kind: 'child', instance: childInstance })
        return api
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
  private makeChildSegment(factory: Function): string {
    const idx = this.childCounter++
    const base = factory.name || 'anonymous'
    return `${base}[${idx}]`
  }
}
