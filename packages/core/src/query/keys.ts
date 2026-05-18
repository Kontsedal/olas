/**
 * Stable string hash of a key tuple. Two equal-by-content args produce the
 * same string regardless of property iteration order. Handles primitives,
 * arrays, plain objects, Date.
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
  if (value === undefined) return '__undefined__'
  if (value instanceof Date) return { __date: value.toISOString() }
  if (value instanceof Map || value instanceof Set) {
    throw new Error('[olas] query keys cannot contain Map/Set — use arrays/objects')
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}
