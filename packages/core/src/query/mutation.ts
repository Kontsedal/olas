import { type ErrorHandler, dispatchError } from '../errors'
import { type Signal, batch, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { isAbortError } from '../utils'
import type { RetryDelay, RetryPolicy, Snapshot } from './types'

export type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'

export type MutationSpec<V, R> = {
  mutate: (vars: V, signal: AbortSignal) => Promise<R>
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (err: unknown, vars: V, snapshot: Snapshot | undefined) => void
  onSettled?: (result: R | undefined, err: unknown | undefined, vars: V) => void
  concurrency?: MutationConcurrency
  retry?: RetryPolicy
  retryDelay?: RetryDelay
}

export type Mutation<V, R> = {
  run: (vars: V) => Promise<R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  lastVariables: ReadSignal<V | undefined>
  reset(): void
  dispose(): void
}

type RunHandle = {
  abort: AbortController
  snapshot: Snapshot | undefined
}

type SerialEntry<V, R> = {
  vars: V
  resolve: (value: R) => void
  reject: (err: unknown) => void
}

class MutationImpl<V, R> implements Mutation<V, R> {
  readonly data: Signal<R | undefined> = signal(undefined)
  readonly error: Signal<unknown | undefined> = signal(undefined)
  readonly isPending: Signal<boolean> = signal(false)
  readonly lastVariables: Signal<V | undefined> = signal(undefined)

  private inflight = new Set<RunHandle>()
  private serialQueue: Array<SerialEntry<V, R>> = []
  private serialActive = false
  private disposed = false

  constructor(
    private readonly spec: MutationSpec<V, R>,
    private readonly onError: ErrorHandler | undefined,
    private readonly controllerPath: readonly string[],
    private readonly inflightCounter?: {
      update(fn: (n: number) => number): void
    },
  ) {}

  run = (vars: V): Promise<R> => {
    if (this.disposed) {
      return Promise.reject(new Error('Mutation disposed'))
    }
    const mode = this.spec.concurrency ?? 'parallel'
    switch (mode) {
      case 'parallel':
        return this.executeRun(vars)
      case 'latest-wins':
        // Spec §6.1: rollback the superseded run's snapshot BEFORE the new
        // run's onMutate runs, so the new optimistic update doesn't stack on
        // top of the obsolete one.
        for (const handle of this.inflight) {
          handle.abort.abort()
          handle.snapshot?.rollback()
          handle.snapshot = undefined
        }
        return this.executeRun(vars)
      case 'serial':
        return this.enqueueSerial(vars)
    }
  }

  private enqueueSerial(vars: V): Promise<R> {
    if (this.serialActive) {
      return new Promise<R>((resolve, reject) => {
        this.serialQueue.push({ vars, resolve, reject })
      })
    }
    this.serialActive = true
    return this.executeRun(vars).finally(() => this.advanceSerialQueue())
  }

  private advanceSerialQueue(): void {
    const next = this.serialQueue.shift()
    if (!next) {
      this.serialActive = false
      return
    }
    this.executeRun(next.vars).then(
      (result) => {
        next.resolve(result)
        this.advanceSerialQueue()
      },
      (err) => {
        next.reject(err)
        this.advanceSerialQueue()
      },
    )
  }

  private async executeRun(vars: V): Promise<R> {
    const abort = new AbortController()
    let snapshot: Snapshot | undefined
    try {
      snapshot = this.spec.onMutate?.(vars) ?? undefined
    } catch (err) {
      dispatchError(this.onError, err, {
        kind: 'mutation',
        controllerPath: this.controllerPath,
      })
    }

    const handle: RunHandle = { abort, snapshot }
    this.inflight.add(handle)
    this.inflightCounter?.update((n) => n + 1)
    batch(() => {
      this.isPending.set(true)
      this.lastVariables.set(vars)
    })

    try {
      const result = await raceAbort(this.runWithRetry(vars, abort.signal), abort.signal)
      if (abort.signal.aborted || this.disposed) {
        snapshot?.rollback()
        throw new DOMException('Superseded', 'AbortError')
      }
      batch(() => {
        this.data.set(result)
        this.error.set(undefined)
      })
      this.safeCall(() => this.spec.onSuccess?.(result, vars), 'mutation')
      this.safeCall(() => this.spec.onSettled?.(result, undefined, vars), 'mutation')
      return result
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) {
        snapshot?.rollback()
        // Reserve `error` signal for genuine failures.
        throw err
      }
      this.error.set(err)
      this.safeCall(() => this.spec.onError?.(err, vars, snapshot), 'mutation')
      this.safeCall(() => this.spec.onSettled?.(undefined, err, vars), 'mutation')
      throw err
    } finally {
      this.inflight.delete(handle)
      this.inflightCounter?.update((n) => Math.max(0, n - 1))
      if (this.inflight.size === 0) {
        this.isPending.set(false)
      }
    }
  }

  private async runWithRetry(vars: V, signal: AbortSignal): Promise<R> {
    const retry = this.spec.retry ?? 0
    const retryDelay = this.spec.retryDelay ?? 1000
    let attempt = 0
    while (true) {
      try {
        return await this.spec.mutate(vars, signal)
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw err
        const shouldRetry = typeof retry === 'number' ? attempt < retry : retry(attempt, err)
        if (!shouldRetry) throw err
        const delay = typeof retryDelay === 'function' ? retryDelay(attempt) : retryDelay
        await abortableSleep(delay, signal)
        attempt += 1
      }
    }
  }

  private safeCall(fn: () => void, kind: 'mutation'): void {
    try {
      fn()
    } catch (err) {
      dispatchError(this.onError, err, {
        kind,
        controllerPath: this.controllerPath,
      })
    }
  }

  reset(): void {
    if (this.disposed) return
    for (const handle of this.inflight) handle.abort.abort()
    this.serialQueue.length = 0
    batch(() => {
      this.data.set(undefined)
      this.error.set(undefined)
      this.lastVariables.set(undefined)
      this.isPending.set(false)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.inflight) handle.abort.abort()
    for (const queued of this.serialQueue) {
      queued.reject(new DOMException('Disposed', 'AbortError'))
    }
    this.serialQueue.length = 0
  }
}

export function createMutation<V, R>(
  spec: MutationSpec<V, R>,
  onError: ErrorHandler | undefined,
  controllerPath: readonly string[],
  inflightCounter?: { update(fn: (n: number) => number): void },
): Mutation<V, R> {
  return new MutationImpl<V, R>(spec, onError, controllerPath, inflightCounter)
}

/**
 * Race a promise against an AbortSignal. If the signal fires before the
 * promise settles, the returned promise rejects with AbortError — regardless
 * of whether the underlying promise ever resolves. Protects against
 * misbehaving mutate fns that ignore their signal.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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
