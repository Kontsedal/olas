// Floating, draggable, resizable host for the DevtoolsPanel.
//
// Renders two things:
//  1. A small bottom-right launcher button (always present).
//  2. When open, a `position: fixed` window containing the panel. The header
//     is a drag handle; the south-east corner is a resize grip. Position +
//     size + open + minimized state persist to `localStorage`.
//
// API:
//   <DevtoolsLauncher root={root} />
//
// Optional props mirror DevtoolsPanel's. The launcher owns the store and the
// window chrome, and ferries the rest through.

import type { Root } from '@kontsedal/olas-core'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { Boundary, DevtoolsPanel, type DevtoolsTab, usePanelStore } from './DevtoolsPanel'
import { DEVTOOLS_CSS } from './styles'

/**
 * Props of `<DevtoolsLauncher>`: the panel's props, plus where the window
 * keeps its state and where it first opens.
 */
export type DevtoolsLauncherProps = {
  /**
   * The root to inspect. The launcher subscribes to `root.debug` on mount and
   * records until it unmounts, with the window closed or minimized too.
   */
  root: Pick<Root<unknown>, 'debug'>
  /**
   * Default panel tab.
   */
  defaultTab?: DevtoolsTab
  /**
   * Cap on each event log.
   */
  maxEntries?: number
  /**
   * Capacity of the timeline's ring buffer. Default 10,000.
   */
  maxTimelineEntries?: number
  /**
   * Persist tab+filter state under this key (independent of window state).
   */
  urlHashKey?: string
  /**
   * localStorage key for window state (position/size/open/minimized).
   */
  storageKey?: string
  /**
   * Initial position if no persisted state.
   */
  initial?: { x?: number; y?: number; w?: number; h?: number }
}

type WindowState = {
  x: number
  y: number
  w: number
  h: number
  open: boolean
  minimized: boolean
}

const MIN_W = 360
const MIN_H = 280
const HEADER_H = 30
const DEFAULT_W = 520
const DEFAULT_H = 520
const MARGIN = 16

/**
 * A floating devtools window for one root, behind a launcher button in the
 * bottom-right corner. The window's header drags it and its corner grip
 * resizes it. Position, size, and open and minimized state persist to
 * `localStorage` under `storageKey`. Render `<DevtoolsLauncher root={root} />`
 * once, near the app's root, typically only in development builds.
 *
 * The launcher owns the panel's store: it records from mount, and the
 * history survives closing and minimizing the window. A devtools error
 * never unmounts the host app; a failure outside the panel hides the launcher.
 */
export function DevtoolsLauncher(props: DevtoolsLauncherProps): ReactElement {
  return (
    <Boundary quiet>
      <Launcher {...props} />
    </Boundary>
  )
}

function Launcher(props: DevtoolsLauncherProps): ReactElement {
  const store = usePanelStore(props.root, props.maxEntries, props.maxTimelineEntries)
  const storageKey = props.storageKey ?? 'olas-devtools-window'
  const [state, setState] = useState<WindowState>(() => loadState(storageKey, props.initial))

  // Persist on change.
  useEffect(() => {
    // Reading `localStorage` itself can throw (a sandboxed iframe, blocked
    // site data), so the check sits inside the try.
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      /* storage unavailable: the window just doesn't persist */
    }
  }, [state, storageKey])

  // Clamp to viewport on window resize so a previously-saved off-screen
  // position recovers gracefully.
  useEffect(() => {
    const onResize = () => setState((s) => clampToViewport(s))
    if (typeof window === 'undefined') return
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const setOpen = useCallback((open: boolean) => setState((s) => ({ ...s, open })), [])
  const setMin = useCallback((minimized: boolean) => setState((s) => ({ ...s, minimized })), [])

  return (
    <>
      <style>{DEVTOOLS_CSS}</style>
      <LauncherButton open={state.open} onClick={() => setOpen(!state.open)} />
      {state.open && (
        <FloatingWindow
          state={state}
          setState={setState}
          onClose={() => setOpen(false)}
          onMinimize={() => setMin(!state.minimized)}
        >
          {!state.minimized && (
            <div className="olas-devtools-floating-body">
              <DevtoolsPanel
                root={props.root}
                store={store}
                defaultTab={props.defaultTab}
                urlHashKey={props.urlHashKey}
              />
            </div>
          )}
        </FloatingWindow>
      )}
    </>
  )
}

function LauncherButton({ open, onClick }: { open: boolean; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      aria-label={open ? 'Hide Olas devtools' : 'Show Olas devtools'}
      onClick={onClick}
      className={`olas-devtools-launcher ${open ? 'olas-devtools-launcher-active' : ''}`}
    >
      <span className="olas-devtools-launcher-label">Olas devtools</span>
    </button>
  )
}

function FloatingWindow(props: {
  state: WindowState
  setState: React.Dispatch<React.SetStateAction<WindowState>>
  onClose: () => void
  onMinimize: () => void
  children: ReactElement | ReactElement[] | false
}): ReactElement {
  const { state, setState, onClose, onMinimize } = props
  const dragState = useRef<{
    kind: 'move' | 'resize'
    ox: number
    oy: number
    sx: number
    sy: number
    sw: number
    sh: number
  } | null>(null)

  const onPointerDown = (kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragState.current = {
      kind,
      ox: e.clientX,
      oy: e.clientY,
      sx: state.x,
      sy: state.y,
      sw: state.w,
      sh: state.h,
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragState.current
    if (d === null) return
    const dx = e.clientX - d.ox
    const dy = e.clientY - d.oy
    if (d.kind === 'move') {
      setState((s) => clampToViewport({ ...s, x: d.sx + dx, y: d.sy + dy }))
    } else {
      const w = Math.max(MIN_W, d.sw + dx)
      const h = Math.max(MIN_H, d.sh + dy)
      setState((s) => clampToViewport({ ...s, w, h }))
    }
  }
  const onPointerUp = () => {
    dragState.current = null
  }

  const minimized = state.minimized
  const height = minimized ? HEADER_H : state.h

  return (
    <div
      className="olas-devtools-floating"
      role="dialog"
      aria-label="Olas devtools"
      style={{ left: state.x, top: state.y, width: state.w, height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="olas-devtools-floating-header" onPointerDown={onPointerDown('move')}>
        <span className="olas-devtools-floating-grip" aria-hidden="true">
          ⠿
        </span>
        <span className="olas-devtools-floating-title">Olas devtools</span>
        <div className="olas-devtools-floating-actions">
          <button
            type="button"
            aria-label={minimized ? 'Expand' : 'Minimize'}
            onClick={onMinimize}
            className="olas-devtools-floating-action"
          >
            {minimized ? '▢' : '–'}
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="olas-devtools-floating-action"
          >
            ×
          </button>
        </div>
      </div>
      {props.children}
      {!minimized && (
        <span
          className="olas-devtools-floating-resize"
          onPointerDown={onPointerDown('resize')}
          aria-label="Resize"
          role="separator"
        />
      )}
    </div>
  )
}

function clampToViewport(s: WindowState): WindowState {
  if (typeof window === 'undefined') return s
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(s.w, vw - MARGIN * 2)
  const h = Math.min(s.h, vh - MARGIN * 2)
  const x = Math.max(MARGIN, Math.min(s.x, vw - w - MARGIN))
  const y = Math.max(MARGIN, Math.min(s.y, vh - HEADER_H - MARGIN))
  return { ...s, x, y, w, h }
}

function loadState(
  storageKey: string,
  initial?: { x?: number; y?: number; w?: number; h?: number },
): WindowState {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const w = initial?.w ?? DEFAULT_W
  const h = initial?.h ?? DEFAULT_H
  const defaults: WindowState = {
    x: initial?.x ?? Math.max(MARGIN, vw - w - MARGIN),
    y: initial?.y ?? Math.max(MARGIN, vh - h - MARGIN - 56),
    w,
    h,
    open: false,
    minimized: false,
  }
  try {
    // Inside the try: reading `localStorage` can throw a SecurityError.
    if (typeof localStorage === 'undefined') return defaults
    const raw = localStorage.getItem(storageKey)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<WindowState>
    return clampToViewport({
      x: parsed.x ?? defaults.x,
      y: parsed.y ?? defaults.y,
      w: parsed.w ?? defaults.w,
      h: parsed.h ?? defaults.h,
      open: parsed.open ?? false,
      minimized: parsed.minimized ?? false,
    })
  } catch {
    return defaults
  }
}
