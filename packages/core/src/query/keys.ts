/**
 * Stable, type-tagged encoding of query keys. Every value is encoded, including
 * user arrays and objects, so user data cannot impersonate an internal tag.
 * Object property order is ignored. Functions, symbols, class instances and
 * cycles are rejected; repeated references without cycles are supported.
 */
export function stableHash(args: readonly unknown[]): string {
  return JSON.stringify(encode(args, new WeakSet<object>()))
}

function encode(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null) return ['null']
  switch (typeof value) {
    case 'undefined':
      return ['undefined']
    case 'string':
      return ['string', value]
    case 'boolean':
      return ['boolean', value]
    case 'bigint':
      return ['bigint', value.toString()]
    case 'number':
      // `-0` normalizes to `0`. It is distinguishable (`Object.is`), but every
      // equality a caller actually touches — `===`, Map/Set keys, a `key()`
      // that does arithmetic — treats the two as one, and `-0` arrives by
      // accident (`-x`, `x * -1`, `Math.round(-0.4)`), never on purpose. A
      // split here would be a silent second cache entry and a second request.
      // It would also break SSR: `dehydrate` ships raw key args through JSON,
      // and `JSON.stringify(-0)` is `'0'`, so a `-0`-keyed entry could never
      // be re-adopted on the client (§15).
      return ['number', String(value === 0 ? 0 : value)]
    case 'function':
      throw new Error('[olas] query keys cannot contain functions')
    case 'symbol':
      throw new Error('[olas] query keys cannot contain symbols')
  }
  if (value instanceof Date) return ['date', value.toISOString()]
  if (value instanceof Map || value instanceof Set) {
    throw new Error('[olas] query keys cannot contain Map/Set; use arrays/objects')
  }
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== null && proto !== Object.prototype) {
    throw new Error(
      '[olas] query keys cannot contain class instances; pass plain object/array data',
    )
  }
  if (ancestors.has(value)) throw new Error('[olas] query keys cannot contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return ['array', Array.from(value, (item) => encode(item, ancestors))]
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, encode((value as Record<string, unknown>)[key], ancestors)]),
    ]
  } finally {
    ancestors.delete(value)
  }
}
