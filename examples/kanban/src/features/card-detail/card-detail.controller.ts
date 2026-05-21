/**
 * Card detail feature. The right-hand panel that opens when a card is
 * selected.
 *
 * Library primitives demonstrated:
 *  - `formFromZod` + `FieldArray` for subtasks (already covered elsewhere,
 *    here we exercise async validators on a leaf field).
 *  - `debouncedValidator` — async "is this title already used?" check.
 *  - The controller exposes its own `suspend` / `resume` so a `<KeepAlive>`
 *    wrapper can freeze it when the panel unmounts (the form keeps its
 *    state; only effects pause).
 */

import {
  type Ctx,
  computed,
  debouncedValidator,
  defineController,
  signal,
} from '@kontsedal/olas-core'
import { formFromZod } from '@kontsedal/olas-zod'
import type { Card, SaveCardInput } from '../../api'
import { type CardFormValue, cardFormSchema } from '../../api'
import {
  activeBoardScope,
  activityScope,
  notificationsScope,
  selectedCardScope,
} from '../../scopes'
import { boardQuery } from '../board/board.query'

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const blankInitials: CardFormValue = {
  title: '',
  description: '',
  priority: 'med',
  dueDate: '',
  assigneeIds: [],
  labelIds: [],
  subtasks: [],
}

export const cardDetailController = defineController(
  (ctx: Ctx) => {
    const { activeBoardId } = ctx.inject(activeBoardScope)
    const { selectedCardId, close } = ctx.inject(selectedCardScope)
    const activity = ctx.inject(activityScope)
    const notifications = ctx.inject(notificationsScope)

    const isPaused = signal(false)

    // Subscribe to the active board so we can pull the selected card's
    // current data from the cache reactively.
    const board = ctx.use(boardQuery, () => [activeBoardId.value])

    /** The card currently being edited — `null` when the panel is closed. */
    const card = computed<Card | null>(() => {
      const id = selectedCardId.value
      if (id === null) return null
      const data = board.data.value
      return data?.cards[id] ?? null
    })

    /**
     * Build a single form upfront — its initial values reflect whatever
     * card is selected at construction (or blank). On every selection
     * change we re-anchor via `setAsInitial`, which doesn't dirty the form.
     */
    const form = formFromZod(ctx, cardFormSchema, { initials: blankInitials })

    // Attach the async unique-title validator to the title field. Imperatively
    // pushing into the existing validator list isn't supported; instead we
    // wire a manual effect that re-runs the check.
    //
    // The simpler `debouncedValidator` approach is to declare it at form
    // construction. Since `formFromZod` doesn't accept extra leaf validators
    // today, we hand-roll one here that mirrors `debouncedValidator`'s shape.
    const titleValidator = debouncedValidator<string>(async (value, signal) => {
      const cardId = selectedCardId.peek()
      if (value.trim() === '') return null
      const available = await ctx.deps.api.isCardTitleAvailable(
        activeBoardId.peek(),
        value,
        cardId,
        signal,
      )
      return available ? null : 'Title is already used on this board'
    }, 400)

    // Track the validator's last run so we surface it in the field's errors.
    // Manual since `formFromZod` doesn't accept extra leaf validators today.
    const titleAsyncError = signal<string | null>(null)
    const isTitleChecking = signal(false)

    let titleCheckAborter: AbortController | null = null
    ctx.effect(() => {
      const value = form.fields.title.value
      titleCheckAborter?.abort()
      const aborter = new AbortController()
      titleCheckAborter = aborter
      isTitleChecking.set(true)
      Promise.resolve(titleValidator(value, aborter.signal)).then(
        (result) => {
          if (aborter.signal.aborted) return
          titleAsyncError.set(result)
          isTitleChecking.set(false)
        },
        () => {
          // Aborted — leave as-is.
        },
      )
    })
    ctx.onDispose(() => titleCheckAborter?.abort())

    // Watch the resolved card signal and refresh form initials when the
    // user picks a different card OR the card's data lands later.
    let lastCardId: string | null = null
    ctx.effect(() => {
      const c = card.value
      if (c === null) {
        if (lastCardId !== null) form.resetWithInitial(blankInitials)
        lastCardId = null
        return
      }
      // Only re-anchor when the id changes — avoid stomping in-progress
      // edits whenever the cache writes back (e.g. cross-tab patch).
      if (c.id !== lastCardId) {
        form.resetWithInitial(cardToFormInitials(c))
        lastCardId = c.id
      }
    })

    // ───────── Save mutation (serial) ─────────

    const save = ctx.mutation<void, Card>({
      name: 'saveCard',
      concurrency: 'serial',
      mutate: async (_v, signal) => {
        const id = selectedCardId.peek()
        if (id === null) throw new Error('No card open')
        form.markAllTouched()
        const ok = await form.validate()
        if (!ok || titleAsyncError.peek() !== null) {
          throw new Error('Form has errors')
        }
        const value = form.value.value as CardFormValue
        const input: SaveCardInput = {
          id,
          title: value.title,
          description: value.description,
          priority: value.priority,
          dueDate: value.dueDate && value.dueDate !== '' ? value.dueDate : null,
          assigneeIds: value.assigneeIds,
          labelIds: value.labelIds,
          subtasks: value.subtasks,
        }
        const saved = await ctx.deps.api.saveCard(activeBoardId.peek(), input, signal)
        boardQuery.setData(activeBoardId.peek(), (prev) =>
          prev ? { ...prev, cards: { ...prev.cards, [saved.id]: saved } } : (prev as never),
        )
        return saved
      },
      onSuccess: (saved) => {
        activity.emit({
          id: uid(),
          ts: Date.now(),
          kind: 'save',
          text: `Saved "${saved.title}"`,
        })
        ctx.deps.broadcaster.publish({
          type: 'card.saved',
          card: saved,
          by: ctx.deps.tabId,
        })
      },
      onError: (err) =>
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Save failed',
          message: errMessage(err),
        }),
    })

    return {
      card,
      form,
      save,
      close,
      titleAsyncError,
      isTitleChecking,
      // SuspendableController shape for `<KeepAlive>`.
      suspend: () => isPaused.set(true),
      resume: () => isPaused.set(false),
      isPaused,
    }
  },
  { name: 'cardDetail' },
)

function cardToFormInitials(card: Card): CardFormValue {
  return {
    title: card.title,
    description: card.description,
    priority: card.priority,
    dueDate: card.dueDate ?? '',
    assigneeIds: card.assigneeIds,
    labelIds: card.labelIds,
    subtasks: card.subtasks,
  }
}
