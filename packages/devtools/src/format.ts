/**
 * Render a payload (props, vars, result, etc.) as a single-line string for
 * the panel. Cuts at `maxLen` so a giant blob doesn't blow up the layout.
 * Never throws: a cycle reads `[Circular]`, and a value that cannot be read
 * at all reads `[unserializable]`.
 */
export function formatPayload(value: unknown, maxLen = 200): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return '[fn]'
  let s: string | undefined
  // The ancestors of the value being replaced, so only a true cycle is marked.
  // A reference repeated in two places prints twice.
  const ancestors: unknown[] = []
  try {
    s = JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
      if (typeof v === 'function') return '[fn]'
      if (typeof v === 'bigint') return v.toString()
      if (typeof v !== 'object' || v === null) return v
      if (v instanceof Error) return { name: v.name, message: v.message }
      // `this` is the holder of `v`: drop the ancestors that are not its path.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop()
      if (ancestors.includes(v)) return '[Circular]'
      ancestors.push(v)
      return v
    })
  } catch {
    // A throwing getter, `toJSON` or proxy trap.
  }
  if (s === undefined) {
    try {
      s = String(value)
    } catch {
      s = '[unserializable]'
    }
  }
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}

/** Render an HH:MM:SS.mmm timestamp from epoch ms. */
export function formatTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * Render a controller path / query key as a compact string. An object member
 * of a key renders as JSON cut at 60 characters, so `['users', { page: 1 }]`
 * and `['users', { page: 2 }]` read differently. Never throws, so a
 * null-prototype object in a key renders too.
 */
export function formatPath(path: readonly unknown[]): string {
  if (path.length === 0) return '∅'
  return path
    .map((p) =>
      p !== null && (typeof p === 'object' || typeof p === 'function')
        ? formatPayload(p, 60)
        : String(p),
    )
    .join(' › ')
}
