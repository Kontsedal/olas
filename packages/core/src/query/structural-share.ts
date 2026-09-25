/**
 * Walk `prev` and `next` in parallel. Wherever a sub-tree in `next` is
 * structurally equal to the corresponding sub-tree in `prev`, return `prev`'s
 * reference for that sub-tree. Otherwise return `next`'s.
 *
 * Result: a value that is `===` to `prev` on every refetch where the payload
 * didn't actually change, and shares maximum ref-identity on partial changes.
 * Downstream `computed`s and React `useSyncExternalStore` snapshots stop
 * thrashing because reference equality holds where content equality holds.
 *
 * Bails (returns the `next` ref unchanged, no recursion) on:
 *   - Mismatched constructors / different `typeof` between `prev` and `next`
 *   - `Map`, `Set`, `Date`, `RegExp`, class instances (anything where the
 *     plain-object / array fast path isn't safe)
 *   - Functions, symbols, promises
 *
 * Handles cycles via a `WeakSet` of in-progress objects — a self-referential
 * payload that compares structurally identical against itself won't loop.
 *
 * A rebuilt object keeps the prototype both sides shared (`Object.prototype` or
 * `null`), and an own `__proto__` property stays an own property rather than
 * becoming the result's prototype — see `defineOwn`.
 */
export function structuralShare<T>(prev: T, next: T): T {
  // Identity short-circuit — both branches see the exact same allocation.
  if (Object.is(prev, next)) return prev
  return walk(prev, next, new WeakSet<object>()) as T
}

function walk(prev: unknown, next: unknown, seen: WeakSet<object>): unknown {
  if (Object.is(prev, next)) return prev
  if (prev === null || next === null) return next
  if (typeof prev !== 'object' || typeof next !== 'object') return next

  // Cycle guard. If either side is already on the in-flight stack, we can't
  // safely recurse — fall back to `next`'s ref. Real cyclic payloads are
  // exceedingly rare in HTTP responses; defensive bail.
  if (seen.has(prev as object) || seen.has(next as object)) return next

  // Arrays — only matched against arrays.
  if (Array.isArray(prev) && Array.isArray(next)) {
    return walkArray(prev, next, seen)
  }
  if (Array.isArray(prev) !== Array.isArray(next)) return next

  // Constructor / prototype check. Plain objects have `Object.prototype`
  // (and a Map/Set/Date/RegExp/class instance does not). We require an exact
  // prototype match on both sides AND `Object.prototype` so we never deep-
  // walk into class instances whose identity might encode hidden state.
  const prevProto = Object.getPrototypeOf(prev)
  if (prevProto !== Object.getPrototypeOf(next)) return next
  if (prevProto !== Object.prototype && prevProto !== null) return next

  return walkPlainObject(
    prev as Record<string, unknown>,
    next as Record<string, unknown>,
    seen,
    prevProto,
  )
}

/**
 * Give `out` an own property, whatever the key is called.
 *
 * `out[key] = value` is wrong for exactly one key. On an object inheriting from
 * `Object.prototype`, assigning `__proto__` hits that prototype's accessor: it
 * REPLACES the object's prototype and creates no property at all. So a payload
 * carrying an own `__proto__` — `JSON.parse('{"__proto__":{…}}')` is the one
 * thing in a fetcher's path that produces one — came back with the key missing
 * and its prototype swapped for the value. `defineProperty` writes the own,
 * enumerable, writable property that every other key gets by assignment.
 */
function defineOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true })
    return
  }
  out[key] = value
}

function walkArray(
  prev: ReadonlyArray<unknown>,
  next: ReadonlyArray<unknown>,
  seen: WeakSet<object>,
): ReadonlyArray<unknown> {
  if (prev.length !== next.length) {
    // Length changed — we can still preserve refs for matching prefixes via
    // index-aligned walking. That's the right trade-off for tables / lists:
    // appending an item keeps the head's refs stable, prepending invalidates
    // everything (which it does anyway — items shifted).
  }
  seen.add(prev)
  seen.add(next)
  try {
    const out: unknown[] = new Array(next.length)
    let changed = next.length !== prev.length
    for (let i = 0; i < next.length; i++) {
      const prevItem = i < prev.length ? prev[i] : undefined
      const shared = walk(prevItem, next[i], seen)
      out[i] = shared
      if (shared !== prev[i]) changed = true
    }
    if (!changed) return prev
    return out
  } finally {
    seen.delete(prev)
    seen.delete(next)
  }
}

function walkPlainObject(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  seen: WeakSet<object>,
  proto: object | null,
): Record<string, unknown> {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  let changed = prevKeys.length !== nextKeys.length

  seen.add(prev)
  seen.add(next)
  try {
    // Both sides share this prototype (`walk` checked), and it is either
    // `Object.prototype` or `null` — a rebuilt result keeps it rather than
    // handing a `Object.create(null)` payload back with `Object.prototype`.
    const out: Record<string, unknown> = proto === null ? Object.create(null) : {}
    // Iterate `next`'s keys in order so the output preserves payload's
    // key ordering (matters for downstream `JSON.stringify` callers and
    // for predictable React reconciliation when an object is rendered).
    for (const key of nextKeys) {
      // Own-property reads, not `prev[key]` / `key in prev`: for `__proto__`
      // (and for `toString` and the rest of `Object.prototype`) those answer
      // about the prototype chain, and a key prev only INHERITS is a key prev
      // does not have.
      const prevHas = Object.hasOwn(prev, key)
      const prevValue = prevHas ? prev[key] : undefined
      const shared = walk(prevValue, next[key], seen)
      defineOwn(out, key, shared)
      if (!prevHas || shared !== prevValue) changed = true
    }
    // Keys present in `prev` but not in `next` are dropped — that's already
    // expressed by `next.keys`. But the length-mismatch flag above catches
    // the changed shape.
    if (!changed) return prev
    return out
  } finally {
    seen.delete(prev)
    seen.delete(next)
  }
}
