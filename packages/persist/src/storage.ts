/**
 * A key-value storage backend. `get`, `set` and `delete` may be synchronous
 * (localStorage) or return promises (IndexedDB). Shared by `createPersisted`,
 * `persistQueryCache` and `@kontsedal/olas-mutation-queue`.
 */
export type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  onChange?(handler: (key: string, value: string | null) => void): () => void
  /**
   * Optional — list every key currently in storage. Consumers that need to
   * enumerate keys (e.g. `@kontsedal/olas-mutation-queue` replaying the
   * pending queue on init) require this extension; consumers that only
   * `get` / `set` known keys (the typical `createPersisted` shape) don't need
   * it. Both built-in adapters (`localStorageAdapter()`, `indexedDbAdapter()`)
   * implement it.
   */
  keys?(): Iterable<string> | Promise<Iterable<string>>
}

/** The localStorage adapter. One object; every `localStorageAdapter()` call returns it. */
export const LOCAL_STORAGE: StorageAdapter = {
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
  keys(): string[] {
    if (typeof localStorage === 'undefined') return []
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null) out.push(k)
    }
    return out
  },
}

/**
 * The browser's `localStorage`, as a `StorageAdapter` — the default storage.
 * SSR-safe: without `localStorage` every read is `null` and every write a
 * no-op. A factory, like `indexedDbAdapter()`, so both adapters are chosen
 * the same way.
 */
export function localStorageAdapter(): StorageAdapter {
  return LOCAL_STORAGE
}
