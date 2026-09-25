/**
 * Stable, type-tagged encoding of query keys. Every value is encoded, including
 * user arrays and objects, so user data cannot impersonate an internal tag.
 * Object property order is ignored. Functions, symbols, Map/Set, class instances
 * and cycles are rejected; repeated references without cycles are supported.
 *
 * A key hashes as the value JSON round-trips it to (§5.4, §15). `dehydrate`
 * ships raw key args, and a payload reaches the client through JSON, as does a
 * persisted cache. A key JSON rewrites would otherwise hash differently after
 * the trip, and the client could never adopt its entry. So:
 *
 * - an object member holding `undefined` hashes as absent;
 * - `undefined` in an array (a hole included) hashes as `null`;
 * - a Date hashes as its ISO string, and an invalid Date as `null`;
 * - `NaN`, `Infinity` and `-Infinity` hash as `null`;
 * - `-0` hashes as `0`.
 *
 * A bigint keeps its own tag. JSON has no form for one, so an entry keyed by a
 * bigint cannot travel through JSON at all.
 */
export function stableHash(args: readonly unknown[]): string {
  return JSON.stringify(encode(args, new WeakSet<object>()))
}

const NULL = ['null']

function encode(value: unknown, ancestors: WeakSet<object>): unknown {
  // `undefined` reaches here only as an array element: object members holding
  // it are skipped below, and the args are always an array.
  if (value === null || value === undefined) return NULL
  switch (typeof value) {
    case 'string':
      return ['string', value]
    case 'boolean':
      return ['boolean', value]
    case 'bigint':
      return ['bigint', value.toString()]
    case 'number':
      if (!Number.isFinite(value)) return NULL
      // `-0` normalizes to `0`. It is distinguishable (`Object.is`), but every
      // equality a caller actually touches — `===`, Map/Set keys, a `key()`
      // that does arithmetic — treats the two as one, and `-0` arrives by
      // accident (`-x`, `x * -1`, `Math.round(-0.4)`), never on purpose.
      return ['number', String(value === 0 ? 0 : value)]
    case 'function':
      throw new Error('[olas] query keys cannot contain functions')
    case 'symbol':
      throw new Error('[olas] query keys cannot contain symbols')
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? ['string', value.toISOString()] : NULL
  }
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
    const record = value as Record<string, unknown>
    return [
      'object',
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, encode(record[key], ancestors)]),
    ]
  } finally {
    ancestors.delete(value)
  }
}
