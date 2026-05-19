// Reader controller — paginated article feed with SSR-friendly cache shape.
//
// Coverage map (see .wiki/modules/examples.md):
//  - `defineQuery` keyed by cursor          → each loaded page is a separate
//                                              cache entry, individually
//                                              dehydratable for SSR
//  - reactive key thunk on `ctx.use`         → the subscription re-keys when
//                                              `currentCursor` signal changes
//  - `ctx.effect` accumulator                → pages append as new cursors land
//  - `root.waitForIdle` / `root.dehydrate`   → SSR snapshot
//  - `createRoot(..., { hydrate })`          → client hydration
//  - `usePersisted`                          → reading progress survives reloads
//  - `ctx.emitter` + `ctx.on`                → analytics events
//  - `onError` root option + `ErrorContext`  → centralized error handling
//
// Why not `defineInfiniteQuery`? The current `root.dehydrate()` only serializes
// entries from regular `defineQuery` caches — infinite-query state is not
// included. Modeling pagination as "regular query + reactive key" gives us
// SSR-ready entries (one per cursor) while still demonstrating accumulation.

import type { Ctx, DehydratedState, ErrorContext } from '@olas/core'
import { computed, createRoot, defineController, defineQuery, signal } from '@olas/core'
import { type StorageAdapter, usePersisted } from '@olas/persist'
import type { Api, Article, Page } from './api'
import { composerController } from './composer-controller'

export type AnalyticsEvent = { articleId: string; ts: number }

export type Logger = {
  error(err: unknown, context: ErrorContext): void
}

export type ReaderDeps = {
  api: Api
  storage?: StorageAdapter
  analytics?: { track(event: AnalyticsEvent): void }
  logger?: Logger
}

declare module '@olas/core' {
  interface AmbientDeps {
    api: Api
    storage?: StorageAdapter
    analytics?: { track(event: AnalyticsEvent): void }
    logger?: Logger
  }
}

// --- Shared query: one cache entry per cursor. ---------------------------

export const pageQuery = defineQuery({
  key: (cursor: number) => ['page', cursor],
  fetcher: ({ signal, deps }, cursor: number): Promise<Page> => deps.api.getPage(cursor, signal),
  staleTime: 60_000,
})

// --- Reading progress state ----------------------------------------------

export type Progress = {
  lastArticleId: string | null
  scrollY: number
}

export type Theme = 'light' | 'dark' | 'auto'

// --- Reader controller ---------------------------------------------------

export const readerController = defineController(
  (ctx: Ctx) => {
    // (name added below via the second arg — see end of factory.)
    // Cursor state. Bumped by `loadMore()`. Reactive key on ctx.use means
    // the subscription re-keys when this signal changes — i.e. the cache
    // entry being read switches transparently.
    const currentCursor = signal<number>(0)
    const currentPage = ctx.use(pageQuery, () => [currentCursor.value])

    // Accumulator: every successful page lands here. After SSR hydration the
    // effect immediately observes the cached cursor-0 page and pushes it.
    const loadedPages = signal<Page[]>([])

    ctx.effect(() => {
      const data = currentPage.data.value
      const cursor = currentCursor.peek()
      if (data === undefined) return
      loadedPages.update((pages) => {
        if (pages.length > cursor) return pages // already accumulated
        return [...pages, data]
      })
    })

    const flatArticles = computed<Article[]>(() => {
      const out: Article[] = []
      for (const p of loadedPages.value) {
        for (const a of p.items) out.push(a)
      }
      return out
    })

    const hasNextPage = computed<boolean>(() => {
      const pages = loadedPages.value
      if (pages.length === 0) return true // haven't loaded anything yet
      return pages[pages.length - 1]!.nextCursor !== null
    })

    // Reading progress, persisted under a single key.
    const progress = signal<Progress>({ lastArticleId: null, scrollY: 0 })
    // Bookmarks — a set of article ids the user has saved. Persisted as an array.
    const bookmarks = signal<string[]>([])
    // Theme — 'light' / 'dark' / 'auto'. Persisted; defaults to auto on first visit.
    const theme = signal<Theme>('auto')

    if (ctx.deps.storage !== undefined) {
      usePersisted(ctx, 'olas-reader.progress', progress, { storage: ctx.deps.storage })
      usePersisted(ctx, 'olas-reader.bookmarks', bookmarks, { storage: ctx.deps.storage })
      usePersisted(ctx, 'olas-reader.theme', theme, { storage: ctx.deps.storage })
    } else {
      usePersisted(ctx, 'olas-reader.progress', progress)
      usePersisted(ctx, 'olas-reader.bookmarks', bookmarks)
      usePersisted(ctx, 'olas-reader.theme', theme)
    }

    const isBookmarked = (articleId: string): boolean => bookmarks.peek().includes(articleId)
    const toggleBookmark = (articleId: string): void => {
      bookmarks.update((bm) =>
        bm.includes(articleId) ? bm.filter((id) => id !== articleId) : [...bm, articleId],
      )
    }

    // Emitter for analytics events. External adapters subscribe via deps.
    const analyticsEmitter = ctx.emitter<AnalyticsEvent>()
    ctx.on(analyticsEmitter, (ev) => {
      ctx.deps.analytics?.track(ev)
    })

    const loadMore = async (): Promise<void> => {
      const pages = loadedPages.peek()
      const last = pages[pages.length - 1]
      if (last === undefined || last.nextCursor === null) return
      currentCursor.set(last.nextCursor)
      // Wait until the new page is observable. firstValue resolves on the
      // next success after the key change.
      await currentPage.firstValue()
    }

    return {
      currentPage,
      loadedPages,
      flatArticles,
      hasNextPage,
      isFetching: currentPage.isFetching,
      progress,
      bookmarks,
      theme,
      toggleBookmark,
      isBookmarked,
      loadMore,
      onArticleRead: (articleId: string): void => {
        progress.update((p) => ({ ...p, lastArticleId: articleId }))
        analyticsEmitter.emit({ articleId, ts: Date.now() })
      },
      /**
       * Construct a private composer controller for `articleId`. `ctx.attach`
       * returns `{ api, dispose }` so the caller (the React layer) can close
       * the composer and tear down its form, debounced validator timers, and
       * comments cache without waiting for the root to dispose.
       */
      openComposer: (articleId: string) => ctx.attach(composerController, { articleId }),
    }
  },
  { name: 'reader' },
)

// --- Root composition ----------------------------------------------------

const appController = defineController(
  (ctx: Ctx) => ({
    reader: ctx.child(readerController, undefined),
  }),
  { name: 'app' },
)

export function createAppRoot(deps: ReaderDeps, hydrate?: DehydratedState) {
  return createRoot(appController, {
    deps,
    onError: (err, context) => {
      deps.logger?.error(err, context)
    },
    // `hydrate?: DehydratedState` is optional — passing `undefined` is a
    // no-op (with tsconfig's `exactOptionalPropertyTypes: false`). Keeps the
    // option object a single literal without `Parameters<typeof ...>` tricks.
    hydrate,
  })
}

export type AppRoot = ReturnType<typeof createAppRoot>
export type AppApi = Omit<
  AppRoot,
  'dispose' | 'suspend' | 'resume' | 'dehydrate' | 'waitForIdle' | '__debug'
>
