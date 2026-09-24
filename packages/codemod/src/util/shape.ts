import type { Node, Type } from 'ts-morph'

/**
 * Structural checks for the 0.8 types the type-driven transforms look for.
 * Each asks for a few members that only that type combines, so they work on
 * the declarations the project resolves, whatever file those live in. They
 * need the 0.8 packages installed: the 1.0 types lack the members that give
 * a 0.8 shape away.
 */
function has(type: Type, names: readonly string[]): boolean {
  const t = type.getNonNullableType()
  return names.every((name) => t.getProperty(name) !== undefined)
}

function shapeCheck(names: readonly string[]): (node: Node) => boolean {
  return (node) => has(node.getType(), names)
}

/** `Root<Api>`: the api with the root controls mixed in. */
export const isOldRoot = shapeCheck(['__debug', 'waitForIdle', 'applyDehydratedEntry'])

/** The `ctx` a controller factory receives (both versions). */
export const isCtx = shapeCheck(['child', 'attach', 'onDispose', 'effect', 'deps'])

/** `Form<S>`, whose `value` was a signal. */
export const isOldForm = shapeCheck(['submit', 'resetWithInitial', 'markAllTouched', 'value'])

/** `FieldArray<I>`, whose `value` was a signal. */
export const isOldFieldArray = shapeCheck(['items', 'add', 'insert', 'move', 'value'])

/** Anything a `ReadSignal` is: `value`, `peek`, `subscribe`. */
export const isSignal = shapeCheck(['value', 'peek', 'subscribe'])

/** `AsyncState<T>` with its `promise` alias. */
export const isOldAsyncState = shapeCheck(['firstValue', 'promise', 'refetch', 'isFetching'])

/** The object `useMutation` returned, with both `mutate` and `mutateAsync`. */
export const isOldUseMutation = shapeCheck(['mutate', 'mutateAsync', 'isPending'])

/** `ErrorContext`, as `onError` receives it. */
export const isErrorContext = shapeCheck(['controllerPath', 'eventId', 'timestamp', 'kind'])

/** `MutationDisposedError` with its `mutationName`. */
export const isOldDisposedError = shapeCheck(['mutationName', 'controllerPath', 'message'])

/** The `entitiesPlugin([...])` value, which was the plugin and the store at once. */
export const isOldEntitiesPlugin = shapeCheck(['upsert', 'invalidate', 'bindings', 'entries'])

/** The `mutationQueuePlugin(...)` value, which carried `replayNow`. */
export const isOldMutationQueuePlugin = shapeCheck(['replayNow', 'init'])

/** A `createRouterAdapter()` value that still carries `scopes`. */
export const isOldRouterAdapter = shapeCheck(['Bridge', 'scopes'])

/** A `defineMutation(...)` result, recognizable by its `mutationId`. */
export const isOldMutationDef = shapeCheck(['mutationId', 'mutate'])
