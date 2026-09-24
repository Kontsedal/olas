import { useRoot, useValue } from '@kontsedal/olas-react'
import { Send } from 'lucide-react'
import type { Comment } from '../../api'
import type { AppApi } from '../../app.controller'
import { UserEntity } from '../../entities'
import { Avatar, Button } from '../../ui'

export function CommentsThread({ cardId: _cardId }: { cardId: string }) {
  const app = useRoot<AppApi>()
  const visible = useValue(app.comments.visible)
  const draft = useValue(app.comments.draft)
  const isPending = useValue(app.comments.addComment.isPending)

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (draft.trim() === '') return
    void app.comments.addComment.run({ body: draft.trim() })
  }

  return (
    <section className="olas-comments" aria-label="Comments">
      <header className="olas-comments-head">
        <span className="olas-field-label">Comments</span>
        <span className="olas-comments-count">{visible.length}</span>
      </header>

      <ul className="olas-comments-list">
        {visible.length === 0 ? (
          <li className="olas-comments-empty">No comments yet. Start the conversation.</li>
        ) : (
          visible.map((c) => <CommentRow key={c.id} comment={c} />)
        )}
      </ul>

      <form className="olas-comment-compose" onSubmit={onSubmit}>
        <input
          type="text"
          className="olas-input"
          placeholder="Write a comment…"
          value={draft}
          onChange={(e) => app.comments.draft.set(e.currentTarget.value)}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={isPending || draft.trim() === ''}
          leading={<Send size={12} />}
        >
          Send
        </Button>
      </form>
    </section>
  )
}

/**
 * One comment, with its author read reactively.
 *
 * `entities.get(...)` is a documented non-reactive peek: a profile rename
 * arriving from anywhere else would not reach this row until the comments
 * query refetched. `entities.signal(...)` is the reactive read. It lives in
 * its own component because React matches hooks by call order, and a
 * `use(...)` inside the `.map` above would change the hook count with the
 * comment count.
 */
function CommentRow({ comment }: { comment: Comment }) {
  const app = useRoot<AppApi>()
  const author = useValue(app.entities.signal(UserEntity, comment.authorId))
  return (
    <li className="olas-comment">
      <Avatar name={author?.name ?? 'Unknown'} hue={author?.hue} size="sm" />
      <div className="olas-comment-body">
        <div className="olas-comment-meta">
          <strong>{author?.name ?? 'Someone'}</strong>
          <span>{relTime(comment.createdAt)}</span>
        </div>
        <p className="olas-comment-text">{comment.body}</p>
      </div>
    </li>
  )
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}
