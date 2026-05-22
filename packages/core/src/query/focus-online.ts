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

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') fireFocus()
}

let focusInstalled = false
let onlineInstalled = false

function installFocus(): void {
  if (focusInstalled) return
  if (typeof window === 'undefined') return
  window.addEventListener('focus', fireFocus)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  focusInstalled = true
}

function uninstallFocus(): void {
  if (!focusInstalled) return
  if (typeof window === 'undefined') return
  window.removeEventListener('focus', fireFocus)
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  focusInstalled = false
}

function installOnline(): void {
  if (onlineInstalled) return
  if (typeof window === 'undefined') return
  window.addEventListener('online', fireOnline)
  onlineInstalled = true
}

function uninstallOnline(): void {
  if (!onlineInstalled) return
  if (typeof window === 'undefined') return
  window.removeEventListener('online', fireOnline)
  onlineInstalled = false
}

export function subscribeWindowFocus(fn: Sub): () => void {
  installFocus()
  focusSubs.add(fn)
  return () => {
    focusSubs.delete(fn)
    if (focusSubs.size === 0) uninstallFocus()
  }
}

export function subscribeReconnect(fn: Sub): () => void {
  installOnline()
  onlineSubs.add(fn)
  return () => {
    onlineSubs.delete(fn)
    if (onlineSubs.size === 0) uninstallOnline()
  }
}

/** Test-only — force-detach global listeners regardless of subscriber state. */
export function __resetFocusOnlineForTests(): void {
  focusSubs.clear()
  onlineSubs.clear()
  uninstallFocus()
  uninstallOnline()
}
