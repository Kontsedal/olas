/**
 * Comments thread for the currently selected card.
 *
 * Library primitive demonstrated:
 *  - `useLiveStream(ctx, channel)` over the BroadcastChannel-backed realtime
 *    service. The stream buffers events; we filter by `cardId` and append to
 *    the local thread.
 *
 * The initial backlog is fetched via `defineQuery` (per-card); new comments
 * arrive either via the local `addComment` mutation OR via the realtime
 * stream (when a sibling tab adds one).
 */

import { type Ctx, computed, defineController, defineQuery, signal } from '@kontsedal/olas-core'
import { useLiveStream } from '@kontsedal/olas-realtime'
import { type Comment, REALTIME_CHANNEL, type RealtimeEvent } from '../../api'
import { UserEntity } from '../../entities'
import { activityScope, selectedCardScope } from '../../scopes'

const commentsQuery = defineQuery({
  queryId: 'comments',
  crossTab: true,
  key: (cardId: string) => [cardId],
  fetcher: ({ signal, deps }, cardId: string): Promise<Comment[]> =>
    deps.api.listComments(cardId, signal),
  staleTime: 30_000,
})

export const commentsController = defineController(
  (ctx: Ctx) => {
    const { selectedCardId } = ctx.inject(selectedCardScope)
    const activity = ctx.inject(activityScope)

    const draft = signal('')

    // The thread query — reactive on the active card id.
    const thread = ctx.use(commentsQuery, () => [selectedCardId.value ?? '__none__'])

    // Live stream from broadcast. Events filtered to `comment.added`
    // matching the current card id. Coalesced flush at 32ms — fast enough
    // for "feels live", slow enough to coalesce bursts.
    const stream = useLiveStream<RealtimeEvent>(ctx, REALTIME_CHANNEL, { flushMs: 32 })

    /**
     * Comments that arrived via realtime since the last refetch — keyed by
     * id so we de-dup the local-publish echo against the eventual cache
     * write.
     */
    const liveExtras = signal<Comment[]>([])
    ctx.effect(() => {
      const id = selectedCardId.value
      const events = stream.events.value
      if (id === null) {
        liveExtras.set([])
        return
      }
      const matching: Comment[] = []
      const seen = new Set(liveExtras.peek().map((c) => c.id))
      for (const ev of events) {
        if (ev.type !== 'comment.added') continue
        if (ev.comment.cardId !== id) continue
        if (seen.has(ev.comment.id)) continue
        if (ev.by === ctx.deps.tabId) continue
        matching.push(ev.comment)
      }
      if (matching.length > 0) {
        liveExtras.update((prev) => [...prev, ...matching])
      }
    })

    /** Final ordered list: server-fetched + live extras, sorted by createdAt. */
    const visible = computed<Comment[]>(() => {
      const base = thread.data.value ?? []
      const extra = liveExtras.value
      if (extra.length === 0) return base
      const seen = new Set(base.map((c) => c.id))
      const merged = [...base, ...extra.filter((c) => !seen.has(c.id))]
      return merged.sort((a, b) => a.createdAt - b.createdAt)
    })

    // ───────── Add-comment mutation ─────────

    // The author is the first user in the entities store. In a real app
    // this would be `session.user.id`. We pick the first registered user as
    // a stand-in so the demo doesn't need a sign-in flow.
    const addComment = ctx.mutation<{ body: string }, Comment>({
      name: 'addComment',
      concurrency: 'serial',
      mutate: async (vars, signal) => {
        const id = selectedCardId.peek()
        if (id === null) throw new Error('No card open')
        // Stand-in for "the current user" — first registered user. A real app
        // would read `session.user.id` from a session dep.
        const firstUser = ctx.deps.entities.entries(UserEntity).keys().next().value
        const authorId = firstUser ?? 'u_ada'
        const comment = await ctx.deps.api.addComment(id, authorId, vars.body, signal)
        commentsQuery.setData(id, (prev) => [...(prev ?? []), comment])
        return comment
      },
      onSuccess: (comment) => {
        activity.emit({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ts: Date.now(),
          kind: 'comment',
          text: 'Added a comment',
        })
        ctx.deps.broadcaster.publish({
          type: 'comment.added',
          comment,
          by: ctx.deps.tabId,
        })
        draft.set('')
      },
    })

    return { thread, visible, draft, addComment }
  },
  { name: 'comments' },
)
