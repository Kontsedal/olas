/**
 * Shared scaffolding for the property suites in this directory.
 *
 * Every async boundary in these tests is a `Controllable` the test settles
 * itself, and every wait is a bounded microtask drain. Nothing here touches a
 * timer, so a property run is deterministic for a given op sequence.
 */

export type Settlement<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** A promise the test resolves or rejects by hand, and can ask about. */
export type Controllable<T> = {
  readonly promise: Promise<T>
  /** How it settled, once it has; `undefined` while pending. */
  readonly settlement: Settlement<T> | undefined
  readonly settled: boolean
  /** True when the abort signal (not the test) settled it. */
  readonly settledByAbort: boolean
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * A controllable promise. With `honorsAbort`, the signal's abort rejects it
 * with an `AbortError` on the spot (a well-behaved fetcher/mutate); without,
 * it ignores the signal and stays pending until the test settles it (a
 * misbehaving one).
 */
export function controllable<T>(signal?: AbortSignal, honorsAbort = false): Controllable<T> {
  let res: (value: T) => void = () => {}
  let rej: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    res = resolve
    rej = reject
  })
  // Never an unhandled rejection: the engine attaches its own handler, and a
  // superseded promise nobody awaits any more must not fail the run.
  promise.catch(() => {})
  let settlement: Settlement<T> | undefined
  let byAbort = false
  const c: Controllable<T> = {
    promise,
    get settlement() {
      return settlement
    },
    get settled() {
      return settlement !== undefined
    },
    get settledByAbort() {
      return byAbort
    },
    resolve(value) {
      if (settlement !== undefined) return
      settlement = { ok: true, value }
      res(value)
    },
    reject(error) {
      if (settlement !== undefined) return
      settlement = { ok: false, error }
      rej(error)
    },
  }
  if (honorsAbort && signal !== undefined) {
    const onAbort = (): void => {
      if (settlement !== undefined) return
      byAbort = true
      c.reject(new DOMException('aborted by signal', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return c
}

/** Drain the microtask queue. No timers: every continuation in the engine is a promise hop. */
export async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

export type Tracked<T> = {
  state: 'pending' | 'fulfilled' | 'rejected'
  value?: T
  error?: unknown
}

/** Observe a promise's outcome without awaiting it. */
export function track<T>(promise: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { state: 'pending' }
  promise.then(
    (value) => {
      t.state = 'fulfilled'
      t.value = value
    },
    (error: unknown) => {
      t.state = 'rejected'
      t.error = error
    },
  )
  return t
}

/**
 * Race `promise` against a microtask drain. `'settled'` if it settled within
 * the drain, `'hung'` otherwise. Hang detection without a timer.
 */
export async function settlesWithin(promise: Promise<unknown>, rounds = 200): Promise<boolean> {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let i = 0; i < rounds && !done; i++) await Promise.resolve()
  return done
}

/** Pick `list[pick % list.length]`, or `undefined` for an empty list. */
export function pickFrom<T>(list: readonly T[], pick: number): T | undefined {
  if (list.length === 0) return undefined
  return list[pick % list.length]
}

/** The release gate: 1,000 runs per property. */
export const NUM_RUNS = 1000
