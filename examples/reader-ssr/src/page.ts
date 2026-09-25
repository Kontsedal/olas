// Splice the rendered app and its state into the HTML template. Kept apart
// from `server.mjs` so a test can reach it.

import { type DehydratedState, serializeForScript } from '@kontsedal/olas-core'

const STATE_SLOT = /\/\*--olas-state--\*\/null\/\*--olas-state--\*\//

/**
 * Both replacements are functions: a string replacement expands `$'`, `$&`
 * and `$1` patterns, so text in the rendered HTML or the state could paste
 * parts of the template back in. The state goes in through
 * `serializeForScript`, so data containing `</script>` cannot end the tag.
 */
export function renderPage(template: string, html: string, state: DehydratedState): string {
  return template
    .replace('<!--app-html-->', () => html)
    .replace(STATE_SLOT, () => serializeForScript(state))
}
