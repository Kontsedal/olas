import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'flat' | 'lifted'
  padded?: boolean
}

export function Card({ variant = 'default', padded = false, className, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        'olas-card',
        variant === 'flat' && 'olas-card-flat',
        variant === 'lifted' && 'olas-card-lifted',
        padded && 'olas-card-pad',
        className,
      )}
      {...rest}
    />
  )
}
