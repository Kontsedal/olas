// Comment composer — opens beneath an article when the user clicks the
// "Comments" button. Demonstrates `debouncedValidator` end-to-end: the body
// field shows `isValidating` while the server thinks, then either
// `errors[0]` or "ready to post".

import { use, useField } from '@kontsedal/olas-react'
import { Loader2, MessageCircle, Send, X } from 'lucide-react'
import { type ReactElement, useEffect, useMemo } from 'react'
import type { AppApi } from './controller'

export function Composer({
  api,
  articleId,
  onClose,
}: {
  api: AppApi
  articleId: string
  onClose: () => void
}): ReactElement {
  // ctx.attach returns { api, dispose } — let the parent close it.
  const handle = useMemo(() => api.reader.openComposer(articleId), [api, articleId])
  // Tear down when the React component unmounts (e.g. switching articles).
  useEffect(() => () => handle.dispose(), [handle])

  const author = useField(handle.api.author)
  const body = useField(handle.api.body)
  const isPending = use(handle.api.submit.isPending)
  const error = use(handle.api.submit.error)
  const commentsData = use(handle.api.comments.data)
  const commentsLoading = use(handle.api.comments.isLoading)

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    handle.api.submit.run().catch(() => {})
  }

  return (
    <section className="mt-4 rounded-[var(--radius-surface)] border border-(--color-border) bg-(--color-bg-elev) p-4 font-sans">
      <header className="flex items-center justify-between mb-3">
        <h3 className="m-0 inline-flex items-center gap-2 text-[length:var(--text-body)] font-semibold">
          <MessageCircle className="size-4 text-(--color-accent)" />
          Comments
          <span className="text-[length:var(--text-meta)] font-normal text-(--color-fg-mute)">
            · {commentsData?.length ?? 0}
          </span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close composer"
          className="rounded-[var(--radius-control)] p-1 text-(--color-fg-mute) hover:bg-(--color-bg-sunk) hover:text-(--color-fg)"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 text-[length:var(--text-body)]">
        <input
          value={author.value}
          onChange={(e) => author.set(e.target.value)}
          onBlur={author.markTouched}
          placeholder="Your name"
          className="rounded-[var(--radius-control)] border border-(--color-border) bg-(--color-bg-sunk) px-3 py-1.5 outline-none focus:border-(--color-accent) focus:ring-2 focus:ring-(--color-accent)/30"
        />
        <div className="relative">
          <textarea
            value={body.value}
            onChange={(e) => body.set(e.target.value)}
            onBlur={body.markTouched}
            rows={3}
            placeholder="Write a comment (server-validated, 220 ms debounce)"
            className="w-full rounded-[var(--radius-control)] border border-(--color-border) bg-(--color-bg-sunk) px-3 py-1.5 outline-none focus:border-(--color-accent) focus:ring-2 focus:ring-(--color-accent)/30 resize-y"
          />
          {body.isValidating && (
            <Loader2 className="absolute right-2 top-2 size-4 animate-spin text-(--color-fg-mute)" />
          )}
        </div>
        <ValidationStatus
          touched={body.touched}
          isValidating={body.isValidating}
          isValid={body.isValid}
          error={body.errors[0]}
        />

        {error !== undefined && (
          <div
            role="alert"
            className="rounded-[var(--radius-control)] bg-(--color-accent-soft) px-3 py-2 text-[length:var(--text-meta)] text-(--color-fg)"
          >
            {String((error as Error)?.message ?? error)}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-(--color-accent) px-3 py-1.5 text-[length:var(--text-meta)] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            {isPending ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </form>

      <div className="mt-4 border-t border-(--color-border) pt-3">
        {commentsLoading ? (
          <p className="text-[length:var(--text-meta)] text-(--color-fg-mute)">Loading comments…</p>
        ) : commentsData && commentsData.length > 0 ? (
          <ul className="flex flex-col gap-3 list-none p-0 m-0">
            {commentsData.map((c) => (
              <li key={c.id}>
                <div className="text-[length:var(--text-meta)] text-(--color-fg-mute) mb-0.5">
                  <strong className="text-(--color-fg)">{c.author}</strong> ·{' '}
                  {new Date(c.ts).toLocaleTimeString()}
                </div>
                <p className="m-0 text-[length:var(--text-body)]">{c.body}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[length:var(--text-meta)] text-(--color-fg-mute)">
            No comments yet — be first.
          </p>
        )}
      </div>
    </section>
  )
}

function ValidationStatus(props: {
  touched: boolean
  isValidating: boolean
  isValid: boolean
  error: string | undefined
}): ReactElement | null {
  if (!props.touched) return null
  if (props.isValidating) {
    return (
      <span className="text-[length:var(--text-meta)] text-(--color-fg-mute) inline-flex items-center gap-1">
        <Loader2 className="size-3 animate-spin" /> checking with server…
      </span>
    )
  }
  if (props.error !== undefined) {
    return (
      <span className="text-[length:var(--text-meta)] text-(--color-accent)">{props.error}</span>
    )
  }
  if (props.isValid) {
    return (
      <span className="text-[length:var(--text-meta)] text-(--color-fg-mute)">✓ ready to post</span>
    )
  }
  return null
}
