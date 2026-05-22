import { createRoot, type DehydratedState, type Root } from '@kontsedal/olas-core'
import {
  type Context,
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
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
 * The root is memoized against `def` and `options` reference equality, so
 * the boundary must be mounted once at the tree root. To replace the root
 * on navigation, re-key the component or wrap in your own factory.
 *
 * **SSR contract.** During server rendering, callers typically construct
 * a per-request root inline and pass it to `<OlasProvider root={...} />`.
 * The `HydrationBoundary` shape is the *client-side* mirror — it accepts
 * a controller def + the dehydrated state and produces a root that
 * matches what the server rendered.
 */
export function HydrationBoundary<Api>(props: {
  def: import('@kontsedal/olas-core').ControllerDef<void, Api>
  options: {
    deps: Record<string, unknown>
    hydrate?: DehydratedState
    onError?: (err: unknown, ctx: unknown) => void
    scopes?: ReadonlyArray<readonly [unknown, unknown]>
    plugins?: ReadonlyArray<unknown>
  }
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
  // Construct once per (def, options) identity. The caller controls
  // identity — pass stable refs for stable roots, mutate to remount.
  const root = useMemo(() => createRoot(def, options as any) as Root<Api>, [def, options])
  // Drain the streaming intake queue + install a live forwarder. The
  // first mount per page picks up everything the server flushed before
  // the bundle loaded; subsequent stream pushes go straight through.
  useEffect(() => {
    if (!streaming) return undefined
    return installStreamingIntake(root)
  }, [root, streaming])
  return createElement(OlasContext.Provider, { value: root }, children)
}
