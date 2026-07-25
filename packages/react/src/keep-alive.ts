import { type ReactElement, type ReactNode, useEffect, useLayoutEffect } from 'react'

export type SuspendableController = {
  suspend(): void
  resume(): void
}

// Layout effect on the client (so `resume()` runs before the first paint after
// a remount), plain effect on the server (useLayoutEffect warns during SSR and
// effects don't run there anyway).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Refcount per controller handle, shared across every `<SuspendOnUnmount>`
 * mounted on the same controller. `resume()` fires on 0→1 (first consumer),
 * `suspend()` on 1→0 (last consumer). A WeakMap so a controller that's no
 * longer referenced is collected. Module-level on purpose — two wrappers in
 * different React subtrees (a cross-fade) must share the count.
 */
const refCounts = new WeakMap<SuspendableController, number>()

/**
 * Wrap a sub-tree so unmount calls `controller.suspend()` and re-mount
 * calls `controller.resume()` instead of disposing. The React tree is
 * still unmounted (this is NOT Vue-style `<KeepAlive>` DOM preservation —
 * DOM, scroll, focus, input state are NOT retained); only the *controller*
 * stays alive and its effects pause. Use it for routed sub-trees whose
 * computed state is expensive to rebuild but whose DOM you're happy to
 * re-render. See spec §20.10.
 *
 * **Cross-fade safe.** Multiple wrappers around the same controller are
 * refcounted: `resume()` fires only when the FIRST mounts and `suspend()`
 * only when the LAST unmounts. So during a cross-fade — the entering screen
 * mounts while the exiting one is still mounted — the controller stays
 * resumed regardless of the order React runs the effects, and the exiting
 * screen's unmount can't suspend a controller the entering screen still uses
 * (T4.6). `suspend()` should still be idempotent for safety.
 */
export function SuspendOnUnmount(props: {
  controller: SuspendableController
  children: ReactNode
}): ReactElement {
  const { controller, children } = props
  useIsomorphicLayoutEffect(() => {
    const prev = refCounts.get(controller) ?? 0
    refCounts.set(controller, prev + 1)
    if (prev === 0) controller.resume() // 0 → 1: first consumer
    return () => {
      const next = (refCounts.get(controller) ?? 1) - 1
      if (next <= 0) {
        refCounts.delete(controller)
        controller.suspend() // 1 → 0: last consumer
      } else {
        refCounts.set(controller, next)
      }
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
