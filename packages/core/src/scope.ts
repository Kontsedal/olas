/**
 * Typed cross-tree data slot. Provided by an ancestor via `ctx.provide(scope, value)`
 * and consumed anywhere in its subtree via `ctx.inject(scope)`. Defined at module
 * scope so the identity is stable across calls. See spec §10.3.
 */
export type Scope<T> = {
  readonly __olas: 'scope'
  /** Per-scope identity; matches across `provide` / `inject`. */
  readonly __id: symbol
  /** Optional human-readable name (used in error messages). */
  readonly name?: string
  /** Default value used when no provider exists; `undefined` if none was set. */
  readonly default?: T
  /** True iff `defineScope` was called with a `default` (even `default: undefined`). */
  readonly hasDefault: boolean
  // Phantom for inference — typed `T` is preserved through the scope's lifetime.
  readonly __t?: T
}

export type ScopeOptions<T> = {
  default?: T
  name?: string
}

/**
 * Create a scope. The returned value is the typed handle passed to
 * `ctx.provide(scope, value)` and `ctx.inject(scope)`. Identity is keyed by
 * an internal symbol so two `defineScope()` calls — even with identical
 * options — yield distinct scopes.
 */
export function defineScope<T>(options?: ScopeOptions<T>): Scope<T> {
  const hasDefault = options !== undefined && 'default' in options
  const name = options?.name
  const scope: Scope<T> = {
    __olas: 'scope',
    __id: Symbol(name ?? 'scope'),
    hasDefault,
    ...(name !== undefined ? { name } : {}),
    ...(hasDefault ? { default: options?.default as T } : {}),
  }
  return scope
}
