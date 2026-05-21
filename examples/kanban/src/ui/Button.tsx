import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  leading?: ReactNode
  trailing?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  leading,
  trailing,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'olas-btn',
        variant === 'primary' && 'olas-btn-primary',
        variant === 'ghost' && 'olas-btn-ghost',
        variant === 'danger' && 'olas-btn-danger',
        size === 'sm' && 'olas-btn-sm',
        size === 'lg' && 'olas-btn-lg',
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  )
}
