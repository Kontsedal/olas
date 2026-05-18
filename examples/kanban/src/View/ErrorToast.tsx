// Mutation error toast — surfaces failures from moveCard / reorderColumn and
// offers a one-click retry using the mutation's `lastVariables` signal.

import { use } from '@olas/react'
import { useEffect, useState, type ReactElement } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useApi } from './useApi'

export function ErrorToast(): ReactElement | null {
  const api = useApi()
  const moveErr = use(api.board.moveCard.error)
  const moveVars = use(api.board.moveCard.lastVariables)
  const reorderErr = use(api.board.reorderColumn.error)
  const reorderVars = use(api.board.reorderColumn.lastVariables)

  // Reset the dismissed flag whenever a fresh error arrives.
  const [dismissedAt, setDismissedAt] = useState<number>(0)
  useEffect(() => {
    if (moveErr !== undefined || reorderErr !== undefined) setDismissedAt(0)
  }, [moveErr, reorderErr])

  if (dismissedAt > 0) return null

  if (moveErr !== undefined && moveVars !== undefined) {
    return (
      <Toast
        text={`Move failed: ${describe(moveErr)}`}
        onRetry={() => {
          api.board.moveCard.reset()
          api.board.moveCard.run(moveVars).catch(() => {})
        }}
        onDismiss={() => {
          api.board.moveCard.reset()
          setDismissedAt(Date.now())
        }}
      />
    )
  }
  if (reorderErr !== undefined && reorderVars !== undefined) {
    return (
      <Toast
        text={`Reorder failed: ${describe(reorderErr)}`}
        onRetry={() => {
          api.board.reorderColumn.reset()
          api.board.reorderColumn.run(reorderVars).catch(() => {})
        }}
        onDismiss={() => {
          api.board.reorderColumn.reset()
          setDismissedAt(Date.now())
        }}
      />
    )
  }
  return null
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Toast(props: {
  text: string
  onRetry: () => void
  onDismiss: () => void
}): ReactElement {
  return (
    <div
      role="alert"
      className="fixed left-1/2 bottom-5 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-xl bg-(--color-danger) px-4 py-3 text-sm text-white shadow-[var(--shadow-pop)]"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">{props.text}</span>
      <button
        onClick={props.onRetry}
        className="rounded-md bg-white/20 px-2.5 py-1 text-xs font-medium hover:bg-white/30"
      >
        Retry
      </button>
      <button
        aria-label="Dismiss"
        onClick={props.onDismiss}
        className="rounded-md p-1 text-white/80 hover:bg-white/10 hover:text-white"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
