import { BRAND, type PHANTOM } from './brand'

/**
 * Typed cross-tree data slot. Provided by an ancestor via `ctx.provide(scope, value)`
 * and consumed anywhere in its subtree via `ctx.inject(scope)`. Defined at module
 * scope so the identity is stable across calls. See spec §10.3.
 */
export type Scope<T> = {
  readonly [BRAND]: 'scope'
  /** Optional human-readable name (used in error messages). */
  readonly name?: string
  /** Default value used when no provider exists; `undefined` if none was set. */
  readonly default?: T
  /** True iff `defineScope` was called with a `default` (even `default: undefined`). */
  readonly hasDefault: boolean
  // Phantom for inference — typed `T` is preserved through the scope's lifetime.
  readonly [PHANTOM]?: T
}

/** Options for `defineScope`. */
export type ScopeOptions<T> = {
  /**
   * What `ctx.inject` returns when no ancestor provided the scope. Without
   * one, `inject` throws.
   */
  default?: T
  /** Labels the scope in error messages. */
  name?: string
}

/**
 * Create a scope. The returned value is the typed handle passed to
 * `ctx.provide(scope, value)` and `ctx.inject(scope)`. The scope object is
 * its own identity, so two `defineScope()` calls — even with identical
 * options — yield distinct scopes.
 */
export function defineScope<T>(options?: ScopeOptions<T>): Scope<T> {
  const hasDefault = options !== undefined && 'default' in options
  const name = options?.name
  const scope: Scope<T> = {
    [BRAND]: 'scope',
    hasDefault,
    ...(name !== undefined ? { name } : {}),
    ...(hasDefault ? { default: options?.default as T } : {}),
  }
  return scope
}
