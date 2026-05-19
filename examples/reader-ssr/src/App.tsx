// Reader UI. Renders the accumulated feed; "Load more" calls `loadMore()`.
// `useSuspendOnHidden` pauses the root when the tab is hidden (cache stays in
// memory; effects tear down; resumes on visible).

import { OlasProvider, use, useRoot, useSuspendOnHidden } from '@kontsedal/olas-react'
import { Bookmark, BookmarkPlus, Loader2, MessageCircle, Moon, Sun, SunMoon } from 'lucide-react'
import { type ReactElement, useEffect, useState } from 'react'
import type { Article } from './api'
import { Composer } from './Composer'
import type { AppApi, AppRoot, Theme } from './controller'

export function App({ root }: { root: AppRoot }): ReactElement {
  return (
    <OlasProvider root={root}>
      <ReaderLayout root={root} />
    </OlasProvider>
  )
}

function ReaderLayout({ root }: { root: AppRoot }): ReactElement {
  useSuspendOnHidden(root)

  const api = useRoot<AppApi>()
  const articles = use(api.reader.flatArticles)
  const hasNextPage = use(api.reader.hasNextPage)
  const isFetching = use(api.reader.isFetching)
  const progress = use(api.reader.progress)
  const bookmarks = use(api.reader.bookmarks)
  const theme = use(api.reader.theme)
  // Which article's composer is open. Only one at a time — the controller is
  // disposed via `ctx.attach`'s dispose handle when the user closes it or
  // opens a different one.
  const [openComment, setOpenComment] = useState<string | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = theme
  }, [theme])

  const continueAt = progress.lastArticleId
    ? articles.find((a) => a.id === progress.lastArticleId)
    : undefined

  return (
    <div className="mx-auto max-w-2xl px-6 pb-16 pt-7">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3 border-b border-(--color-border) pb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-sans text-xl font-bold tracking-tight">Olas Reader</h1>
          <p className="font-sans text-xs text-(--color-fg-mute)">
            {articles.length === 0 && isFetching
              ? 'loading…'
              : `${articles.length} essays · ${bookmarks.length} bookmarked`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => api.reader.theme.set(nextTheme(theme))}
          className="inline-flex items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-bg-elev) px-3 py-1 font-sans text-xs text-(--color-fg) hover:bg-(--color-bg-sunk)"
          title={`Theme: ${theme} (click to cycle)`}
        >
          {theme === 'light' && <Sun className="size-3.5" />}
          {theme === 'dark' && <Moon className="size-3.5" />}
          {theme === 'auto' && <SunMoon className="size-3.5" />}
          <span className="capitalize">{theme}</span>
        </button>
      </header>

      {continueAt && (
        <div className="mb-5 rounded-lg border border-dashed border-(--color-accent) bg-(--color-accent-bg) px-3 py-2 font-sans text-sm text-(--color-fg-mute)">
          Continue reading:{' '}
          <a
            className="font-medium text-(--color-accent) hover:underline"
            href={`#${continueAt.id}`}
          >
            {continueAt.title}
          </a>{' '}
          by {continueAt.author}
        </div>
      )}

      {bookmarks.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-1.5 font-sans text-xs">
          <span className="text-(--color-fg-mute) self-center">Bookmarks:</span>
          {bookmarks.map((id) => {
            const a = articles.find((x) => x.id === id)
            if (!a) return null
            return (
              <a
                key={id}
                className="rounded-full border border-(--color-border) bg-(--color-bg-elev) px-2.5 py-0.5 hover:border-(--color-accent) hover:text-(--color-accent)"
                href={`#${id}`}
              >
                {a.title}
              </a>
            )
          })}
        </div>
      )}

      {articles.map((article: Article, _idx) => (
        <article
          key={article.id}
          id={article.id}
          className={`relative border-t border-(--color-border) py-5 first:border-t-0 first:pt-0 ${
            progress.lastArticleId === article.id
              ? 'before:absolute before:-left-4 before:top-5 before:bottom-5 before:w-[3px] before:rounded before:bg-(--color-accent)'
              : ''
          }`}
        >
          <button
            aria-label={api.reader.isBookmarked(article.id) ? 'Unbookmark' : 'Bookmark'}
            onClick={() => api.reader.toggleBookmark(article.id)}
            className={`absolute right-0 top-5 rounded p-1 hover:bg-(--color-bg-sunk) ${
              api.reader.isBookmarked(article.id)
                ? 'text-(--color-accent)'
                : 'text-(--color-fg-mute)'
            }`}
          >
            {api.reader.isBookmarked(article.id) ? (
              <Bookmark className="size-5 fill-current" />
            ) : (
              <BookmarkPlus className="size-5" />
            )}
          </button>
          <h2 className="font-sans text-xl font-semibold leading-tight tracking-tight pr-10">
            <a
              href={`#${article.id}`}
              className="hover:text-(--color-accent)"
              onClick={() => api.reader.onArticleRead(article.id)}
            >
              {article.title}
            </a>
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 font-sans text-xs text-(--color-fg-mute)">
            <span>{article.author}</span>
            <span className="opacity-40">·</span>
            <span>{article.publishedAt}</span>
            <span className="opacity-40">·</span>
            <span>{article.readingTime} min read</span>
            <span className="ml-1 rounded-full border border-(--color-border) bg-(--color-bg-elev) px-2 py-0.5 text-[10px] uppercase tracking-wider">
              {article.topic}
            </span>
          </div>
          <p className="mt-2 leading-relaxed">{article.excerpt}</p>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpenComment((cur) => (cur === article.id ? null : article.id))}
              className="inline-flex items-center gap-1.5 font-sans text-xs text-(--color-fg-mute) hover:text-(--color-accent)"
            >
              <MessageCircle className="size-3.5" />
              {openComment === article.id ? 'Hide comments' : 'Comments'}
            </button>
          </div>
          {openComment === article.id && (
            <Composer api={api} articleId={article.id} onClose={() => setOpenComment(null)} />
          )}
        </article>
      ))}

      {hasNextPage ? (
        <div className="flex justify-center py-8">
          <button
            type="button"
            disabled={isFetching}
            onClick={() => void api.reader.loadMore()}
            className="inline-flex items-center gap-2 rounded-full border border-(--color-border) bg-(--color-bg-elev) px-6 py-2 font-sans text-sm hover:bg-(--color-accent) hover:text-white hover:border-(--color-accent) disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {isFetching && <Loader2 className="size-4 animate-spin" />}
            {isFetching ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : (
        <p className="py-8 text-center font-sans text-xs text-(--color-fg-mute)">End of feed.</p>
      )}
    </div>
  )
}

function nextTheme(t: Theme): Theme {
  if (t === 'auto') return 'light'
  if (t === 'light') return 'dark'
  return 'auto'
}
