/**
 * Context passed to a root's `onError` handler. `kind` identifies where in
 * the controller's surface the throw originated; `controllerPath` is the
 * path from root to the controller that owned the failing code; `queryKey`
 * is set for `cache` kinds. Spec §12, §20.9.
 */
export type ErrorContext = {
  kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction'
  controllerPath: readonly string[]
  queryKey?: readonly unknown[]
}

/** Signature of `RootOptions.onError`. */
export type ErrorHandler = (err: unknown, context: ErrorContext) => void

const defaultHandler: ErrorHandler = (err, context) => {
  // eslint-disable-next-line no-console
  console.error('[olas]', context, err)
}

/**
 * Dispatch an error to a user-provided handler, falling back to console.error.
 * The handler itself is wrapped — if it throws, the throw is swallowed and
 * logged so an `onError` bug never tears down the tree.
 *
 * Internal — used by the controller container and query client.
 */
export function dispatchError(
  handler: ErrorHandler | undefined,
  err: unknown,
  context: ErrorContext,
): void {
  const fn = handler ?? defaultHandler
  try {
    fn(err, context)
  } catch (handlerErr) {
    try {
      // eslint-disable-next-line no-console
      console.error('[olas] onError handler threw:', handlerErr)
      // eslint-disable-next-line no-console
      console.error('[olas] original error:', err, context)
    } catch {
      // Console itself failed — give up silently.
    }
  }
}
