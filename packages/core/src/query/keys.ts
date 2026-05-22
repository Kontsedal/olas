/**
 * Stable string hash of a key tuple. Two equal-by-content args produce the
 * same string regardless of property iteration order. Handles primitives,
 * arrays, plain objects, Date, BigInt, NaN, ±Infinity.
 *
 * Functions and symbols throw — keys must be serializable so distinct
 * subscribers can share entries.
 */
export function stableHash(args: readonly unknown[]): string {
  return JSON.stringify(args, replacer)
}

const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'function') {
    throw new Error('[olas] query keys cannot contain functions')
  }
  if (typeof value === 'symbol') {
    throw new Error('[olas] query keys cannot contain symbols')
  }
  if (typeof value === 'bigint') {
    // JSON has no bigint; serialize as a tagged string so `1n` and `'1'`
    // don't collide. The tag survives round-trips for debugging.
    return { __bigint: value.toString() }
  }
  if (typeof value === 'number') {
    // `JSON.stringify(NaN)` → `'null'` and likewise for Infinity, which
    // would collide with a literal `null` key. Tag them explicitly.
    if (Number.isNaN(value)) return '__nan__'
    if (value === Number.POSITIVE_INFINITY) return '__+inf__'
    if (value === Number.NEGATIVE_INFINITY) return '__-inf__'
    return value
  }
  if (value === undefined) return '__undefined__'
  if (value instanceof Date) return { __date: value.toISOString() }
  if (value instanceof Map || value instanceof Set) {
    throw new Error('[olas] query keys cannot contain Map/Set — use arrays/objects')
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Reject class instances (proto !== Object.prototype): two `new MyKey(1)`
    // calls would serialize identically to `{}` and collide. Plain objects
    // pass through with sorted keys.
    const proto = Object.getPrototypeOf(value)
    if (proto !== null && proto !== Object.prototype) {
      throw new Error(
        `[olas] query keys cannot contain class instances (got ${proto.constructor?.name ?? 'unknown'}) — pass plain object/array data`,
      )
    }
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}
