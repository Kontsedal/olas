/**
 * Lazy pub/sub for window-focus and reconnect events.
 *
 * Each `ClientEntry` with `refetchOnWindowFocus` or `refetchOnReconnect` set
 * subscribes here on its first subscriber and unsubscribes when it has none.
 * We install a single window/document listener for each event the first time
 * anyone subscribes; after that, we fan out to all subscribers ourselves.
 *
 * SSR-safe: no-ops when `window` is undefined. Spec §5.9.
 */

type Sub = () => void

const focusSubs = new Set<Sub>()
const onlineSubs = new Set<Sub>()

let focusInstalled = false
let onlineInstalled = false

function fireFocus(): void {
  for (const fn of focusSubs) {
    try {
      fn()
    } catch {
      // Subscriber failures must not break the fan-out.
    }
  }
}

function fireOnline(): void {
  for (const fn of onlineSubs) {
    try {
      fn()
    } catch {
      // ditto
    }
  }
}

function ensureFocusInstalled(): void {
  if (focusInstalled) return
  if (typeof window === 'undefined') return
  window.addEventListener('focus', fireFocus)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fireFocus()
    })
  }
  focusInstalled = true
}

function ensureOnlineInstalled(): void {
  if (onlineInstalled) return
  if (typeof window === 'undefined') return
  window.addEventListener('online', fireOnline)
  onlineInstalled = true
}

export function subscribeWindowFocus(fn: Sub): () => void {
  ensureFocusInstalled()
  focusSubs.add(fn)
  return () => {
    focusSubs.delete(fn)
  }
}

export function subscribeReconnect(fn: Sub): () => void {
  ensureOnlineInstalled()
  onlineSubs.add(fn)
  return () => {
    onlineSubs.delete(fn)
  }
}
