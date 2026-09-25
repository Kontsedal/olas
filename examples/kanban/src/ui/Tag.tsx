import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import { identityColor } from './identity'

export type TagTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export type TagProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: TagTone
  /**
   * A hue from the data, for a tag that names a LABEL rather than a state. It
   * picks a slot in the identity palette and paints the dot; the chip itself
   * stays neutral.
   *
   * This used to build `background: oklch(0.95 0.04 <hue>)` with
   * `color: oklch(0.42 0.14 <hue>)` inline, which had three faults at once. The
   * ground was a tint of the text's own hue, so the two converged. The hue came
   * from the API, so no ratio could be stated for the pair. And both values
   * were light-theme constants, so in the dark theme the chip stayed a bright
   * card with dark text on it.
   */
  hue?: number
  dot?: boolean
  children: ReactNode
}

export function Tag({ tone = 'neutral', hue, dot, className, children, style, ...rest }: TagProps) {
  const identity =
    hue !== undefined
      ? ({ ['--tag-dot-color' as string]: identityColor(hue), ...style } as CSSProperties)
      : style
  return (
    <span
      className={cx(
        'olas-tag',
        tone !== 'neutral' && hue === undefined && `olas-tag-${tone}`,
        className,
      )}
      style={identity}
      {...rest}
    >
      {(dot || hue !== undefined) && <span className="olas-tag-dot" aria-hidden />}
      {children}
    </span>
  )
}
