import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode
  help?: ReactNode
  error?: ReactNode
}

export function Input({ label, help, error, className, id, ...rest }: InputProps) {
  const hasError = error !== undefined && error !== false && error !== null && error !== ''
  return (
    <div>
      {label && (
        <label htmlFor={id} className="olas-field-label">
          {label}
        </label>
      )}
      <input
        id={id}
        className={cx('olas-input', className)}
        aria-invalid={hasError ? 'true' : undefined}
        {...rest}
      />
      {hasError ? (
        <div className="olas-field-error">{error}</div>
      ) : help ? (
        <div className="olas-field-help">{help}</div>
      ) : null}
    </div>
  )
}
