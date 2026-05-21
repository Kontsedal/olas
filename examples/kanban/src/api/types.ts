/**
 * Domain types shared across the api, entities, and features.
 *
 * Cards reference users and labels by id so the `entitiesPlugin`'s
 * normalization can rewrite both lookups when either is patched.
 */

export type Priority = 'low' | 'med' | 'high' | 'urgent'

export type Subtask = {
  text: string
  done: boolean
}

export type User = {
  id: string
  name: string
  /** OKLCh hue (0–360) — drives the avatar tint. Beats storing an RGB hex. */
  hue: number
}

export type Label = {
  id: string
  name: string
  /** Same hue convention as `User`; the `Tag` primitive consumes it. */
  hue: number
}

export type Card = {
  id: string
  columnId: string
  title: string
  description: string
  priority: Priority
  /** ISO yyyy-mm-dd or null. */
  dueDate: string | null
  assigneeIds: string[]
  labelIds: string[]
  subtasks: Subtask[]
  commentsCount: number
  createdAt: number
  archivedAt: number | null
}

export type Column = {
  id: string
  boardId: string
  title: string
  /** OKLCh hue — color-codes the column header strip. */
  hue: number
  cardIds: string[]
}

export type Board = {
  id: string
  name: string
  description: string
  /** Brand accent hue for the board (sidebar, header). */
  hue: number
  columns: Column[]
  /** Hydrated card-by-id map for the cards visible in `columns`. */
  cards: Record<string, Card>
}

export type BoardSummary = Pick<Board, 'id' | 'name' | 'hue'>

export type Comment = {
  id: string
  cardId: string
  authorId: string
  body: string
  createdAt: number
}

export type SearchResults = {
  q: string
  cardIds: string[]
}

/** Realtime / cross-tab event union — broadcast over BroadcastChannel. */
export type RealtimeEvent =
  | {
      type: 'card.moved'
      cardId: string
      fromColumnId: string
      toColumnId: string
      toIndex: number
      by: string
    }
  | { type: 'card.saved'; card: Card; by: string }
  | { type: 'card.created'; card: Card; by: string }
  | { type: 'card.archived'; cardId: string; by: string }
  | { type: 'card.restored'; cardId: string; into: string; by: string }
  | { type: 'comment.added'; comment: Comment; by: string }
  | { type: 'user.updated'; user: User; by: string }
  | { type: 'label.updated'; label: Label; by: string }

/** A page of archived cards (cursor-paginated). */
export type ArchivePage = {
  items: Card[]
  /** Opaque cursor for the next page; `null` when at the end. */
  nextCursor: number | null
}
