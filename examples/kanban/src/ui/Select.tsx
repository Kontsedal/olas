import type { ReactNode, SelectHTMLAttributes } from 'react'
import { cx } from './cx'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: ReactNode
  help?: ReactNode
  error?: ReactNode
}

export function Select({ label, help, error, className, id, children, ...rest }: SelectProps) {
  const hasError = error !== undefined && error !== false && error !== null && error !== ''
  return (
    <div>
      {label && (
        <label htmlFor={id} className="olas-field-label">
          {label}
        </label>
      )}
      <select
        id={id}
        className={cx('olas-select', className)}
        aria-invalid={hasError ? 'true' : undefined}
        {...rest}
      >
        {children}
      </select>
      {hasError ? (
        <div className="olas-field-error">{error}</div>
      ) : help ? (
        <div className="olas-field-help">{help}</div>
      ) : null}
    </div>
  )
}
