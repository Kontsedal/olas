/**
 * Characters written as `\uXXXX` inside the string literal: every character
 * that could end the literal, start or end a tag, open an attribute, or break
 * a line in an older engine. Only letters, digits and inert punctuation are
 * left raw, so the payload cannot form markup wherever it lands.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must be escaped
const UNSAFE = /[\u0000-\u001f\u007f\s"'`<>&=\\/\u2028\u2029]/g

const escapeChar = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`

/**
 * Serialize a value as a JavaScript expression that is safe inside an inline
 * `<script>`. Use it for server state inlined into HTML, such as a
 * `root.dehydrate()` payload:
 *
 * ```ts
 * const html = `<script>window.__OLAS_STATE__ = ${serializeForScript(root.dehydrate())}</script>`
 * ```
 *
 * The result is `JSON.parse("…")` over the JSON, with every character that
 * could end the string, the script or an attribute written as a `\uXXXX`
 * escape. Two reasons for `JSON.parse` over a plain object literal:
 * - a key named `__proto__` stays an own property, where an object literal
 *   would make its value the object's prototype;
 * - U+2028 and U+2029 cannot reach the script source raw.
 *
 * Throws what `JSON.stringify` throws, for a `BigInt` or a cycle.
 */
export function serializeForScript(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) return 'undefined'
  return `JSON.parse("${json.replace(UNSAFE, escapeChar)}")`
}
