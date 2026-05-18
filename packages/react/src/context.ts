import type { Root } from '@olas/core'
import { type ReactNode, createContext, createElement, useContext } from 'react'

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
