// Signals

// Controller container
export type {
  AmbientDeps,
  ControllerDef,
  CtrlApi,
  CtrlProps,
  Ctx,
  Field,
  Root,
  RootOptions,
} from './controller'
export { createRoot, defineController } from './controller'
// Errors & devtools
export type { DebugBus, DebugCacheEntry, DebugEvent } from './devtools'

// Emitter
export type { Emitter } from './emitter'
export { createEmitter } from './emitter'
export type { ErrorContext } from './errors'
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
// Scopes — typed cross-tree data (§10.3)
export type { Scope, ScopeOptions } from './scope'
export { defineScope } from './scope'
export type { Computed, ReadSignal, Signal } from './signals'
export { batch, computed, effect, signal, untracked } from './signals'
// Timing
export { debounced, throttled } from './timing'

// Utilities
export { isAbortError } from './utils'
