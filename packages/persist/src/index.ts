import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'

export type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  onChange?(handler: (key: string, value: string | null) => void): () => void
}

export type PersistOptions<T> = {
  /**
   * Storage backend. When omitted *or explicitly `undefined`* (handy for app
   * code that forwards a deps slot like `ctx.deps.storage`), the browser
   * `localStorageAdapter` is used. SSR-safe — `localStorageAdapter` no-ops
   * when `localStorage` isn't defined.
   */
  storage?: StorageAdapter | undefined
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  crossTab?: boolean
}

export type Persisted = {
  ready: ReadSignal<boolean>
}

export type PersistableSource<T> = {
  readonly value: T
  set(value: T): void
  subscribe(handler: (value: T) => void): () => void
}

/** Default localStorage adapter — only viable in the browser. */
export const localStorageAdapter: StorageAdapter = {
  get(key: string): string | null {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  },
  set(key: string, value: string): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  },
  delete(key: string): void {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  },
  onChange(handler) {
    if (typeof window === 'undefined') return () => {}
    const listener = (event: StorageEvent) => {
      if (event.key === null) return
      handler(event.key, event.newValue)
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  },
}

/**
 * Persist a signal-like source under `key`. Loads the stored value on
 * construction (sync for localStorage, async for any storage that returns a
 * promise). Subsequent writes to the source are mirrored to storage.
 *
 * Cleanup (unsubscribe + cross-tab listener removal) is bound to `ctx`.
 */
export function usePersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: PersistOptions<T>,
): Persisted {
  const storage = options?.storage ?? localStorageAdapter
  const serialize = options?.serialize ?? JSON.stringify
  const deserialize = options?.deserialize ?? JSON.parse
  const crossTab = options?.crossTab ?? false

  const ready$ = signal(false)
  let writingFromLoad = false

  // Load initial value.
  const loaded = storage.get(key)
  const applyLoaded = (raw: string | null) => {
    if (raw == null) {
      ready$.set(true)
      return
    }
    try {
      const value = deserialize(raw)
      writingFromLoad = true
      try {
        source.set(value)
      } finally {
        writingFromLoad = false
      }
    } catch {
      // Corrupted entry — ignore and continue with whatever the source had.
    }
    ready$.set(true)
  }

  if (loaded instanceof Promise) {
    loaded.then(applyLoaded, () => ready$.set(true))
  } else {
    applyLoaded(loaded)
  }

  // Persist on every CHANGE. The signal's subscribe fires immediately with
  // the current value — skip that initial call so we don't write back what
  // we just loaded (or the source's default before load).
  let skipFirstDelivery = true
  const unsub = source.subscribe((value) => {
    if (skipFirstDelivery) {
      skipFirstDelivery = false
      return
    }
    if (writingFromLoad) return
    if (!ready$.peek()) return
    try {
      const raw = serialize(value)
      const writeResult = storage.set(key, raw)
      if (writeResult instanceof Promise) {
        writeResult.catch(() => {
          /* swallow write errors — caller can supply onError via deps if they care */
        })
      }
    } catch {
      // Serialization failed; nothing to do.
    }
  })

  // Cross-tab sync.
  let unsubChange: (() => void) | null = null
  if (crossTab && storage.onChange) {
    unsubChange = storage.onChange((changedKey, rawValue) => {
      if (changedKey !== key) return
      // Storage delete in another tab (`localStorage.removeItem`) arrives as
      // `rawValue == null`. Mirror the delete locally by writing `undefined`
      // through to source — consumers whose `T` doesn't include `undefined`
      // should treat that as "value gone, fall back to initial."
      if (rawValue == null) {
        writingFromLoad = true
        try {
          source.set(undefined as T)
        } finally {
          writingFromLoad = false
        }
        return
      }
      try {
        const value = deserialize(rawValue)
        writingFromLoad = true
        try {
          source.set(value)
        } finally {
          writingFromLoad = false
        }
      } catch {
        /* ignore */
      }
    })
  }

  ctx.onDispose(() => {
    unsub()
    unsubChange?.()
  })

  return { ready: ready$ }
}
