import type { Root } from '@kontsedal/olas-core'
import { type Context, createContext, createElement, type ReactNode, useContext } from 'react'

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
