import { X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './IconButton'

export type DialogProps = {
  open: boolean
  onClose: () => void
  title: ReactNode
  footer?: ReactNode
  children: ReactNode
}

export function Dialog({ open, onClose, title, footer, children }: DialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <>
      <div className="olas-dialog-backdrop" onClick={onClose} aria-hidden />
      <div className="olas-dialog" role="dialog" aria-modal="true">
        <div className="olas-dialog-panel" onClick={(e) => e.stopPropagation()}>
          <div className="olas-dialog-header">
            <div className="olas-dialog-title">{title}</div>
            <IconButton size="sm" label="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="olas-dialog-body">{children}</div>
          {footer && <div className="olas-dialog-footer">{footer}</div>}
        </div>
      </div>
    </>,
    document.body,
  )
}
