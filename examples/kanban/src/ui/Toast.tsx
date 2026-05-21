import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from './cx'
import { IconButton } from './IconButton'

export type ToastTone = 'info' | 'success' | 'error'

export type ToastProps = {
  tone?: ToastTone
  title: ReactNode
  message?: ReactNode
  action?: { label: string; onClick: () => void }
  onDismiss?: () => void
}

const ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
}

export function Toast({ tone = 'info', title, message, action, onDismiss }: ToastProps) {
  const Icon = ICON[tone]
  return (
    <div className={cx('olas-toast', `olas-toast-${tone}`)} role="status">
      <span className="olas-toast-icon">
        <Icon size={18} />
      </span>
      <div className="olas-toast-body">
        <div className="olas-toast-title">{title}</div>
        {message && <div className="olas-toast-message">{message}</div>}
        {action && (
          <div className="olas-toast-action" style={{ marginTop: 4 }}>
            <button type="button" className="olas-btn olas-btn-sm" onClick={action.onClick}>
              {action.label}
            </button>
          </div>
        )}
      </div>
      {onDismiss && (
        <IconButton size="sm" label="Dismiss" onClick={onDismiss}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

export function ToastRegion({ children }: { children: ReactNode }) {
  return <div className="olas-toast-region">{children}</div>
}
