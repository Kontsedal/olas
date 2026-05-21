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

  return walkPlainObject(prev as Record<string, unknown>, next as Record<string, unknown>, seen)
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
): Record<string, unknown> {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  let changed = prevKeys.length !== nextKeys.length

  seen.add(prev)
  seen.add(next)
  try {
    const out: Record<string, unknown> = {}
    // Iterate `next`'s keys in order so the output preserves payload's
    // key ordering (matters for downstream `JSON.stringify` callers and
    // for predictable React reconciliation when an object is rendered).
    for (const key of nextKeys) {
      const shared = walk(prev[key], next[key], seen)
      out[key] = shared
      if (shared !== prev[key]) changed = true
      else if (!(key in prev)) changed = true
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
