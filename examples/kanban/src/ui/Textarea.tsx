import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { cx } from './cx'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: ReactNode
  help?: ReactNode
  error?: ReactNode
}

export function Textarea({ label, help, error, className, id, ...rest }: TextareaProps) {
  const hasError = error !== undefined && error !== false && error !== null && error !== ''
  return (
    <div>
      {label && (
        <label htmlFor={id} className="olas-field-label">
          {label}
        </label>
      )}
      <textarea
        id={id}
        className={cx('olas-textarea', className)}
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
