import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type TagTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export type TagProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: TagTone
  /** Optional custom hue (oklch chroma `0.16`, lightness `0.62`) — used by labels. */
  hue?: number
  dot?: boolean
  children: ReactNode
}

export function Tag({ tone = 'neutral', hue, dot, className, children, style, ...rest }: TagProps) {
  const inline =
    hue !== undefined
      ? {
          background: `oklch(0.95 0.04 ${hue})`,
          color: `oklch(0.42 0.14 ${hue})`,
          borderColor: 'transparent',
          ...style,
        }
      : style
  return (
    <span
      className={cx(
        'olas-tag',
        tone !== 'neutral' && hue === undefined && `olas-tag-${tone}`,
        className,
      )}
      style={inline}
      {...rest}
    >
      {dot && <span className="olas-tag-dot" aria-hidden />}
      {children}
    </span>
  )
}
