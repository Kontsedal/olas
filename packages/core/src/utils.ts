/**
 * True iff `err` is an AbortError. Used to filter superseded latest-wins
 * mutations and aborted fetches from genuine failures.
 *
 * Spec: §20.12 — checks `err instanceof DOMException && err.name === 'AbortError'`.
 * Node 17+ exposes a global DOMException, so this works server-side too.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'AbortError'
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
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
