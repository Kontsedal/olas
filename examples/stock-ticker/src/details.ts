// Per-symbol details controller.
//
// Constructed lazily by the UI when the user picks a symbol — and disposed
// when they pick a different one or close the details panel. Demonstrates
// what controllers buy you over raw signals:
//
//  - `ctx.cache(fetcher)`        — a private, controller-owned async cache.
//                                  Disposed automatically with the controller.
//  - `ctx.effect(...)`            — subscription to the live tick stream for
//                                  this single symbol, cleaned up on dispose.
//  - `ctx.onDispose(...)`         — explicit cleanup hook for arbitrary
//                                  resources (cleared timer, here).
//  - `ctx.deps.market`            — typed ambient deps, no module global.
//
// `KeepAlive` in the React layer wraps this controller so flipping between
// two symbols can either dispose-and-recreate, OR suspend/resume to preserve
// the recent-trades cache. The example uses suspend/resume.

import { type Ctx, computed, defineController, signal } from '@olas/core'
import type { Tick, Trade } from './api'

export type DetailsProps = { symbol: string }

export const detailsController = defineController(
  (ctx: Ctx, props: DetailsProps) => {
    // Private cache — only this controller subscribes; no module-level
    // sharing, no cache key gymnastics.
    const trades = ctx.cache<Trade[]>(
      (signal) => ctx.deps.market.getRecentTrades(props.symbol, signal),
      { staleTime: 30_000 },
    )

    // Local "session ticks" — the live stream for this symbol, capped.
    const sessionTicks = signal<Tick[]>([])
    const SESSION_CAP = 32

    ctx.effect(() => {
      const unsub = ctx.deps.market.subscribe(props.symbol, (tick) => {
        sessionTicks.update((arr) => [...arr.slice(-(SESSION_CAP - 1)), tick])
      })
      return unsub
    })

    // Derived: combined view sorted by ts ascending.
    const series = computed<Trade[]>(() => {
      const t = trades.data.value ?? []
      const live = sessionTicks.value.map<Trade>((tick) => ({
        symbol: tick.symbol,
        price: tick.price,
        size: 1,
        ts: tick.ts,
      }))
      return [...t, ...live].slice(-48)
    })

    // High / low over the visible window.
    const stats = computed(() => {
      const s = series.value
      if (s.length === 0) return { min: 0, max: 0, avg: 0 }
      let min = Infinity
      let max = -Infinity
      let sum = 0
      for (const t of s) {
        if (t.price < min) min = t.price
        if (t.price > max) max = t.price
        sum += t.price
      }
      return { min, max, avg: Math.round((sum / s.length) * 100) / 100 }
    })

    ctx.onDispose(() => {
      // Decorative — `ctx.cache` and `ctx.effect` already clean themselves
      // up. This hook is here to show that arbitrary teardown is supported.
      // (Real apps might log an analytics "left details for X" event here.)
    })

    return { symbol: props.symbol, trades, sessionTicks, series, stats }
  },
  { name: 'details' },
)
