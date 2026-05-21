import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode
}

export function Badge({ className, ...rest }: BadgeProps) {
  return <span className={cx('olas-badge', className)} {...rest} />
}
