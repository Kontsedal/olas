/**
 * Context passed to a root's `onError` handler. `kind` identifies where in
 * the controller's surface the throw originated; `controllerPath` is the
 * path from root to the controller that owned the failing code; `queryId`
 * and `key` name the cache entry for `cache` kinds. Spec §12, §20.9.
 *
 * `'plugin'` is used for exceptions raised by plugin hooks and reported
 * through `host.reportError` (`@kontsedal/olas-cross-tab` and friends); SPEC §13.
 *
 * The remaining fields are correlation hooks for telemetry adapters
 * (Sentry / OpenTelemetry breadcrumbs / Datadog RUM): `eventId` is a stable
 * per-dispatch UUID, `timestamp` is wall-clock ms, `attempt` and `cause`
 * describe a failed fetch (`cache` kinds), `pluginName` identifies the
 * throwing plugin (set only when `kind == 'plugin'`).
 */
export type ErrorContext = {
  kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'
  controllerPath: readonly string[]
  /**
   * The query's `id`, for `cache` kinds.
   */
  queryId?: string
  /**
   * The entry's key (`spec.key(...)` output), for `cache` kinds.
   */
  key?: readonly unknown[]
  eventId: string
  timestamp: number
  /**
   * For `cache` kinds: the 0-based attempt that failed last. `0` means the
   * first attempt failed and no retry ran; `2` means two retries ran first.
   */
  attempt?: number
  /**
   * For `cache` kinds, when the query's `retry` or `retryDelay` callback
   * threw: the surfaced error is the callback's throw, and `cause` is the
   * fetch error it was deciding on. Absent otherwise.
   */
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

/**
 * The errors a controller factory threw. `ControllerInstance.construct` marks
 * each one before it rethrows. The throw can surface anywhere `ctx.child` or
 * `ctx.attach` was called: inside an effect, a `ctx.on` handler or a mutation
 * hook. `dispatchError` then reports it as `kind: 'construction'` rather than
 * the kind of the callback that caught it (§12.1.6). A thrown primitive cannot
 * be marked, so it keeps the caller's kind.
 */
const constructionErrors = new WeakSet<object>()

/** Internal — record `err` as a controller-construction failure. */
export function markConstructionError(err: unknown): void {
  if ((typeof err === 'object' && err !== null) || typeof err === 'function') {
    constructionErrors.add(err)
  }
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
 * logged so an `onError` bug never tears down the tree. An error a controller
 * factory threw is reported as `kind: 'construction'` whatever kind the call
 * site passed (see `markConstructionError`).
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
    kind:
      (typeof err === 'object' || typeof err === 'function') &&
      err !== null &&
      constructionErrors.has(err)
        ? 'construction'
        : context.kind,
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
