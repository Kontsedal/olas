// Structural before/after diff for the causal timeline's `cache:set-data` rows.
//
// A small, self-contained walker — deliberately NOT importing core's
// structural-share internals (the overhaul spec calls this out: the devtools
// package must not reach into core internals). Cycle-safe via the same
// ancestor-set trick as `JsonView`: only a value that is its own ancestor on
// the current path is treated as circular, so a shared reference (a DAG) is
// diffed normally, not mis-flagged.

/** One node of a structural diff tree. Rendered by `DiffView` in the panel. */
export type Diff =
  /** Both sides identical (by `Object.is` or a fully-unchanged subtree). */
  | { t: 'same'; value: unknown }
  /** Present only on the `next` side (a key/index added). */
  | { t: 'add'; value: unknown }
  /** Present only on the `prev` side (a key/index removed). */
  | { t: 'remove'; value: unknown }
  /** A leaf value changed (primitive↔primitive, or a type change). */
  | { t: 'change'; prev: unknown; next: unknown }
  /** Two plain objects compared key-by-key. `changed` iff any entry differs. */
  | { t: 'object'; changed: boolean; entries: DiffEntry[] }
  /** Two arrays compared index-by-index. `changed` iff any entry differs. */
  | { t: 'array'; changed: boolean; entries: DiffEntry[] }

export type DiffEntry = { key: string; diff: Diff }

/** Compute the structural diff between `prev` and `next`. */
export function diffValues(prev: unknown, next: unknown): Diff {
  return walk(prev, next, EMPTY, 0)
}

/**
 * Depth past which the walk stops descending and reports a leaf change. The
 * ancestor set already guards true cycles; this additionally caps a
 * legitimately deep-but-acyclic payload (a long linked list, a deep tree) so
 * an arbitrary `cache:set-data` value can't overflow the stack and crash the
 * panel — the worst failure mode for a debugger.
 */
const MAX_DIFF_DEPTH = 100

/** True iff the top-level diff represents any change at all. */
export function hasChange(diff: Diff): boolean {
  switch (diff.t) {
    case 'same':
      return false
    case 'object':
    case 'array':
      return diff.changed
    default:
      return true
  }
}

const EMPTY: ReadonlySet<object> = new Set()

function walk(prev: unknown, next: unknown, seen: ReadonlySet<object>, depth: number): Diff {
  if (Object.is(prev, next)) return { t: 'same', value: next }

  // Depth cap: bail to a leaf change rather than recurse into a
  // deep-but-acyclic structure and overflow the stack (they differ — Object.is
  // above already returned for equal values).
  if (depth >= MAX_DIFF_DEPTH) return { t: 'change', prev, next }

  // Cycle guard: a value already on the current ancestor path can't be
  // descended into again. `Object.is` above already caught identical refs, so
  // reaching here with a seen object means a true cycle — stop and treat as a
  // leaf change.
  if (isSeen(prev, seen) || isSeen(next, seen)) return { t: 'change', prev, next }

  const prevArr = Array.isArray(prev)
  const nextArr = Array.isArray(next)
  if (prevArr && nextArr) {
    const childSeen = extend(seen, prev, next)
    const len = Math.max(prev.length, next.length)
    const entries: DiffEntry[] = []
    let changed = false
    for (let i = 0; i < len; i++) {
      const inPrev = i < prev.length
      const inNext = i < next.length
      let diff: Diff
      if (inPrev && !inNext) {
        diff = { t: 'remove', value: prev[i] }
        changed = true
      } else if (!inPrev && inNext) {
        diff = { t: 'add', value: next[i] }
        changed = true
      } else {
        diff = walk(prev[i], next[i], childSeen, depth + 1)
        if (diff.t !== 'same') changed = true
      }
      entries.push({ key: String(i), diff })
    }
    // Collapse a wholly-unchanged array (different ref, identical contents) to
    // a single `same` node so the diff renderer can skip it.
    if (!changed) return { t: 'same', value: next }
    return { t: 'array', changed, entries }
  }

  if (isPlainRecord(prev) && isPlainRecord(next)) {
    const childSeen = extend(seen, prev, next)
    const entries: DiffEntry[] = []
    let changed = false
    for (const k of unionKeys(prev, next)) {
      const inPrev = Object.hasOwn(prev, k)
      const inNext = Object.hasOwn(next, k)
      let diff: Diff
      if (inPrev && !inNext) {
        diff = { t: 'remove', value: prev[k] }
        changed = true
      } else if (!inPrev && inNext) {
        diff = { t: 'add', value: next[k] }
        changed = true
      } else {
        diff = walk(prev[k], next[k], childSeen, depth + 1)
        if (diff.t !== 'same') changed = true
      }
      entries.push({ key: k, diff })
    }
    // Collapse a wholly-unchanged object (different ref, identical shape) to a
    // single `same` node so the diff renderer can skip it.
    if (!changed) return { t: 'same', value: next }
    return { t: 'object', changed, entries }
  }

  // Type mismatch, differing primitives, or an opaque built-in (Date, Map,
  // class instance, …) that we don't descend into — a leaf change.
  return { t: 'change', prev, next }
}

/**
 * Treat only plain objects (prototype `Object.prototype` or `null`) as
 * descendable records. Dates, Maps, Sets, RegExps and class instances are
 * opaque leaves — mirrors `JsonView`'s specialized-builtin handling and avoids
 * walking into objects whose meaning lives outside enumerable own keys.
 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function isSeen(v: unknown, seen: ReadonlySet<object>): boolean {
  return typeof v === 'object' && v !== null && seen.has(v)
}

/** A fresh ancestor set extended with the (object) sides being descended. */
function extend(seen: ReadonlySet<object>, a: unknown, b: unknown): ReadonlySet<object> {
  const next = new Set(seen)
  if (typeof a === 'object' && a !== null) next.add(a)
  if (typeof b === 'object' && b !== null) next.add(b)
  return next
}

/** Keys of `a` in order, then keys of `b` not already seen. */
function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = Object.keys(a)
  const seen = new Set(keys)
  for (const k of Object.keys(b)) {
    if (!seen.has(k)) {
      keys.push(k)
      seen.add(k)
    }
  }
  return keys
}
