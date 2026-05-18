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
import type { LocalCache, Query, QuerySubscription, UseOptions } from '../query/types'
import type { ReadSignal } from '../signals/types'

/**
 * App-wide deps available on every controller's `ctx.deps`.
 *
 * Default shape carries an index signature so untyped reads compile (as
 * `unknown`). Users augment this interface in their app to add typed services:
 *
 * ```ts
 * declare module '@olas/core' {
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

export type Field<T> = ReadSignal<T> & {
  errors: ReadSignal<string[]>
  isValid: ReadSignal<boolean>
  isDirty: ReadSignal<boolean>
  touched: ReadSignal<boolean>
  isValidating: ReadSignal<boolean>
  set(value: T): void
  reset(): void
  markTouched(): void
  revalidate(): Promise<boolean>
  dispose(): void
}

export type ControllerDef<Props, Api> = {
  readonly __olas: 'controller'
  readonly __types?: { props: Props; api: Api }
}

/** Extract a controller's Props type. */
export type CtrlProps<C> = C extends ControllerDef<infer P, unknown> ? P : never

/** Extract a controller's Api type. */
export type CtrlApi<C> = C extends ControllerDef<unknown, infer A> ? A : never

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

  use<Args extends unknown[], T>(
    source: Query<Args, T>,
    keyOrOptions?: (() => Args) | UseOptions<Args>,
  ): QuerySubscription<T>
  use<Args extends unknown[], TPage, TItem>(
    source: InfiniteQuery<Args, TPage, TItem>,
    keyOrOptions?: (() => Args) | UseOptions<Args>,
  ): InfiniteQuerySubscription<TPage, TItem>

  mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R>

  emitter<T = void>(): Emitter<T>

  field<T>(initial: T, validators?: ReadonlyArray<Validator<T>>): Field<T>

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

  effect(fn: () => void | (() => void)): void

  on<T>(emitter: Emitter<T>, handler: (value: T) => void): void

  onDispose(fn: () => void): void
  onSuspend(fn: () => void): void
  onResume(fn: () => void): void

  readonly deps: TDeps
}

import type { DebugBus } from '../devtools'
import type { DehydratedState } from '../query/types'

export type RootOptions<TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  hydrate?: DehydratedState
}

export type Root<Api> = Api & {
  dispose(): void
  suspend(options?: { maxIdle?: number }): void
  resume(): void
  dehydrate(): DehydratedState
  waitForIdle(): Promise<void>
  readonly __debug: DebugBus
}
