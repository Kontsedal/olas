// Signals

// Controller container
export type {
  AmbientDeps,
  Collection,
  CollectionFactoryApi,
  CollectionFactoryOptions,
  CollectionFactoryResult,
  CollectionHomogeneousOptions,
  ControllerDef,
  CtrlApi,
  CtrlProps,
  Ctx,
  Field,
  LazyChild,
  Root,
  RootOptions,
} from './controller'
export { createRoot, defineController } from './controller'
// Errors & devtools
export type { DebugBus, DebugCacheEntry, DebugEvent } from './devtools'

// Emitter
export type { Emitter, EmitterErrorReporter } from './emitter'
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
// Key hashing — exported so plugins (entities, etc.) that need a stable
// per-`keyArgs` index key reuse the canonical implementation instead of
// rolling their own ad-hoc JSON.stringify (which mishandles Date, key
// ordering, and `undefined`).
export { stableHash } from './query/keys'
export type {
  Mutation,
  MutationConcurrency,
  MutationSpec,
} from './query/mutation'
// Query-client plugins (§13.2)
export type {
  GcEvent,
  InvalidateEvent,
  QueryClientPlugin,
  QueryClientPluginApi,
  RegisteredQuery,
  SetDataEvent,
} from './query/plugin'
export { lookupRegisteredQuery } from './query/plugin'
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
// Selection — multi-select with shift/meta-click semantics (§17.5)
export type { Selection } from './selection'
export { selection } from './selection'
export type { Computed, ReadSignal, Signal } from './signals'
export { batch, computed, effect, signal, untracked } from './signals'
// Timing
export { debounced, throttled } from './timing'

// Utilities
export { isAbortError } from './utils'
