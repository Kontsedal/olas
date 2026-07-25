import { createRoot, type Root, type RootOptions } from '@kontsedal/olas-core'
import {
  type Context,
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from 'react'
import { installStreamingIntake } from './streaming'

const OlasContext = createContext<Root<unknown> | null>(null)
OlasContext.displayName = 'OlasContext'

/**
 * Provides an Olas root to descendant components. The root is created once
 * (typically in `main.tsx`) and passed through here so React doesn't own the
 * controller's lifetime — the adapter only reads. See spec §16.
 */
export function OlasProvider(props: { root: Root<unknown>; children: ReactNode }) {
  return createElement(OlasContext.Provider, { value: props.root }, props.children)
}

/**
 * Resolve the root's public api from `<OlasProvider>`. Throws if called
 * outside a provider — this catches the common "I forgot to wrap" mistake at
 * the first hook call. See spec §20.10.
 *
 * For multi-root apps, prefer `createOlasContext<Api>()` which returns a
 * Provider + useRoot bound to a specific api type. Casting `as Api` here
 * is unchecked.
 */
export function useRoot<Api = unknown>(): Api {
  const root = useContext(OlasContext)
  if (root === null) {
    throw new Error('[olas] useRoot() called outside <OlasProvider>')
  }
  return root as Api
}

/**
 * Back-compat alias for `useRoot()` — takes the root explicitly so it can be
 * called outside a provider (notably in tests). See spec §16, §20.10.
 */
export function useController<Api>(root: Root<Api>): Api {
  return root
}

/**
 * Mint an independent context bound to a specific `Api` type. Use when:
 *
 * - You have two or more Olas roots in the same React tree and need to
 *   route consumers to the right one (the default `useRoot<Api>()` casts
 *   unchecked across them).
 * - You want the api type baked in so call sites don't have to repeat
 *   `useRoot<MyApi>()`.
 *
 * ```ts
 * type AuthApi = { user: ReadSignal<User|null>; signIn: ... }
 * const { Provider, useRoot } = createOlasContext<AuthApi>('AuthRoot')
 *
 * <Provider root={authRoot}><App /></Provider>
 *
 * function Header() {
 *   const { user } = useRoot()      // user is ReadSignal<User|null>
 * }
 * ```
 *
 * Each call returns a *new* React context. The default `<OlasProvider>` /
 * `useRoot()` remain available for single-root apps.
 */
export function createOlasContext<Api>(displayName?: string): {
  Provider: (props: { root: Root<Api>; children: ReactNode }) => ReactNode
  useRoot: () => Api
  useController: (root: Root<Api>) => Api
  Context: Context<Root<Api> | null>
} {
  const Context = createContext<Root<Api> | null>(null)
  if (displayName !== undefined) Context.displayName = displayName

  const Provider = (props: { root: Root<Api>; children: ReactNode }): ReactNode =>
    createElement(Context.Provider, { value: props.root }, props.children)

  const useTypedRoot = (): Api => {
    const root = useContext(Context)
    if (root === null) {
      throw new Error(
        `[olas] useRoot() called outside ${displayName ?? '<OlasProvider>'}.` +
          ' Make sure the matching Provider wraps the tree.',
      )
    }
    return root
  }

  const useTypedController = (root: Root<Api>): Api => root

  return { Provider, useRoot: useTypedRoot, useController: useTypedController, Context }
}

/**
 * Hydration boundary for SSR: constructs a `Root<Api>` once on the client
 * with the supplied `DehydratedState` (typically serialized into the HTML
 * by `root.dehydrate()` on the server), then provides it to descendants.
 *
 * Usage:
 *
 * ```tsx
 * // server: render -> root.dehydrate() -> serialize into HTML
 * const dehydrated = root.dehydrate()
 * // emit: <script>window.__OLAS_STATE__ = {...dehydrated}</script>
 *
 * // client entry:
 * <HydrationBoundary
 *   def={appController}
 *   options={{ deps, hydrate: window.__OLAS_STATE__ }}
 * >
 *   <App />
 * </HydrationBoundary>
 * ```
 *
 * The boundary **owns** the root: it is created lazily during the first render
 * (in a ref, so `createRoot`'s side effects don't run twice under StrictMode)
 * and **disposed on unmount**. `options` is read **once** on mount — a new
 * inline `options={{...}}` on a parent re-render is intentionally ignored (so
 * the example above doesn't discard cache state every render). The root is
 * recreated only when the `def` identity changes; to swap it on navigation,
 * pass a different `def` (or re-key the component).
 *
 * **SSR contract.** During server rendering, callers typically construct
 * a per-request root inline and pass it to `<OlasProvider root={...} />`.
 * The `HydrationBoundary` shape is the *client-side* mirror — it accepts
 * a controller def + the dehydrated state and produces a root that
 * matches what the server rendered.
 */
export function HydrationBoundary<Api extends object>(props: {
  def: import('@kontsedal/olas-core').ControllerDef<void, Api>
  options: RootOptions<Record<string, unknown>>
  /**
   * When `true` (default), installs the streaming intake on mount so
   * `<script>` tags written by `createStreamingHydrator().flush()` on
   * the server route into this root. Set `false` if you're using
   * `HydrationBoundary` purely for a one-shot `options.hydrate` and
   * don't want the global `__OLAS_HYDRATION__` listener.
   */
  streaming?: boolean
  children: ReactNode
}): ReactNode {
  const { def, options, children, streaming = true } = props

  const rootRef = useRef<Root<Api> | null>(null)
  // `options` is captured ONCE (first mount) so a new inline literal on a
  // parent re-render can't recreate the root and discard its cache.
  const optionsRef = useRef(options)
  const defRef = useRef(def)
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  // `def` identity change → dispose the old root; a fresh one is created below.
  if (rootRef.current !== null && defRef.current !== def) {
    rootRef.current.dispose()
    rootRef.current = null
  }
  // Create lazily during render. `createRoot` is side-effectful (fetches,
  // timers, focus/online listeners), so it must NOT run in `useMemo` /
  // `useState`-initializer — StrictMode re-invokes those and orphans a live
  // root. A ref mutated in render creates exactly one root across StrictMode's
  // double render.
  if (rootRef.current === null) {
    rootRef.current = createRoot(def, optionsRef.current) as Root<Api>
    defRef.current = def
  }
  const root = rootRef.current

  // Dispose on unmount. StrictMode simulates mount→unmount→remount but does NOT
  // re-run render between the two — so when its cleanup disposes + nulls the ref
  // below, the remount setup must recreate a fresh root and force a render, or
  // the Provider would hand descendants a disposed root. A dev-only
  // double-construct is acceptable (matches TanStack).
  useEffect(() => {
    if (rootRef.current === null) {
      rootRef.current = createRoot(defRef.current, optionsRef.current) as Root<Api>
      forceRender()
    }
    return () => {
      rootRef.current?.dispose()
      rootRef.current = null
    }
  }, [])

  // Drain the streaming intake queue + install a live forwarder on the current
  // root. Read `rootRef.current` (not the closed-over `root`) so a StrictMode
  // remount installs on the fresh root, never a disposed one.
  useEffect(() => {
    if (!streaming) return undefined
    const active = rootRef.current
    if (active === null) return undefined
    return installStreamingIntake(active)
  }, [root, streaming])

  return createElement(OlasContext.Provider, { value: root }, children)
}
