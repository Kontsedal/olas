import {
  type AmbientDeps,
  type ControllerDef,
  createRoot,
  type Root,
  type RootOptions,
} from '@kontsedal/olas-core'
import {
  type Context,
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from 'react'
import { installStreamingIntake } from './streaming'

// Claim a root in the commit, before the browser paints; plain effect on the
// server, where useLayoutEffect warns (and no effect runs anyway).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const OlasContext = createContext<Root<unknown> | null>(null)
OlasContext.displayName = 'OlasContext'

/** Props of `<OlasProvider>`. */
export type OlasProviderProps = { root: Root<unknown>; children: ReactNode }

/**
 * Provides an Olas root to descendant components. The root is created once
 * (typically in `main.tsx`) and passed through here so React doesn't own the
 * controller's lifetime — the adapter only reads. See spec §16.
 *
 * @example
 * ```tsx
 * const root = createRoot(app, { deps, queries: queryEngine() })
 *
 * export const Main = () => (
 *   <OlasProvider root={root}>
 *     <App />
 *   </OlasProvider>
 * )
 * ```
 */
export function OlasProvider(props: OlasProviderProps) {
  return createElement(OlasContext.Provider, { value: props.root }, props.children)
}

/**
 * Register the app's root type once, and `useRoot()` returns its api with no
 * type argument. Empty here: the app adds `root` through declaration merging.
 *
 * ```ts
 * const root = createRoot(appController, { deps })
 *
 * declare module '@kontsedal/olas-react' {
 *   interface Register {
 *     root: typeof root
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the app, once
export interface Register {}

/** The api `useRoot()` returns by default: the registered root's, else `unknown`. */
export type RegisteredApi = Register extends { root: Root<infer Api> } ? Api : unknown

/**
 * Resolve the root's public api from `<OlasProvider>`. Throws if called
 * outside a provider — this catches the common "I forgot to wrap" mistake at
 * the first hook call. See spec §20.10.
 *
 * The return type is the root registered through `Register`. Without a
 * registration it is `unknown`, and `useRoot<Api>()` names it per call, as an
 * unchecked cast. For several roots, `createOlasContext<Api>()` gives each its
 * own provider and a typed `useRoot`.
 */
export function useRoot<Api = RegisteredApi>(): Api {
  const root = useContext(OlasContext)
  if (root === null) {
    throw new Error('[olas] useRoot() called outside <OlasProvider>')
  }
  return root.api as Api
}

/** What `createOlasContext<Api>()` returns: a provider and `useRoot` typed to one root. */
export type OlasContext<Api> = {
  Provider: (props: { root: Root<Api>; children: ReactNode }) => ReactNode
  useRoot: () => Api
  Context: Context<Root<Api> | null>
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
export function createOlasContext<Api>(displayName?: string): OlasContext<Api> {
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
    return root.api
  }

  return { Provider, useRoot: useTypedRoot, Context }
}

/** Props of `<HydrationBoundary>`. */
export type HydrationBoundaryProps<Api> = {
  def: import('@kontsedal/olas-core').ControllerDef<void, Api>
  /**
   * Root options, with `deps` checked against `AmbientDeps` as `createRoot` checks them.
   */
  options: RootOptions<AmbientDeps>
  /**
   * When `true` (default), installs the streaming intake on mount so
   * `<script>` tags written by `createStreamingHydrator().flush()` on
   * the server route into this root. Set `false` if you're using
   * `HydrationBoundary` purely for a one-shot `options.hydrate` and
   * don't want the global `__OLAS_HYDRATION__` listener.
   */
  streaming?: boolean
  children: ReactNode
}

let warnedServerBoundary = false

/**
 * A server render runs no effects, so the unmount cleanup that disposes the
 * boundary's root never runs there. Each request would leave a root alive,
 * with its gc timers and plugins. Once per process: the mistake is in the
 * app's server entry, and one message names it.
 */
function warnServerBoundary(): void {
  if (warnedServerBoundary) return
  warnedServerBoundary = true
  console.warn(
    '[olas] <HydrationBoundary> rendered on the server. A server render runs no effects, so ' +
      'the root it builds is never disposed, and its timers outlive the request. On the ' +
      'server, create a root per request, render it through <OlasProvider root={root}>, and ' +
      'call root.dispose() after the response.',
  )
}

/**
 * How long a root built during a render may sit uncommitted, once its work is
 * idle, before it is disposed as an orphan.
 */
const ORPHAN_GRACE_MS = 10_000
/** An unclaimed root that never goes idle, such as one with a hung fetch, is disposed after this anyway. */
const ORPHAN_MAX_MS = 60_000

/**
 * A root `HydrationBoundary` built during a render that has not committed.
 * React can throw that render away: a child suspends or throws before the
 * boundary's first commit, a higher-priority update interrupts it, or the tree
 * unmounts while suspended. No effect of the boundary runs then, so nothing
 * but the sweep below disposes the root.
 */
type Uncommitted = {
  root: Root<unknown>
  /** The props object of the render that built it, or that last reused it. */
  key: object
  def: ControllerDef<void, unknown>
  options: RootOptions<AmbientDeps>
  /** Bumped on each touch and on claim, so a stale sweep stands down. */
  generation: number
  timer: ReturnType<typeof setTimeout> | undefined
  deadline: ReturnType<typeof setTimeout> | undefined
}

/** The roots no commit has claimed yet. */
const uncommitted = new Map<Root<unknown>, Uncommitted>()
/**
 * The same roots by props object. A retry of a thrown-away render reuses the
 * element, and with it the props object, so it finds its root here instead of
 * building another. Rebuilding on every retry refetched whatever the child
 * suspended on, and it suspended again, forever.
 */
const uncommittedByProps = new WeakMap<object, Uncommitted>()

let warnedRebuild = false

/** `true` when two `deps` objects hold the same members. */
function sameDeps(a: object, b: object): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k],
  )
}

/**
 * An unclaimed root built from `def` and equal options: the same `hydrate`
 * object and `deps` with the same members. A parent that renders the boundary
 * below an outer `<Suspense>` re-creates the element on every retry, so its
 * props object is new each time. Without this lookup each retry built a root
 * that refetched what the child suspended on, and the child suspended again,
 * forever. Two boundaries that share a `def` may both find one root here; the
 * commit that fails to claim it builds its own.
 */
function findReusable(
  def: ControllerDef<void, unknown>,
  options: RootOptions<AmbientDeps>,
): { reusable: Uncommitted | undefined; sameDef: boolean } {
  let sameDef = false
  for (const entry of uncommitted.values()) {
    if (entry.def !== def) continue
    sameDef = true
    if (entry.options.hydrate === options.hydrate && sameDeps(entry.options.deps, options.deps)) {
      return { reusable: entry, sameDef }
    }
  }
  return { reusable: undefined, sameDef }
}

/**
 * The root for a render with no committed root to use: the uncommitted one
 * this element, or an equal one, built on an earlier attempt, or a new one.
 */
function acquireRoot<Api>(
  key: object,
  def: ControllerDef<void, Api>,
  options: RootOptions<AmbientDeps>,
): Root<Api> {
  // The server never commits, so nothing there could claim a root, and an
  // element hoisted to module scope would hand one request's root to the
  // next. Each server render builds its own; the dev warning names the fix.
  if (typeof window === 'undefined') return createRoot(def, options) as Root<Api>
  const earlier = uncommittedByProps.get(key)
  // A root is reusable only while unclaimed: once a boundary commits it, a
  // second fiber rendering the same element builds its own.
  if (earlier !== undefined && uncommitted.get(earlier.root) === earlier) {
    armSweep(earlier)
    return earlier.root as Root<Api>
  }
  const { reusable, sameDef } = findReusable(def as ControllerDef<void, unknown>, options)
  if (reusable !== undefined) {
    reusable.key = key
    uncommittedByProps.set(key, reusable)
    armSweep(reusable)
    return reusable.root as Root<Api>
  }
  if (__DEV__ && sameDef && !warnedRebuild) {
    warnedRebuild = true
    console.warn(
      '[olas] <HydrationBoundary> built a second root for the same def before either ' +
        'committed. A parent that renders the boundary below an outer <Suspense> re-creates ' +
        'it on every retry, and its options changed between attempts (a new `hydrate` object, ' +
        'or `deps` with different members), so the retry could not reuse the earlier root and ' +
        'will refetch. Keep `hydrate` and `deps` stable across renders, or put a <Suspense> ' +
        'inside the boundary so it commits first. Two boundaries that render the same def ' +
        'with different options also see this once, harmlessly.',
    )
  }
  const root = createRoot(def, options) as Root<Api>
  const entry: Uncommitted = {
    root,
    key,
    def: def as ControllerDef<void, unknown>,
    options,
    generation: 0,
    timer: undefined,
    deadline: undefined,
  }
  uncommittedByProps.set(key, entry)
  uncommitted.set(root, entry)
  armSweep(entry)
  return root
}

/**
 * (Re)start the countdown to disposing an unclaimed root. The grace period
 * starts once the root is idle: a child suspended on the root's own fetch is
 * retried when that fetch settles, and the retry must still find the root.
 * `ORPHAN_MAX_MS` bounds the wait for idle.
 */
function armSweep(entry: Uncommitted): void {
  const generation = ++entry.generation
  clearTimeout(entry.timer)
  clearTimeout(entry.deadline)
  entry.timer = undefined
  const stillUnclaimed = (): boolean =>
    entry.generation === generation && uncommitted.get(entry.root) === entry
  const sweep = (): void => {
    if (!stillUnclaimed()) return
    uncommitted.delete(entry.root)
    uncommittedByProps.delete(entry.key)
    clearTimeout(entry.timer)
    clearTimeout(entry.deadline)
    entry.root.dispose()
  }
  entry.deadline = setTimeout(sweep, ORPHAN_MAX_MS)
  const countDown = (): void => {
    if (stillUnclaimed()) entry.timer = setTimeout(sweep, ORPHAN_GRACE_MS)
  }
  entry.root.waitForIdle().then(countDown, countDown)
}

/**
 * Take ownership of `root` in the commit. `false` when it is no longer
 * unclaimed: the sweep disposed it, another fiber rendering the same element
 * claimed it first, or StrictMode's simulated unmount disposed it after this
 * boundary claimed it.
 */
function claimRoot(root: Root<unknown>): boolean {
  const entry = uncommitted.get(root)
  if (entry === undefined) return false
  uncommitted.delete(root)
  uncommittedByProps.delete(entry.key)
  entry.generation++
  clearTimeout(entry.timer)
  clearTimeout(entry.deadline)
  return true
}

/** The root a boundary has committed, with what it was built from. */
type Owned<Api> = {
  root: Root<Api>
  def: ControllerDef<void, Api>
  options: RootOptions<AmbientDeps>
}

/**
 * Hydration boundary for SSR: constructs a `Root<Api>` once on the client
 * with the supplied `DehydratedState` (typically serialized into the HTML
 * by `root.dehydrate()` on the server), then provides it to descendants.
 *
 * Usage:
 *
 * ```tsx
 * // server: render -> root.dehydrate() -> serialize into HTML. Query data
 * // is untrusted text: `serializeForScript` escapes it for the script, so a
 * // `</script>` inside it cannot end the tag.
 * import { serializeForScript } from '@kontsedal/olas-core'
 * const html = `<script>window.__OLAS_STATE__ = ${serializeForScript(root.dehydrate())}</script>`
 *
 * // client entry: `hydrate` needs a query engine to land in.
 * <HydrationBoundary
 *   def={appController}
 *   options={{ deps, queries: queryEngine(), hydrate: window.__OLAS_STATE__ }}
 * >
 *   <App />
 * </HydrationBoundary>
 * ```
 *
 * The boundary **owns** the root: it is built during the first render, so the
 * children can read hydrated data in that render, and **disposed on unmount**.
 * `options` is read **once** on mount — a new inline `options={{...}}` on a
 * parent re-render is intentionally ignored (so the example above doesn't
 * discard cache state every render). The root is recreated only when the `def`
 * identity changes; to swap it on navigation, pass a different `def` (or
 * re-key the component).
 *
 * **A render that never commits.** A child that suspends or throws before the
 * boundary's first commit makes React discard the render, and the root with
 * it. A retry of the same element reuses that root. A root no commit claims is
 * disposed about ten seconds after its work goes idle, or after a minute if it
 * never goes idle. A `<Suspense>` above that later hides the boundary's content
 * does not dispose the root: a hide is not an unmount. A parent below an outer
 * `<Suspense>` re-creates the element on every retry; that retry reuses an
 * unclaimed root built from the same `def`, the same `hydrate` object and
 * `deps` with the same members. When those options change between attempts,
 * the retry builds a new root and refetches, and a development build warns
 * once. A `<Suspense>` inside `HydrationBoundary`, around the part that
 * suspends, avoids all of this: the boundary commits first.
 *
 * **SSR contract.** During server rendering, callers construct a per-request
 * root and pass it to `<OlasProvider root={...} />`, then dispose it after the
 * response. The `HydrationBoundary` shape is the *client-side* mirror — it
 * accepts a controller def + the dehydrated state and produces a root that
 * matches what the server rendered. Rendered on the server, it builds a root
 * that nothing disposes, because a server render runs no effects; a
 * development build warns once when that happens.
 */
export function HydrationBoundary<Api>(props: HydrationBoundaryProps<Api>): ReactNode {
  const { def, options, children, streaming = true } = props
  if (__DEV__ && typeof window === 'undefined') warnServerBoundary()

  // Written only in the commit, so a render reads the last committed root.
  const ownedRef = useRef<Owned<Api> | null>(null)
  // `options` is captured ONCE (first mount) so a new inline literal on a
  // parent re-render can't recreate the root and discard its cache.
  const optionsRef = useRef(options)
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  // A render neither disposes a root nor takes ownership of one: React can
  // discard it. `createRoot` is side-effectful (fetches, timers, focus/online
  // listeners), so an unclaimed root is tracked until a commit claims it or
  // the sweep disposes it (`acquireRoot`).
  const owned = ownedRef.current
  let root: Root<Api>
  let rootOptions: RootOptions<AmbientDeps>
  if (owned !== null && owned.def === def) {
    root = owned.root
    rootOptions = owned.options
  } else {
    // For a new `def`, the server payload in `options.hydrate` described the
    // FIRST root's tree: the replacement starts from its own fetches rather
    // than re-applying stale server state. (A StrictMode remount of the same
    // `def` still hydrates.)
    rootOptions = owned === null ? optionsRef.current : { ...owned.options, hydrate: undefined }
    root = acquireRoot(props, def, rootOptions)
  }

  // The commit claims this render's root and disposes the one it replaces.
  // When the root is no longer claimable, the boundary builds another and
  // renders again before paint, or the Provider would hand descendants a
  // disposed root. StrictMode takes that path: it simulates unmount→remount
  // without re-rendering between them, and the unmount disposed the root. A
  // dev-only double-construct is acceptable (matches TanStack).
  useIsomorphicLayoutEffect(() => {
    const current = ownedRef.current
    if (current !== null && current.root === root) return
    const next = claimRoot(root) ? root : (createRoot(def, rootOptions) as Root<Api>)
    current?.root.dispose()
    ownedRef.current = { root: next, def, options: rootOptions }
    if (next !== root) forceRender()
  }, [root])

  // Dispose on unmount. A passive effect: React runs layout-effect cleanups
  // when a Suspense boundary above hides content it already showed, and a
  // hide is not an unmount. Kept apart from the claim, whose cleanup would
  // also run when `root` changes.
  useEffect(
    () => () => {
      ownedRef.current?.root.dispose()
      ownedRef.current = null
    },
    [],
  )

  // Drain the streaming intake queue + install a live forwarder on the owned
  // root. Read `ownedRef.current` (not the rendered `root`) so a rebuilt root
  // gets the intake, never a disposed one.
  useEffect(() => {
    if (!streaming) return undefined
    const active = ownedRef.current?.root
    if (active === undefined) return undefined
    return installStreamingIntake(active)
  }, [root, streaming])

  return createElement(OlasContext.Provider, { value: root }, children)
}
