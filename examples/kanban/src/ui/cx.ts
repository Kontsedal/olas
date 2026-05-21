export function cx(...parts: Array<string | false | null | undefined>): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    out = out === '' ? p : `${out} ${p}`
  }
  return out
}
