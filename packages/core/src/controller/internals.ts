import type { ErrorHandler } from '../errors'
import type { QueryClient } from '../query/client'
import type { Ctx } from './types'

/**
 * Key for the escape hatch that lets `ctx`-taking primitives reach controller
 * internals.
 *
 * The primitives that create lifetime-bound things — fields, forms, query
 * subscriptions, mutations — used to be methods on `Ctx`, which meant
 * `controller/instance.ts` imported the forms and query subsystems by value.
 * Every consumer therefore shipped both, whether or not a single field or
 * query existed. Moving them out needs a way for an outside module to register
 * a lifecycle entry on a controller, and this is it.
 *
 * `Symbol.for` rather than a module-local symbol, for the reason
 * `.wiki/decisions/brand-markers-not-classes.md` gives: two copies of the
 * package in one dependency graph must agree.
 */
export const CTX_INTERNALS: unique symbol = Symbol.for('olas.ctx.internals') as never

/** Lifecycle entry shapes a primitive can register. Mirrors `instance.ts`. */
export type CtxEntry =
  | { kind: 'cleanup'; dispose: () => void }
  | {
      kind: 'subscription-cache'
      dispose: () => void
      suspend: () => void
      resume: () => void
    }

/**
 * The controller surface available to `ctx`-taking primitives. Not public API
 * — the shape can change in a patch release.
 */
export type CtxInternals = {
  /** Throws if the controller is disposed. `method` names the caller. */
  assertLive(method: string): void
  /** Register teardown owned by this controller. */
  register(entry: CtxEntry): void
  /** The root's `QueryClient`, or a thrown error naming the missing engine. */
  requireClient(operation: string): QueryClient
  /** Root-wide query defaults (§5.9), readable without a query engine. */
  readonly queryDefaults: {
    staleTime?: number
    keepPreviousData?: boolean
    [key: string]: unknown
  }
  /** Controller path, for devtools and error contexts. */
  readonly path: readonly string[]
  /** Routes a primitive's error to the root handler with the right context. */
  report(err: unknown, kind: 'effect' | 'emitter'): void
  /** The root's raw error handler, for primitives that dispatch their own. */
  readonly onError: ErrorHandler | undefined
  /** Devtools bus, for field and form instrumentation. */
  readonly devtools: unknown
}

/**
 * Read the internals off a `ctx`, or explain what went wrong.
 *
 * The common failure is a hand-rolled test double standing in for a real
 * `Ctx`. Saying so beats `undefined is not an object`.
 */
export function ctxInternals(ctx: Ctx, operation: string): CtxInternals {
  const internals = (ctx as unknown as Record<symbol, CtxInternals | undefined>)[CTX_INTERNALS]
  if (internals === undefined) {
    throw new TypeError(
      `[olas] ${operation} received something that is not a controller ctx. ` +
        'Pass the `ctx` your controller factory was called with.',
    )
  }
  return internals
}
