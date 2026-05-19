// Per-article comment composer.
//
// Demonstrates the otherwise-invisible piece of the form system:
// **`debouncedValidator`** for async server-side validation. Every keystroke
// re-runs the validator after a quiet period — `isValidating` is true while
// the server thinks; `isValid` is false until the server says it's fine. The
// usual mutation submits the comment when the form is valid.

import { type Ctx, debouncedValidator, defineController, required } from '@kontsedal/olas-core'
import type { Comment } from './api'

export type ComposerProps = { articleId: string }

const VALIDATION_DEBOUNCE_MS = 220

export const composerController = defineController(
  (ctx: Ctx, props: ComposerProps) => {
    const author = ctx.field<string>('', [required<string>()])

    // Body field has TWO validators: a fast sync one (required) AND an async
    // debounced one that calls the api. `debouncedValidator` resets its
    // timer on every value change and aborts in-flight calls when superseded.
    const body = ctx.field<string>('', [
      required<string>(),
      debouncedValidator(
        (value, signal) => ctx.deps.api.validateCommentBody(value, signal),
        VALIDATION_DEBOUNCE_MS,
      ),
    ])

    const form = ctx.form({ author, body })

    // Comments list — private `ctx.cache` because no other controller cares
    // about this article's comments.
    const comments = ctx.cache<Comment[]>(
      (signal) => ctx.deps.api.listComments(props.articleId, signal),
      { staleTime: 10_000 },
    )

    const submit = ctx.mutation<void, Comment>({
      name: 'postComment',
      mutate: async (_, signal) => {
        form.markAllTouched()
        const ok = await form.validate()
        if (!ok) throw new Error('Invalid comment')
        const posted = await ctx.deps.api.postComment(
          {
            articleId: props.articleId,
            author: author.peek(),
            body: body.peek(),
          },
          signal,
        )
        // Patch the comments cache so the new comment appears immediately.
        comments.setData((prev) => [posted, ...(prev ?? [])])
        body.reset()
        return posted
      },
    })

    return { author, body, form, comments, submit, articleId: props.articleId }
  },
  { name: 'composer' },
)
