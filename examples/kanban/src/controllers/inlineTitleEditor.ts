// Inline title editor — ephemeral controller for editing a single card's
// title in-place.
//
// Spawned via `boardController.openInlineTitleEditor(card)`, which calls
// `ctx.attach(inlineTitleEditorController, { card })` and returns the
// standard `{ api, dispose }` handle. The caller (React) is responsible for
// `dispose()` on cancel / save / blur — without that, every inline-edit
// open would leak a controller into the tree.
//
// This is the "ephemeral child" pattern from SPEC §11.1 (`ctx.session` in
// the spec; this codebase exposes the same semantics via `ctx.attach`).

import { type Ctx, defineController, signal } from '@kontsedal/olas-core'
import type { Card } from '../api'
import { boardQuery } from '../query'
import { activityScope, currentBoardScope } from '../scopes'

export type InlineTitleEditorProps = {
  card: Card
}

export const inlineTitleEditorController = defineController(
  (ctx: Ctx, props: InlineTitleEditorProps) => {
    const board = ctx.inject(currentBoardScope)
    const activity = ctx.inject(activityScope)

    const draft = signal(props.card.title)

    const commit = ctx.mutation<void, Card | null>({
      name: 'inlineTitleCommit',
      mutate: async (_: void, abortSignal) => {
        const next = draft.peek().trim()
        if (next === '' || next === props.card.title) {
          return null
        }
        const saved = await ctx.deps.api.saveCard(
          board.id,
          { ...props.card, title: next },
          abortSignal,
        )
        boardQuery.setData(board.id, (prev) => {
          if (!prev) throw new Error('inlineTitleCommit before board loaded')
          return { ...prev, cards: { ...prev.cards, [saved.id]: saved } }
        })
        return saved
      },
      onSuccess: (saved) => {
        if (saved === null) return
        activity.emit({
          ts: Date.now(),
          kind: 'save',
          text: `Renamed → "${saved.title}"`,
        })
      },
      onError: (err) => {
        activity.emit({
          ts: Date.now(),
          kind: 'error',
          text: `Inline rename failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      },
    })

    return {
      draft,
      commit,
      cardId: props.card.id,
      originalTitle: props.card.title,
    }
  },
  { name: 'inlineTitleEditor' },
)
