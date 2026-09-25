// Small pure helpers shared by the store, the search index and the panel.

const SEP = '\u0000'

/** A controller path as a Map key. The separator cannot occur in a real segment. */
export function pathKey(path: readonly string[]): string {
  return path.join(SEP)
}

/** The keys of every ancestor of the node whose `pathKey` is `key`, root first. */
export function ancestorKeys(key: string): string[] {
  const parts = key.split(SEP)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(SEP))
  return out
}

/**
 * Stable string key for a query-key array. The store keys its per-entry diff
 * baseline and query-id map by it, and the inspector keys its rows by it.
 * `JSON.stringify` covers the common primitive-array case; a type-tagged join
 * is the fallback for keys carrying unserializable members.
 */
/**
 * A cache entry's identity: its query id and its key. Two queries can hold
 * entries under the same key, so the key alone is not enough. A local cache
 * has no query id.
 */
export function entryKey(queryId: string | undefined, key: readonly unknown[]): string {
  return JSON.stringify([queryId ?? '', keyHash(key)])
}

export function keyHash(key: readonly unknown[]): string {
  try {
    // Distinguish `undefined` from `null` (both otherwise serialize to `null`)
    // and stringify BigInt (`JSON.stringify` throws on it), so two distinct
    // keys can't collide onto one slot.
    return JSON.stringify(key, (_k, v) => {
      if (v === undefined) return { __olasKey: 'undefined' }
      if (typeof v === 'bigint') return { __olasKey: 'bigint', v: v.toString() }
      return v
    })
  } catch {
    // Circular keys. Type-tag each member so the join can't alias e.g.
    // `['a','b']` and `['a|b']`.
    return key.map((k) => `${typeof k}:${String(k)}`).join('|')
  }
}

/** A signal-like value: what `use()` needs to read and subscribe. */
export type SignalLike = { peek(): unknown; subscribeChanges(cb: () => void): () => void }

/**
 * Duck-type a `ReadSignal` (signal, computed, field, read-only view). Core
 * exports no runtime guard, and this avoids importing internals. It matches
 * the surface `use()` reads: `peek` and `subscribeChanges`.
 */
export function isSignalLike(v: unknown): v is SignalLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { peek?: unknown }).peek === 'function' &&
    typeof (v as { subscribeChanges?: unknown }).subscribeChanges === 'function'
  )
}

/**
 * Cap on the text indexed for one value. A 5 MB cache entry would otherwise
 * cost 5 MB of lowercase string per event that carries it, and the timeline
 * holds 10,000 events. Search matches within the first `SEARCH_TEXT_CAP`
 * characters of each value.
 */
export const SEARCH_TEXT_CAP = 2000

/**
 * A value as searchable text: `key:value` tokens joined by spaces, strings
 * unquoted, cycle-safe, and cut at `cap` characters. The walk stops once the
 * cap is reached, so a huge value costs at most `cap` characters of work per
 * branch rather than a full `JSON.stringify`.
 */
export function toSearchText(value: unknown, cap: number = SEARCH_TEXT_CAP): string {
  const parts: string[] = []
  let len = 0
  const put = (s: string): void => {
    const cut = s.length > cap ? s.slice(0, cap) : s
    parts.push(cut)
    len += cut.length + 1
  }
  const ancestors: object[] = []
  const scalar = (v: unknown): string | undefined => {
    if (typeof v === 'function') return '[fn]'
    if (typeof v !== 'object' || v === null) return String(v)
    if (v instanceof Error) return `${v.name}: ${v.message}`
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString()
    return undefined
  }
  const walk = (v: unknown): void => {
    const s = scalar(v)
    if (s !== undefined) {
      put(s)
      return
    }
    const o = v as object
    if (ancestors.includes(o)) {
      put('[Circular]')
      return
    }
    ancestors.push(o)
    if (o instanceof Map) {
      for (const [k, x] of o) {
        if (len >= cap) break
        walk(k)
        walk(x)
      }
    } else if (Array.isArray(o) || o instanceof Set) {
      for (const x of o) {
        if (len >= cap) break
        walk(x)
      }
    } else {
      for (const k in o) {
        if (len >= cap) break
        if (!Object.hasOwn(o, k)) continue
        const x = (o as Record<string, unknown>)[k]
        const xs = scalar(x)
        if (xs !== undefined) put(`${k}:${xs}`)
        else {
          put(`${k}:`)
          walk(x)
        }
      }
    }
    ancestors.pop()
  }
  try {
    walk(value)
  } catch {
    // A throwing getter or proxy trap: keep the text collected so far.
  }
  const s = parts.join(' ')
  return s.length > cap ? s.slice(0, cap) : s
}
