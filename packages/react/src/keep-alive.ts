import { type ReactElement, type ReactNode, useEffect } from 'react'

export type SuspendableController = {
  suspend(): void
  resume(): void
}

/**
 * Wrap a sub-tree so unmount calls `controller.suspend()` and re-mount
 * calls `controller.resume()` instead of disposing. The React tree is
 * still unmounted (this is NOT Vue-style `<KeepAlive>` DOM preservation —
 * DOM, scroll, focus, input state are NOT retained); only the *controller*
 * stays alive and its effects pause. Use it for routed sub-trees whose
 * computed state is expensive to rebuild but whose DOM you're happy to
 * re-render. See spec §20.10.
 *
 * **Concurrency contract.** `SuspendableController.suspend()` MUST be safe
 * to call when the controller is already suspended (idempotent) and from
 * multiple consumers. Two sibling `<SuspendOnUnmount>` wrappers around the
 * same controller will overlap their `resume`/`suspend` calls during a
 * cross-fade; the controller must tolerate that.
 */
export function SuspendOnUnmount(props: {
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
 * @deprecated Renamed to `SuspendOnUnmount` — the old name implied Vue-
 * style DOM preservation which this component does NOT do. Re-exported as
 * an alias so existing call sites keep working. Will be removed in a
 * future major.
 */
export const KeepAlive = SuspendOnUnmount

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
