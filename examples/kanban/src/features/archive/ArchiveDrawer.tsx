import { use, useRoot } from '@kontsedal/olas-react'
import { ArchiveRestore } from 'lucide-react'
import type { AppApi } from '../../app.controller'
import { Button, Card, cx, Skeleton } from '../../ui'

export function ArchiveDrawer() {
  const app = useRoot<AppApi>()
  const visible = use(app.preferences.prefs).showArchive
  if (!visible) return null
  return <DrawerBody />
}

function DrawerBody() {
  const app = useRoot<AppApi>()
  const flat = use(app.archive.sub.flat)
  const isLoading = use(app.archive.sub.isLoading)
  const hasNext = use(app.archive.sub.hasNextPage)
  const isFetchingNext = use(app.archive.sub.isFetchingNextPage)
  const board = use(app.board.board.data)
  const restoreInto = board?.columns[0]?.id ?? ''

  return (
    <section className="olas-archive" aria-label="Archive">
      <header className="olas-archive-head">
        <strong>Archive</strong>
        <span className="olas-archive-count">
          {flat.length} card{flat.length === 1 ? '' : 's'}
        </span>
      </header>
      {isLoading && flat.length === 0 ? (
        <div className="olas-archive-list">
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      ) : (
        <ul className="olas-archive-list">
          {flat.map((c) => (
            <li key={c.id} className="olas-archive-row">
              <span className="olas-archive-title">{c.title}</span>
              <span className="olas-archive-meta">
                archived {c.archivedAt ? new Date(c.archivedAt).toLocaleDateString() : '—'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                leading={<ArchiveRestore size={12} />}
                disabled={restoreInto === ''}
                onClick={() =>
                  void app.archive.restore.run({ cardId: c.id, columnId: restoreInto })
                }
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
      {hasNext && (
        <div className="olas-archive-foot">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void app.archive.sub.fetchNextPage()}
            disabled={isFetchingNext}
          >
            {isFetchingNext ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </section>
  )
}
