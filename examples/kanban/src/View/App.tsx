// Top-level layout. Mounts the OlasProvider, the board, the filter bar, the
// activity feed, the error toast, the devtools panel, and the card editor
// modal.

import { OlasProvider } from '@olas/react'
import { DevtoolsPanel } from '@olas/devtools'
import { useState, type ReactElement } from 'react'
import { AlertTriangle, Sparkles } from 'lucide-react'
import type { Api } from '../api'
import type { AppRoot } from '../app'
import type { CardEditorTarget } from '../controllers/cardEditor'
import { Activity } from './Activity'
import { Board } from './Board'
import { CardEditor } from './CardEditor'
import { ErrorToast } from './ErrorToast'
import { SearchBar } from './SearchBar'

export function App({ root, api }: { root: AppRoot; api: Api }): ReactElement {
  const [editor, setEditor] = useState<CardEditorTarget | null>(null)

  return (
    <OlasProvider root={root}>
      <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_380px] min-h-screen">
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
            <FailureToggle api={api} />
          </header>
          <SearchBar />
          <Board
            onEditCard={(card) => setEditor({ mode: 'edit', card })}
            onAddCard={(columnId) => setEditor({ mode: 'create', columnId })}
          />
        </main>
        <aside className="flex flex-col gap-4 lg:sticky lg:top-5 lg:max-h-[calc(100vh-2.5rem)] lg:overflow-auto">
          <Activity />
          <div className="rounded-xl border border-(--color-border) bg-(--color-bg-elev) overflow-hidden shadow-[var(--shadow-card)]">
            <div className="px-3 py-2 border-b border-(--color-border) text-[10px] font-semibold uppercase tracking-[0.07em] text-(--color-fg-mute)">
              Devtools
            </div>
            <div className="h-[460px]">
              <DevtoolsPanel root={root} defaultTab="tree" />
            </div>
          </div>
        </aside>
        {editor !== null && (
          <CardEditor
            key={editor.mode === 'edit' ? `edit:${editor.card.id}` : `new:${editor.columnId}`}
            target={editor}
            onClose={() => setEditor(null)}
          />
        )}
        <ErrorToast />
      </div>
    </OlasProvider>
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
