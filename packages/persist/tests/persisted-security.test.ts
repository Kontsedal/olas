/**
 * A stored value that parses but that its source refuses must be reported,
 * and must not leave `ready` false forever.
 */
import { createRoot, defineController, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { createPersisted, type StorageAdapter } from '../src'

describe('createPersisted restoring a value its source refuses', () => {
  test('reports deserialize, settles ready, and keeps persisting later writes', () => {
    const store = new Map<string, string>([['sec/prefs', JSON.stringify({ theme: 'dark' })]])
    const storage: StorageAdapter = {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => {
        store.set(k, v)
      },
      delete: (k) => {
        store.delete(k)
      },
    }
    const inner = signal({ theme: 'light' })
    let refuse = true
    const source = {
      get value() {
        return inner.value
      },
      set(value: { theme: string }) {
        if (refuse) throw new TypeError('source refused the stored shape')
        inner.set(value)
      },
      subscribe: (handler: (v: { theme: string }) => void) => inner.subscribe(handler),
    }
    const onError = vi.fn()
    const root = createRoot(
      defineController((ctx) => ({
        persisted: createPersisted(ctx, 'sec/prefs', source, { storage, onError }),
      })),
      { deps: {} },
    )
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError), 'deserialize', 'sec/prefs')
    expect(root.api.persisted.ready.value).toBe(true)
    refuse = false
    source.set({ theme: 'sepia' })
    expect(JSON.parse(store.get('sec/prefs') ?? 'null')).toEqual({ theme: 'sepia' })
    root.dispose()
  })
})
