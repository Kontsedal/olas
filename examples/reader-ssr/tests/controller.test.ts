// Controller-level tests — pagination accumulator and analytics emitter.

import { createTestController } from '@kontsedal/olas-core/testing'
import { describe, expect, test, vi } from 'vitest'
import { createFakeApi } from '../src/api'
import { readerController } from '../src/controller'

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('readerController — pagination', () => {
  test('initial fetch lands page 0; hasNextPage true', async () => {
    const api = createFakeApi()
    const root = createTestController(readerController, {
      props: undefined,
      deps: { api },
    })
    await root.api.currentPage.firstValue()
    await flush()
    expect(root.api.flatArticles.value.length).toBe(4)
    expect(root.api.hasNextPage.value).toBe(true)
    root.dispose()
  })

  test('loadMore appends successive pages; eventually hasNextPage flips false', async () => {
    const api = createFakeApi()
    const root = createTestController(readerController, {
      props: undefined,
      deps: { api },
    })
    await root.api.currentPage.firstValue()
    await flush()
    expect(root.api.flatArticles.value.length).toBe(4)

    // 5 pages * 4 per page = 20 articles total.
    await root.api.loadMore()
    await flush()
    expect(root.api.flatArticles.value.length).toBe(8)

    await root.api.loadMore()
    await flush()
    expect(root.api.flatArticles.value.length).toBe(12)

    await root.api.loadMore()
    await flush()
    expect(root.api.flatArticles.value.length).toBe(16)

    await root.api.loadMore()
    await flush()
    expect(root.api.flatArticles.value.length).toBe(20)
    expect(root.api.hasNextPage.value).toBe(false)

    // loadMore after the end is a no-op (no api call).
    const callsBefore = api.callCount
    await root.api.loadMore()
    expect(api.callCount).toBe(callsBefore)

    root.dispose()
  })

  test('toggleBookmark add/remove + isBookmarked', async () => {
    const api = createFakeApi()
    const root = createTestController(readerController, {
      props: undefined,
      deps: { api },
    })
    await flush()
    expect(root.api.bookmarks.value).toEqual([])
    expect(root.api.isBookmarked('a1')).toBe(false)

    root.api.toggleBookmark('a1')
    expect(root.api.isBookmarked('a1')).toBe(true)
    expect(root.api.bookmarks.value).toEqual(['a1'])

    root.api.toggleBookmark('a3')
    expect(root.api.bookmarks.value).toEqual(['a1', 'a3'])

    root.api.toggleBookmark('a1') // remove
    expect(root.api.bookmarks.value).toEqual(['a3'])

    root.dispose()
  })

  test('theme persists via the injected storage adapter', async () => {
    const api = createFakeApi()
    const storage = {
      store: new Map<string, string>(),
      get(k: string) {
        return this.store.get(k) ?? null
      },
      set(k: string, v: string) {
        this.store.set(k, v)
      },
      delete(k: string) {
        this.store.delete(k)
      },
    }
    const root = createTestController(readerController, {
      props: undefined,
      deps: { api, storage: storage as any },
    })
    await flush()
    root.api.theme.set('dark')
    expect(storage.store.get('olas-reader.theme')).toBe('"dark"')
    root.dispose()
  })

  test('onArticleRead emits analytics + updates progress', async () => {
    const api = createFakeApi()
    const track = vi.fn()
    const root = createTestController(readerController, {
      props: undefined,
      deps: { api, analytics: { track } },
    })
    await root.api.currentPage.firstValue()
    await flush()

    root.api.onArticleRead('a3')
    expect(track).toHaveBeenCalledTimes(1)
    expect(track.mock.calls[0]![0]).toMatchObject({ articleId: 'a3' })
    expect(root.api.progress.value.lastArticleId).toBe('a3')

    root.dispose()
  })
})
