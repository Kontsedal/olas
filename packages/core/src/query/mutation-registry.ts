import type { AmbientDeps } from '../controller/types'
import type { MutationDefinition } from './mutation'

/**
 * Module-scope mutation definitions by `id`, filled by `defineMutation` at
 * import time. `host.mutations.run(id, …)` looks definitions up here, which
 * is how the mutation queue replays a persisted run before any controller
 * exists.
 *
 * Held on `globalThis` under a registered symbol so two copies of the package
 * in one graph share it.
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

const REGISTRY_KEY = Symbol.for('olas.mutationRegistry')

function registry(): Map<string, RegisteredMutation> {
  const store = globalThis as unknown as Record<symbol, Map<string, RegisteredMutation> | undefined>
  const existing = store[REGISTRY_KEY]
  if (existing) return existing
  const created = new Map<string, RegisteredMutation>()
  store[REGISTRY_KEY] = created
  return created
}

export function registerMutationById(id: string, entry: RegisteredMutation): void {
  registry().set(id, entry)
}

export function lookupRegisteredMutation(id: string): RegisteredMutation | undefined {
  return registry().get(id)
}

/** Test-only — drop a registration. Exported from `@kontsedal/olas-core/testing`. */
export function _unregisterMutationById(id: string): void {
  registry().delete(id)
}
