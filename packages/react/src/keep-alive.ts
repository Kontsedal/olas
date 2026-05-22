import { type ReactElement, type ReactNode, useEffect } from 'react'

export type SuspendableController = {
  suspend(): void
  resume(): void
}

/**
 * Wrap a sub-tree so unmount calls `controller.suspend()` and re-mount calls
 * `controller.resume()` instead of disposing. Useful for hidden tabs and
 * router caches where you want effects torn down but state preserved. See
 * spec §20.10.
 */
export function KeepAlive(props: {
  controller: SuspendableController
  children: ReactNode
}): ReactElement {
  const { controller, children } = props
  useEffect(() => {
    controller.resume()
    return () => {
      controller.suspend()
    }
  }, [controller])
  return children as ReactElement
}

/**
 * Auto-suspend a controller when `document.visibilityState === 'hidden'`,
 * and resume on visible. See spec §20.10.
 */
export function useSuspendOnHidden(controller: SuspendableController): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onChange = () => {
      if (document.visibilityState === 'hidden') {
        controller.suspend()
      } else {
        controller.resume()
      }
    }
    // Sync once on mount IFF the tab is already hidden. We don't call
    // `resume()` on a visible tab because the caller is responsible for
    // the controller's pre-mount state — and a stray `resume()` on an
    // already-active controller would be a no-op on a healthy
    // implementation but noisy in tests / event logs. The real bug we're
    // closing here is: mount under a hidden tab never suspends until the
    // next visibility change, which may never come.
    if (document.visibilityState === 'hidden') {
      controller.suspend()
    }
    document.addEventListener('visibilitychange', onChange)
    return () => {
      document.removeEventListener('visibilitychange', onChange)
    }
  }, [controller])
}
