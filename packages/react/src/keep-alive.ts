import { type ReactElement, type ReactNode, useEffect, useLayoutEffect } from 'react'

/**
 * What `<SuspendOnUnmount>` and `useSuspendOnHidden` pause: an object with
 * `suspend()` and `resume()`. The handle `ctx.attach(...)` returns fits, and
 * so does a `Root`.
 */
export type SuspendableController = {
  suspend(): void
  resume(): void
}

// Layout effect on the client (so `resume()` runs before the first paint after
// a remount), plain effect on the server (useLayoutEffect warns during SSR and
// effects don't run there anyway).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Why a controller is suspended, shared by every `<SuspendOnUnmount>` and
 * `useSuspendOnHidden` on it. `held` counts the mounted wrappers, and
 * `released` is set once the last of them unmounts. `hidden` counts the hooks
 * holding it suspended for a hidden tab. Each reason suspends as it starts,
 * and the controller resumes only when none is left. A WeakMap so a
 * controller that's no longer referenced is collected. Module-level on
 * purpose — two wrappers in different React subtrees (a cross-fade) must
 * share the count.
 */
type Reasons = { held: number; released: boolean; hidden: number }
const reasons = new WeakMap<SuspendableController, Reasons>()

const reasonsFor = (controller: SuspendableController): Reasons => {
  let r = reasons.get(controller)
  if (r === undefined) {
    r = { held: 0, released: false, hidden: 0 }
    reasons.set(controller, r)
  }
  return r
}

/** Props of `<SuspendOnUnmount>`. */
export type SuspendOnUnmountProps = { controller: SuspendableController; children: ReactNode }

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
 *
 * **Shares its bookkeeping with `useSuspendOnHidden`.** A first mount while a
 * hidden tab holds the controller suspended leaves it suspended until the tab
 * shows. Once the last wrapper unmounts, the tab showing again does not resume
 * it.
 */
export function SuspendOnUnmount(props: SuspendOnUnmountProps): ReactElement {
  const { controller, children } = props
  useIsomorphicLayoutEffect(() => {
    const r = reasonsFor(controller)
    r.released = false
    if (r.held++ === 0 && r.hidden === 0) controller.resume() // 0 → 1: first consumer
    return () => {
      if (--r.held > 0) return
      r.released = true
      controller.suspend() // 1 → 0: last consumer
    }
  }, [controller])
  return children as ReactElement
}

/**
 * Auto-suspend a controller when `document.visibilityState === 'hidden'`,
 * and resume on visible. See spec §20.10.
 *
 * The effect undoes itself on cleanup: if it is the reason the controller is
 * suspended, it resumes before it goes. Unmounting a hidden tab's subtree —
 * or swapping the `controller` argument while hidden — would otherwise leave
 * that controller suspended with nothing left listening for the
 * `visibilitychange` that was supposed to wake it.
 *
 * It shares its bookkeeping with `<SuspendOnUnmount>`, so it resumes only a
 * controller nothing else holds suspended. A controller whose last wrapper
 * unmounted while the tab was hidden stays suspended when the tab shows, and
 * when this hook's own component unmounts.
 */
export function useSuspendOnHidden(controller: SuspendableController): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const r = reasonsFor(controller)
    // Whether this effect holds the controller suspended right now.
    let suspendedHere = false
    const hold = (hidden: boolean) => {
      if (hidden === suspendedHere) return
      suspendedHere = hidden
      if (hidden) {
        r.hidden++
        controller.suspend()
      } else if (--r.hidden === 0 && !r.released) {
        controller.resume()
      }
    }
    const onChange = () => hold(document.visibilityState === 'hidden')
    // Sync once on mount. Only a hidden tab does anything: we don't call
    // `resume()` on a visible tab because the caller is responsible for
    // the controller's pre-mount state — and a stray `resume()` on an
    // already-active controller would be a no-op on a healthy
    // implementation but noisy in tests / event logs. The real bug we're
    // closing here is: mount under a hidden tab never suspends until the
    // next visibility change, which may never come.
    onChange()
    document.addEventListener('visibilitychange', onChange)
    return () => {
      document.removeEventListener('visibilitychange', onChange)
      hold(false)
    }
  }, [controller])
}
