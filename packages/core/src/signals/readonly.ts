import type { ReadSignal } from './types'

/**
 * Project a Signal (or any object with a reactive `value` + `peek` + `subscribe`)
 * as a `ReadSignal`. The returned object does not expose `set` / `update` /
 * settable `value`, so it can be returned from APIs without callers mutating it.
 *
 * Internal helper — not exported from the package's public surface.
 */
export function readOnly<T>(source: ReadSignal<T>): ReadSignal<T> {
  return {
    get value() {
      return source.value
    },
    peek() {
      return source.peek()
    },
    subscribe(handler) {
      return source.subscribe(handler)
    },
  }
}
