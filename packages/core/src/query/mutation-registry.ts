import type { AmbientDeps } from '../controller/types'
import type { MutationDefinition } from './mutation'

/**
 * Module-scope mutation definitions by `id`, filled by `defineMutation` at
 * import time. `host.mutations.run(id, …)` looks definitions up here, which
 * is how the mutation queue replays a persisted run before any controller
 * exists.
 *
 * Module-level. The package is ESM-only, so there is no CJS twin loading a
 * second copy of this module beside the ESM one, the hazard a `globalThis`
 * slot used to cover.
 *
 * Internal. Not exported from `@kontsedal/olas-core`.
 */
export type RegisteredMutation = {
  readonly id: string
  readonly definition: MutationDefinition<unknown, unknown>
  readonly mutate: (
    vars: unknown,
    ctx: { signal: AbortSignal; deps: AmbientDeps },
  ) => Promise<unknown>
}

const registry = new Map<string, RegisteredMutation>()

export function registerMutationById(id: string, entry: RegisteredMutation): void {
  registry.set(id, entry)
}

export function lookupRegisteredMutation(id: string): RegisteredMutation | undefined {
  return registry.get(id)
}

/** Test-only — drop a registration. Exported from `@kontsedal/olas-core/testing`. */
export function _unregisterMutationById(id: string): void {
  registry.delete(id)
}
