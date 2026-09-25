import type { CSSProperties } from 'react'
import { cx } from './cx'
import { identityColor } from './identity'

export type AvatarProps = {
  name: string
  hue?: number
  size?: 'sm' | 'md' | 'lg'
  title?: string
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  if (parts.length === 0) return '?'
  return parts
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase()
}

export function Avatar({ name, hue, size = 'md', title }: AvatarProps) {
  // The hue names a slot in the identity palette; the palette names the
  // colour. See `identity.ts` for why the raw hue never reaches the CSS.
  const style =
    hue !== undefined
      ? ({ ['--avatar-color' as string]: identityColor(hue) } as CSSProperties)
      : undefined
  return (
    <span
      className={cx(
        'olas-avatar',
        size === 'sm' && 'olas-avatar-sm',
        size === 'lg' && 'olas-avatar-lg',
      )}
      style={style}
      title={title ?? name}
      role="img"
      aria-label={title ?? name}
    >
      {initials(name)}
    </span>
  )
}
