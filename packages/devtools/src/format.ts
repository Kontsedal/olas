/**
 * Render a payload (props, vars, result, etc.) as a single-line string for
 * the panel. Cuts at `maxLen` so a giant blob doesn't blow up the layout.
 */
export function formatPayload(value: unknown, maxLen = 200): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'function') return '[fn]'
  let s: string
  try {
    s = JSON.stringify(value, replaceUnserializable)
  } catch {
    s = String(value)
  }
  if (s === undefined) s = String(value)
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}

function replaceUnserializable(_key: string, value: unknown): unknown {
  if (typeof value === 'function') return '[fn]'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return { name: value.name, message: value.message }
  return value
}

/** Render an HH:MM:SS.mmm timestamp from epoch ms. */
export function formatTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** Render a controller path / query key as a compact string. */
export function formatPath(path: readonly unknown[]): string {
  if (path.length === 0) return '∅'
  return path.map((p) => String(p)).join(' › ')
}
