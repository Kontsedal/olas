// Signals
export type { Computed, ReadSignal, Signal } from './signals'
export { batch, computed, effect, signal, untracked } from './signals'

// Timing
export { debounced, throttled } from './timing'

// Emitter
export type { Emitter } from './emitter'
export { createEmitter } from './emitter'

// Errors & devtools
export type { DebugEvent, DebugBus } from './devtools'
export type { ErrorContext } from './errors'

// Query primitives
export type {
  AsyncState,
  AsyncStatus,
  DehydratedEntry,
  DehydratedState,
  LocalCache,
  Query,
  QuerySpec,
  QuerySubscription,
  RetryDelay,
  RetryPolicy,
  Snapshot,
  UseOptions,
} from './query/types'
export { defineInfiniteQuery, defineQuery } from './query/define'
export type {
  InfiniteQuery,
  InfiniteQuerySpec,
  InfiniteQuerySubscription,
} from './query/infinite'
export type {
  Mutation,
  MutationConcurrency,
  MutationSpec,
} from './query/mutation'

// Forms — stdlib validators + debouncedValidator
export type { Validator } from './forms'
export { email, max, maxLength, min, minLength, pattern, required } from './forms'
export { debouncedValidator } from './forms/field'
export type {
  DeepPartial,
  FieldArray,
  FieldArrayItemErrors,
  FieldArrayOptions,
  FieldArrayValidator,
  FieldArrayValue,
  Form,
  FormErrors,
  FormOptions,
  FormSchema,
  FormValidator,
  FormValue,
  ItemInitial,
} from './forms/form-types'

// Controller container
export type {
  AmbientDeps,
  ControllerDef,
  Ctx,
  CtrlApi,
  CtrlProps,
  Field,
  Root,
  RootOptions,
} from './controller'
export { createRoot, defineController } from './controller'

// Scopes — typed cross-tree data (§10.3)
export type { Scope, ScopeOptions } from './scope'
export { defineScope } from './scope'

// Utilities
export { isAbortError } from './utils'
