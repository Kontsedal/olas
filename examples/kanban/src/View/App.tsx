// Top-level layout. Mounts the OlasProvider, the board, the filter bar, the
// activity feed, the error toast, the devtools panel, and the card editor
// modal.

import { DevtoolsLauncher } from '@kontsedal/olas-devtools'
import { OlasProvider } from '@kontsedal/olas-react'
import { AlertTriangle, Sparkles, Zap } from 'lucide-react'
import { type ReactElement, useState } from 'react'
import type { Api } from '../api'
import type { AppRoot } from '../app'
import type { CardEditorTarget } from '../controllers/cardEditor'
import { Activity } from './Activity'
import { Board } from './Board'
import { CardEditor } from './CardEditor'
import { ErrorToast } from './ErrorToast'
import { SearchBar } from './SearchBar'
import { useApi } from './useApi'

export function App({ root, api }: { root: AppRoot; api: Api }): ReactElement {
  const [editor, setEditor] = useState<CardEditorTarget | null>(null)

  return (
    <OlasProvider root={root}>
      <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px] min-h-screen">
        <main className="flex flex-col gap-4 min-w-0">
          <header className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-(--color-accent) text-(--color-accent-fg)">
                <Sparkles className="size-4" strokeWidth={2.5} />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-tight">Olas Kanban</h1>
                <p className="text-xs text-(--color-fg-mute)">
                  parallel · latest-wins · serial · optimistic + rollback · formFromZod · scopes
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DemoStorm api={api} />
              <FailureToggle api={api} />
            </div>
          </header>
          <SearchBar />
          <Board
            onEditCard={(card) => setEditor({ mode: 'edit', card })}
            onAddCard={(columnId) => setEditor({ mode: 'create', columnId })}
          />
        </main>
        <aside className="flex flex-col gap-4 lg:sticky lg:top-5 lg:max-h-[calc(100vh-2.5rem)] lg:overflow-auto">
          <Activity />
        </aside>
        {editor !== null && (
          <CardEditor
            key={editor.mode === 'edit' ? `edit:${editor.card.id}` : `new:${editor.columnId}`}
            target={editor}
            onClose={() => setEditor(null)}
          />
        )}
        <ErrorToast />
        {/* Floating, draggable, resizable devtools window. Tap the
            bottom-right launcher to open. Position + size persist. */}
        <DevtoolsLauncher root={root} defaultTab="tree" urlHashKey="kanban" />
      </div>
    </OlasProvider>
  )
}

/**
 * Demo Storm — fires 5 parallel moveCards with 3 server-side failures armed.
 * The user sees optimistic moves flash, then 3 of them snap back when the
 * fake API rejects. Devtools tree/timeline shows the cascade — that's the
 * teaching moment. Spec §6.4 (auto-rollback on non-abort failure).
 */
function DemoStorm({ api }: { api: Api }): ReactElement {
  const ctlApi = useApi()
  const onClick = (): void => {
    const board = ctlApi.board.board.data.peek()
    if (board === undefined) return

    const moves: { cardId: string; fromColumnId: string; toColumnId: string }[] = []
    for (const col of board.columns) {
      const targets = board.columns.filter((c) => c.id !== col.id)
      if (targets.length === 0) continue
      for (const cardId of col.cardIds) {
        const toCol = targets[Math.floor(Math.random() * targets.length)]
        if (toCol === undefined) continue
        moves.push({ cardId, fromColumnId: col.id, toColumnId: toCol.id })
      }
    }
    for (let i = moves.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const a = moves[i]!
      const b = moves[j]!
      moves[i] = b
      moves[j] = a
    }
    const five = moves.slice(0, 5)
    if (five.length === 0) return

    api.failNextNWrites(3)
    for (const m of five) {
      ctlApi.board.moveCard.run({ ...m, toIndex: 0 }).catch(() => {})
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-bg-elev) px-3 py-1.5 text-xs font-medium text-(--color-fg) shadow-[var(--shadow-card)] hover:border-(--color-accent) hover:text-(--color-accent)"
      title="Fires 5 parallel moveCards; 3 are armed to fail. Open the devtools (↘ corner) to watch each one optimistically apply, then roll back."
    >
      <Zap className="size-3.5" /> Demo storm
    </button>
  )
}

function FailureToggle({ api }: { api: Api }): ReactElement {
  const [armed, setArmed] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        api.failNextWrite = !armed
        setArmed(!armed)
      }}
      className={
        armed
          ? 'inline-flex items-center gap-2 rounded-lg bg-(--color-danger) px-3 py-1.5 text-xs font-medium text-white shadow-[var(--shadow-card)] hover:brightness-110'
          : 'inline-flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-bg-elev) px-3 py-1.5 text-xs font-medium text-(--color-fg) shadow-[var(--shadow-card)] hover:bg-(--color-bg-sunk)'
      }
      title="Make the next write fail to demonstrate optimistic rollback"
    >
      <AlertTriangle className="size-3.5" />
      {armed ? 'Next write WILL fail' : 'Arm failure'}
    </button>
  )
}
