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
