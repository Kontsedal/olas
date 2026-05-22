/**
 * True iff `err` looks like an AbortError. Matches the standard `DOMException`
 * shape thrown by `AbortController` AND any object whose `name === 'AbortError'`
 * — that covers axios / msw / user-thrown plain Errors that signal abort.
 *
 * Spec: §20.12. Node 17+ exposes a global DOMException, so the instanceof
 * branch works server-side; the name-based branch is the portable fallback.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'AbortError'
  }
  if (err != null && typeof err === 'object' && 'name' in err) {
    return (err as { name: unknown }).name === 'AbortError'
  }
  return false
}

/**
 * `setTimeout` wrapped in a promise that rejects with `AbortError` if the
 * passed signal fires. Internal — used by the retry loops in `Entry`,
 * `InfiniteEntry`, and `Mutation` so a slow backoff never blocks a supersede.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read the caller-supplied abort reason if present, falling back to the
 * canonical `DOMException('Aborted', 'AbortError')`. `signal.reason` lets
 * users propagate context (e.g. "supersededByLatestWins") through abort
 * chains — discarding it would force every caller to wrap with custom
 * cancellation tokens.
 */
function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = (signal as { reason?: unknown }).reason
  if (reason !== undefined) return reason
  return new DOMException('Aborted', 'AbortError')
}
