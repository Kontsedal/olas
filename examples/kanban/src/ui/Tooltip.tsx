import type { ReactNode } from 'react'

export type TooltipProps = {
  label: string
  children: ReactNode
}

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="olas-tooltip-wrap">
      {children}
      <span className="olas-tooltip" role="tooltip">
        {label}
      </span>
    </span>
  )
}
