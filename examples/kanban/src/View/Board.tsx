// Board view — three columns + the cards in each.
//
// `useQuery` batches the 8 AsyncState signals into one re-render. The board
// data drives the layout; per-column callbacks dispatch moves, reorders, and
// the new-card flow. Rejected promises are intentionally swallowed at the
// call site — rollback already happened in the mutation's `onError`, and the
// `<ErrorToast />` surfaces the failure with a retry.

import { useQuery } from '@olas/react'
import type { ReactElement } from 'react'
import type { Card } from '../api'
import { Column } from './Column'
import { useApi } from './useApi'

const noop = (): void => {}

export function Board(props: {
  onEditCard: (card: Card) => void
  onAddCard: (columnId: string) => void
}): ReactElement {
  const api = useApi()
  const board = useQuery(api.board.board)

  if (board.isLoading) {
    return (
      <div className="rounded-xl border border-(--color-border) bg-(--color-bg-elev) p-6 text-sm text-(--color-fg-mute)">
        Loading board…
      </div>
    )
  }
  if (board.error !== undefined) {
    return (
      <div role="alert" className="rounded-xl border border-(--color-danger) bg-(--color-bg-elev) p-4 text-sm text-(--color-danger)">
        Failed: {String(board.error)}
      </div>
    )
  }
  if (board.data === undefined) return <div className="text-sm text-(--color-fg-mute)">No board</div>

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {board.data.columns.map((col) => {
        const cards = col.cardIds
          .map((id) => board.data!.cards[id])
          .filter((c): c is Card => c !== undefined)
        return (
          <Column
            key={col.id}
            column={col}
            cards={cards}
            otherColumns={board.data!.columns.filter((c) => c.id !== col.id)}
            onMove={(cardId, toColumnId, toIndex) =>
              api.board.moveCard
                .run({ cardId, fromColumnId: col.id, toColumnId, toIndex })
                .catch(noop)
            }
            onReorder={(cardIds) =>
              api.board.reorderColumn.run({ columnId: col.id, cardIds }).catch(noop)
            }
            onEditCard={props.onEditCard}
            onAddCard={() => props.onAddCard(col.id)}
          />
        )
      })}
    </div>
  )
}
