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
    const onChange = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'hidden') {
        controller.suspend()
      } else {
        controller.resume()
      }
    }
    if (typeof document === 'undefined') return undefined
    document.addEventListener('visibilitychange', onChange)
    return () => {
      document.removeEventListener('visibilitychange', onChange)
    }
  }, [controller])
}
