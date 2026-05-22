/**
 * Context passed to a root's `onError` handler. `kind` identifies where in
 * the controller's surface the throw originated; `controllerPath` is the
 * path from root to the controller that owned the failing code; `queryKey`
 * is set for `cache` kinds. Spec §12, §20.9.
 *
 * `'plugin'` is used for exceptions raised by `QueryClientPlugin` callbacks
 * (`@kontsedal/olas-cross-tab` and friends); SPEC §13.2.
 *
 * The remaining fields are correlation hooks for telemetry adapters
 * (Sentry / OpenTelemetry breadcrumbs / Datadog RUM): `eventId` is a stable
 * per-dispatch UUID, `timestamp` is wall-clock ms, `attempt` is the
 * 0-based retry attempt for cache/mutation paths, `cause` is the
 * `Error.cause`-style underlying error if the surfaced error wrapped it,
 * `pluginName` identifies the throwing plugin (set only when `kind ==
 * 'plugin'`).
 */
export type ErrorContext = {
  kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'
  controllerPath: readonly string[]
  queryKey?: readonly unknown[]
  eventId: string
  timestamp: number
  attempt?: number
  cause?: unknown
  pluginName?: string
}

/** Signature of `RootOptions.onError`. */
export type ErrorHandler = (err: unknown, context: ErrorContext) => void

/**
 * Partial context — `dispatchError` fills in `eventId` + `timestamp`. Call
 * sites pass the diagnostic fields they know about; the dispatcher stamps
 * the per-dispatch correlation data.
 */
export type ErrorContextInput = Omit<ErrorContext, 'eventId' | 'timestamp'>

const defaultHandler: ErrorHandler = (err, context) => {
  // eslint-disable-next-line no-console
  console.error('[olas]', context, err)
}

let eventCounter = 0
function nextEventId(): string {
  // 24 bits of randomness + a monotonic counter. Cheap (no crypto) and
  // unique-per-process. Adapters that need stronger guarantees can
  // re-stamp inside their own handler.
  eventCounter = (eventCounter + 1) >>> 0
  const r = ((Math.random() * 0x1000000) | 0).toString(16).padStart(6, '0')
  const c = eventCounter.toString(16).padStart(6, '0')
  return `e_${r}${c}`
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
  context: ErrorContextInput,
): void {
  const fn = handler ?? defaultHandler
  const full: ErrorContext = {
    ...context,
    eventId: nextEventId(),
    timestamp: Date.now(),
  }
  try {
    fn(err, full)
  } catch (handlerErr) {
    try {
      // eslint-disable-next-line no-console
      console.error('[olas] onError handler threw:', handlerErr)
      // eslint-disable-next-line no-console
      console.error('[olas] original error:', err, full)
    } catch {
      // Console itself failed — give up silently.
    }
  }
}
