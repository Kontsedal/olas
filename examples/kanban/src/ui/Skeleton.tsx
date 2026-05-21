import type { CSSProperties } from 'react'
import { cx } from './cx'

export type SkeletonProps = {
  width?: number | string
  height?: number | string
  rounded?: 'sm' | 'md' | 'lg' | 'pill'
  className?: string
}

const RADIUS: Record<NonNullable<SkeletonProps['rounded']>, string> = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  pill: '999px',
}

export function Skeleton({ width, height, rounded = 'md', className }: SkeletonProps) {
  const style: CSSProperties = {
    width: width ?? '100%',
    height: height ?? '1em',
    borderRadius: RADIUS[rounded],
  }
  return <span className={cx('olas-skeleton', className)} style={style} aria-hidden />
}
