// Reader UI. Renders the accumulated feed; "Load more" calls `loadMore()`.
// `useSuspendOnHidden` pauses the root when the tab is hidden (cache stays in
// memory; effects tear down; resumes on visible).
//
// Persisted state (theme, bookmarks, reading progress) is held back from the
// first client render — see `useHydrated` at the bottom of this file.

import { OlasProvider, use, useRoot, useSuspendOnHidden } from '@kontsedal/olas-react'
import { Bookmark, BookmarkPlus, Loader2, MessageCircle, Moon, Sun, SunMoon } from 'lucide-react'
import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react'
import type { Article } from './api'
import { Composer } from './Composer'
import type { AppApi, AppRoot, Progress, Theme } from './controller'

/** What the server renders, because it has no localStorage to read. */
const NO_PROGRESS: Progress = { lastArticleId: null, scrollY: 0 }
const NO_BOOKMARKS: readonly string[] = []
const NO_THEME: Theme = 'auto'

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
  // `usePersisted` reads localStorage synchronously while the controller is
  // constructed, so on a returning visitor these three already hold the
  // stored values by the time `hydrateRoot` runs — and the server, which has
  // no localStorage, sent markup built from the defaults. Rendering the
  // stored values on the first client pass is a hydration mismatch. Hold
  // them back for one render; `useHydrated` explains the mechanism.
  const hydrated = useHydrated()
  const storedProgress = use(api.reader.progress)
  const storedBookmarks = use(api.reader.bookmarks)
  const storedTheme = use(api.reader.theme)
  const progress = hydrated ? storedProgress : NO_PROGRESS
  const bookmarks = hydrated ? storedBookmarks : NO_BOOKMARKS
  const theme = hydrated ? storedTheme : NO_THEME
  const isBookmarked = (articleId: string): boolean =>
    hydrated && api.reader.isBookmarked(articleId)
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
          <p className="font-sans text-[length:var(--text-meta)] text-(--color-fg-mute)">
            {articles.length === 0 && isFetching
              ? 'loading…'
              : `${articles.length} essays · ${bookmarks.length} bookmarked`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => api.reader.theme.set(nextTheme(theme))}
          className="inline-flex items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-bg-elev) px-3 py-1 font-sans text-[length:var(--text-meta)] text-(--color-fg) hover:bg-(--color-bg-sunk)"
          title={`Theme: ${theme} (click to cycle)`}
        >
          {theme === 'light' && <Sun className="size-3.5" />}
          {theme === 'dark' && <Moon className="size-3.5" />}
          {theme === 'auto' && <SunMoon className="size-3.5" />}
          <span className="capitalize">{theme}</span>
        </button>
      </header>

      {continueAt && (
        <div className="mb-5 rounded-[var(--radius-surface)] border border-dashed border-(--color-accent) bg-(--color-accent-soft) px-3 py-2 font-sans text-[length:var(--text-body)] text-(--color-fg)">
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
        <div className="mb-6 flex flex-wrap gap-1.5 font-sans text-[length:var(--text-meta)]">
          <span className="text-(--color-fg-mute) self-center">Bookmarks:</span>
          {bookmarks.map((id) => {
            const a = articles.find((x) => x.id === id)
            if (!a) return null
            return (
              <a
                key={id}
                className="rounded-full border border-(--color-border) bg-(--color-bg-elev) px-2.5 py-0.5 hover:border-(--color-border-control) hover:text-(--color-fg)"
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
              ? 'before:absolute before:-left-4 before:top-5 before:bottom-5 before:w-[3px] before:rounded-[var(--radius-mark)] before:bg-(--color-accent)'
              : ''
          }`}
        >
          <button
            aria-label={isBookmarked(article.id) ? 'Unbookmark' : 'Bookmark'}
            onClick={() => api.reader.toggleBookmark(article.id)}
            className={`absolute right-0 top-5 rounded-[var(--radius-mark)] p-1 hover:bg-(--color-bg-sunk) ${
              isBookmarked(article.id) ? 'text-(--color-accent)' : 'text-(--color-fg-mute)'
            }`}
          >
            {isBookmarked(article.id) ? (
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
          <div className="mt-1 flex flex-wrap items-center gap-1.5 font-sans text-[length:var(--text-meta)] text-(--color-fg-mute)">
            <span>{article.author}</span>
            <span className="opacity-40">·</span>
            <span>{article.publishedAt}</span>
            <span className="opacity-40">·</span>
            <span>{article.readingTime} min read</span>
            <span className="ml-1 rounded-full border border-(--color-border) bg-(--color-bg-elev) px-2 py-0.5 text-[length:var(--text-mark)] uppercase">
              {article.topic}
            </span>
          </div>
          <p className="mt-2 leading-relaxed">{article.excerpt}</p>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpenComment((cur) => (cur === article.id ? null : article.id))}
              className="inline-flex items-center gap-1.5 font-sans text-[length:var(--text-meta)] text-(--color-fg-mute) hover:text-(--color-accent)"
            >
              <MessageCircle className="size-3.5" />
              {openComment === article.id ? 'Hide comments' : 'Comments'}
            </button>
          </div>
          {openComment === article.id && (
            // `key` pins one Composer instance per article, so the
            // controller it attaches never has to be swapped in place.
            <Composer
              key={article.id}
              api={api}
              articleId={article.id}
              onClose={() => setOpenComment(null)}
            />
          )}
        </article>
      ))}

      {hasNextPage ? (
        <div className="flex justify-center py-8">
          <button
            type="button"
            disabled={isFetching}
            onClick={() => void api.reader.loadMore()}
            className="inline-flex items-center gap-2 rounded-full border border-(--color-border) bg-(--color-bg-elev) px-6 py-2 font-sans text-[length:var(--text-body)] hover:bg-(--color-bg-hover) hover:border-(--color-border-control) disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isFetching && <Loader2 className="size-4 animate-spin" />}
            {isFetching ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : (
        <p className="py-8 text-center font-sans text-[length:var(--text-meta)] text-(--color-fg-mute)">
          End of feed.
        </p>
      )}
    </div>
  )
}

/**
 * `false` on the server and on the client's first, hydrating render; `true`
 * from the render after hydration onwards.
 *
 * `useSyncExternalStore` takes a third argument, the server snapshot, and
 * React uses it for the hydrating pass as well — so the two sides agree on
 * `false`, the markup matches, and the client re-renders with `true` once
 * hydration is done. The store never actually changes, hence the no-op
 * `subscribe`. This is the general answer for any state the server cannot
 * see: localStorage, `window.matchMedia`, the current time.
 *
 * The cost is one extra client render, and a first paint that shows the
 * default theme before the stored one. An app that cannot accept the theme
 * flash writes `data-theme` from a blocking inline script in the document
 * head, before React runs at all.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, alwaysTrue, alwaysFalse)
}

const subscribeToNothing = (): (() => void) => noop
const noop = (): void => {}
const alwaysTrue = (): boolean => true
const alwaysFalse = (): boolean => false

function nextTheme(t: Theme): Theme {
  if (t === 'auto') return 'light'
  if (t === 'light') return 'dark'
  return 'auto'
}
