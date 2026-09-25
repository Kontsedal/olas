/**
 * Symbol keys for what a public value carries for core's own use. None of
 * them is exported from the package: a symbol key stays out of autocomplete,
 * `Object.keys` and `JSON.stringify`, and user code cannot reach it by name.
 *
 * Each is a `Symbol.for` key, so two copies of core in one bundle still
 * recognize each other's values.
 */

/** The kind of an Olas value: `value[BRAND] === 'query'`, `'scope'`, … */
export const BRAND: unique symbol = Symbol.for('olas.brand')

/**
 * The slot a phantom type parameter lives in, as an optional property. No
 * value carries it at runtime; it only pins a type so inference can read it
 * back (`Scope<T>`, `ControllerDef<Props, Api>`).
 */
export const PHANTOM: unique symbol = Symbol.for('olas.phantom')

/** Plumbing a public value hands to core, such as an engine's options. */
export const INTERNAL: unique symbol = Symbol.for('olas.internal')
