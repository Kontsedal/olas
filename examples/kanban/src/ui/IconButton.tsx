import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: 'sm' | 'md' | 'lg'
  label: string
  pressed?: boolean
  children: ReactNode
}

export function IconButton({
  size = 'md',
  label,
  pressed,
  className,
  children,
  type = 'button',
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      // Use the native title attribute as the tooltip — it never clips off
      // the viewport edge, no positioning logic, no animation, just works.
      title={title ?? label}
      className={cx(
        'olas-iconbtn',
        size === 'sm' && 'olas-iconbtn-sm',
        size === 'lg' && 'olas-iconbtn-lg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
