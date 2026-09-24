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
  DefineControllerOptions,
  Field,
  LazyChild,
  Root,
  RootOptions,
  SuspendOptions,
} from './controller'
export { createRoot, defineController } from './controller'
// CTX_INTERNALS and CtxInternals are deliberately NOT exported. The handle is
// how the ctx-taking primitives reach a controller, and its shape can change
// in a patch release — a typed public export would get bound to. Anyone who
// genuinely needs it can reach the key through `Symbol.for('olas.ctx.internals')`,
// which is the point of using a registered symbol, and takes the risk knowingly.
// Errors & devtools
export type {
  DebugBus,
  DebugCacheEntry,
  DebugEvent,
  DebugEventBody,
  DebugEventMeta,
} from './devtools'
// Emitter
export type { Emitter, EmitterErrorReporter } from './emitter'
export { createEmitter } from './emitter'
export type { ErrorContext, ErrorHandler } from './errors'
// Forms — stdlib validators + Standard Schema adapter + debouncedValidator
export type {
  FieldTransform,
  FormIssue,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
  ValidateOn,
  Validator,
  ValidatorResult,
} from './forms'
export {
  email,
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
  FieldOptions,
  Form,
  FormErrors,
  FormOptions,
  FormSchema,
  FormValidator,
  FormValue,
  ItemInitial,
  SubmitOptions,
  SubmitResult,
} from './forms/form-types'
// Utilities
export { serializeForScript } from './html'
// Plugins (§13)
export { definePlugin } from './plugin/host'
export type {
  ActivityEvent,
  FetchContext,
  InvalidateEvent,
  MutateContext,
  MutationEvent,
  MutationHost,
  MutationRef,
  NetworkHost,
  OlasPlugin,
  PluginHooks,
  PluginHost,
  QueryHost,
  QueryRef,
  RemoveEvent,
  WriteEvent,
  WriteOptions,
  WriteSource,
} from './plugin/types'
export { bindQuery, createCache, createMutation, createQuery } from './query/bind'
export type { BindQueryOptions } from './query/client'
export { defineInfiniteQuery, defineQuery } from './query/define'
export type { QueryEngine, QueryEngineOptions } from './query/engine'
export { queryEngine } from './query/engine'
export { QueryDisabledError } from './query/errors'
export type {
  InfiniteFetchCtx,
  InfiniteQuery,
  InfiniteQueryActions,
  InfiniteQuerySpec,
  InfiniteQuerySubscription,
} from './query/infinite'
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
  QuerySelectOptions,
  QuerySpec,
  QuerySubscription,
  QuerySubscriptionOptions,
  RefetchInterval,
  RetryDelay,
  RetryPolicy,
  Snapshot,
} from './query/types'
// Scopes — typed cross-tree data (§10.3)
export type { Scope, ScopeOptions } from './scope'
export { defineScope } from './scope'
// Selection — multi-select with shift/meta-click semantics (§16.5)
export type { Selection } from './selection'
export { createSelection } from './selection'
export type { Computed, ReadSignal, Signal } from './signals'
export { batch, computed, effect, signal, untracked } from './signals'
// Timing
export type { TimingOptions, TimingSignal } from './timing'
export { debounced, throttled } from './timing'
export { isAbortError } from './utils'
