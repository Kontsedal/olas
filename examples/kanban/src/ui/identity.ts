/**
 * Map a hue supplied by the API onto a slot in the identity palette.
 *
 * The API stores an OKLCh hue per user, label, column and board (see
 * `api/types.ts`). A hue is a reasonable thing for data to carry — it says
 * "these two differ" without pinning a colour — but it is not a colour anyone
 * checked. Painted directly it lands wherever the API put it, half the circle
 * falls outside sRGB at any fixed lightness, and no contrast ratio can be
 * stated for it.
 *
 * So the datum chooses a SLOT and the design system chooses the colour. The
 * eight slots are declared in `examples/_shared/ui/tokens.css`, evenly spread
 * around the circle and solved to clear 3:1 against every surface in both
 * themes. Mapping is nearest-hue, so a datum keeps the colour it meant.
 *
 * The API is untouched. This is the render boundary, which is where a value
 * from outside becomes a value from the scale.
 */

/** Must match the `--identity-*` hues in `examples/_shared/ui/tokens.css`. */
const SLOT_HUES = [20, 65, 110, 155, 200, 245, 290, 335] as const

/** Shortest distance between two hues on the 360° circle. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** The identity custom property nearest to `hue`, e.g. `var(--identity-3)`. */
export function identityColor(hue: number): string {
  const normalized = ((hue % 360) + 360) % 360
  let slot = 0
  let best = Number.POSITIVE_INFINITY
  SLOT_HUES.forEach((slotHue, i) => {
    const d = hueDistance(normalized, slotHue)
    if (d < best) {
      best = d
      slot = i
    }
  })
  return `var(--identity-${slot + 1})`
}
