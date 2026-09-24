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
// CTX_INTERNALS and CtxInternals are deliberately NOT exported. The handle is
// how the ctx-taking primitives reach a controller, and its shape can change
// in a patch release — a typed public export would get bound to. Anyone who
// genuinely needs it can reach the key through `Symbol.for('olas.ctx.internals')`,
// which is the point of using a registered symbol, and takes the risk knowingly.
// Errors & devtools
export type { DebugBus, DebugCacheEntry, DebugEvent, DebugEventMeta } from './devtools'
// Emitter
export type { Emitter, EmitterErrorReporter } from './emitter'
export { createEmitter } from './emitter'
export type { ErrorContext, ErrorContextInput, ErrorHandler } from './errors'
// Forms — stdlib validators + Standard Schema adapter + debouncedValidator
export type {
  FieldTransform,
  FormIssue,
  StandardSchemaV1,
  ValidateOn,
  Validator,
  ValidatorResult,
} from './forms'
export {
  email,
  isStandardSchema,
  max,
  maxLength,
  min,
  minLength,
  mustBeTrue,
  pattern,
  required,
  validator,
} from './forms'
// Lifetime-bound primitives. These take `ctx` rather than hanging off it, so
// a controller that never builds a form or a query does not ship the forms or
// query subsystem. See `.wiki/decisions/ctx-primitives-are-free-functions.md`.
export { createField, createFieldArray, createForm } from './forms/bind'
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
export { bindQuery, createCache, createMutation, createQuery } from './query/bind'
export { defineInfiniteQuery, defineQuery } from './query/define'
export type { QueryEngine, QueryEngineOptions } from './query/engine'
export { queryEngine } from './query/engine'
export type {
  InfiniteFetchCtx,
  InfiniteQuery,
  InfiniteQueryActions,
  InfiniteQuerySpec,
  InfiniteQuerySubscription,
} from './query/infinite'
// Key hashing — exported so plugins (entities, etc.) that need a stable
// per-`keyArgs` index key reuse the canonical implementation instead of
// rolling their own ad-hoc JSON.stringify (which mishandles Date, key
// ordering, and `undefined`).
export { stableHash } from './query/keys'
export type { LocalCacheOptions } from './query/local'
export type {
  MutateCtx,
  Mutation,
  MutationConcurrency,
  MutationDef,
  MutationDefinition,
  MutationHooks,
  MutationMeta,
  MutationRun,
  MutationSpec,
} from './query/mutation'
export { defineMutation, MutationDisposedError } from './query/mutation'
// Query-client plugins (§13.2 / §13.3)
export type {
  GcEvent,
  InvalidateEvent,
  MutationEnqueueEvent,
  MutationSettleEvent,
  QueryClientPlugin,
  QueryClientPluginApi,
  RegisteredMutation,
  RegisteredQuery,
  SetDataEvent,
} from './query/plugin'
export { lookupRegisteredMutation, lookupRegisteredQuery } from './query/plugin'
// Query primitives
export type {
  AsyncState,
  AsyncStatus,
  DehydratedEntry,
  DehydratedState,
  FetchCtx,
  LocalCache,
  NetworkMode,
  Query,
  QueryActions,
  QueryDefaults,
  QueryMeta,
  QuerySpec,
  QuerySubscription,
  RefetchInterval,
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
export type { TimingSignal } from './timing'
export { debounced, throttled } from './timing'

// Utilities
export { isAbortError } from './utils'
