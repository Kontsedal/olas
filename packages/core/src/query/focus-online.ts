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

/**
 * Call every subscriber present when the event fired, as the DOM dispatches:
 * one added during the dispatch waits for the next event, and one removed
 * before its turn is skipped. Iterating the live set instead visits entries
 * added mid-loop. An entry parked offline re-subscribes from inside its
 * handler, so one `online` event that arrived while `navigator.onLine` still
 * read false spun without end.
 */
function fire(subs: Set<Sub>): void {
  for (const fn of [...subs]) {
    if (!subs.has(fn)) continue
    try {
      fn()
    } catch {
      // Subscriber failures must not break the fan-out.
    }
  }
}

function fireFocus(): void {
  fire(focusSubs)
}

function fireOnline(): void {
  fire(onlineSubs)
}

// A tab-return commonly fires BOTH `focus` and `visibilitychange` in the same
// tick. Coalesce them into a single `fireFocus` via a microtask flag so
// subscribers refetch once, not twice (T3.9).
let focusScheduled = false
function scheduleFocus(): void {
  if (focusScheduled) return
  focusScheduled = true
  queueMicrotask(() => {
    focusScheduled = false
    fireFocus()
  })
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') scheduleFocus()
}

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>
type DocTarget = Pick<Document, 'addEventListener' | 'removeEventListener'>

// The objects the shared listeners were installed ON. Uninstalling removes
// from these, not from whatever `window` exists at uninstall time — so a
// global swapped in between (tests stubbing `window`, a teardown after the
// environment went away) cannot strand a listener or leave the "installed"
// state stuck and block the next install.
let focusTarget: { win: Target; doc: DocTarget | undefined } | null = null
let onlineTarget: Target | null = null

function installFocus(): void {
  if (focusTarget !== null) return
  if (typeof window === 'undefined') return
  const doc = typeof document !== 'undefined' ? document : undefined
  window.addEventListener('focus', scheduleFocus)
  doc?.addEventListener('visibilitychange', onVisibilityChange)
  focusTarget = { win: window, doc }
}

function uninstallFocus(): void {
  if (focusTarget === null) return
  focusTarget.win.removeEventListener('focus', scheduleFocus)
  focusTarget.doc?.removeEventListener('visibilitychange', onVisibilityChange)
  focusTarget = null
}

function installOnline(): void {
  if (onlineTarget !== null) return
  if (typeof window === 'undefined') return
  window.addEventListener('online', fireOnline)
  onlineTarget = window
}

function uninstallOnline(): void {
  if (onlineTarget === null) return
  onlineTarget.removeEventListener('online', fireOnline)
  onlineTarget = null
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
