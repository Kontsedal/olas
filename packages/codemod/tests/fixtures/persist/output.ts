import type { Ctx, Signal } from '@kontsedal/olas-core'
import * as persistNs from '@kontsedal/olas-persist'
import {
  clearPersisted,
  localStorageAdapter,
  type StorageAdapter,
  usePersisted,
} from '@kontsedal/olas-persist'

declare const ctx: Ctx
declare const theme: Signal<string>
declare const prefix: string

export const storage: StorageAdapter = localStorageAdapter()
export const deps = { localStorageAdapter: localStorageAdapter(), other: 1 }
export const viaNamespace = persistNs.localStorageAdapter()
export const typed: typeof localStorageAdapter = localStorageAdapter()
export const already = localStorageAdapter()
export const fromNamespace = persistNs.localStorageAdapter()
usePersisted(ctx, 'theme', theme, { storage: localStorageAdapter() })
export { localStorageAdapter }

clearPersisted(undefined, { all: true })
clearPersisted(localStorageAdapter(), { all: true })
clearPersisted(localStorageAdapter(), { prefix: 'app/' })
clearPersisted(storage, { prefix: `app/`, onError: (err) => void err })
clearPersisted(storage, { prefix })
clearPersisted(storage, { prefix: '' })
clearPersisted(storage, { all: true, onError: (err) => void err })
clearPersisted(storage, { prefix: 'done/' })
persistNs.clearPersisted(storage, { prefix: 'ns/' })
