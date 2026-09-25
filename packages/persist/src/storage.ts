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

/**
 * The global `localStorage`, or `undefined` where there is none. Reading the
 * global throws a SecurityError in a sandboxed iframe and in a browser that
 * blocks site data, and `typeof` does not guard a getter that throws. Such a
 * storage counts as missing, as on a server.
 */
function webStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** The localStorage adapter. One object; every `localStorageAdapter()` call returns it. */
export const LOCAL_STORAGE: StorageAdapter = {
  get(key: string): string | null {
    return webStorage()?.getItem(key) ?? null
  },
  set(key: string, value: string): void {
    webStorage()?.setItem(key, value)
  },
  delete(key: string): void {
    webStorage()?.removeItem(key)
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
    const ls = webStorage()
    if (ls === undefined) return []
    const out: string[] = []
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k !== null) out.push(k)
    }
    return out
  },
}

/**
 * The browser's `localStorage`, as a `StorageAdapter` — the default storage.
 * SSR-safe: without `localStorage` every read is `null` and every write a
 * no-op. A `localStorage` that throws when the page reads it, as in a
 * sandboxed iframe, counts as missing. A factory, like `indexedDbAdapter()`,
 * so both adapters are chosen the same way.
 */
export function localStorageAdapter(): StorageAdapter {
  return LOCAL_STORAGE
}
