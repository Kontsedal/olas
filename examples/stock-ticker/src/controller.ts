// Stock ticker controller — vanilla TS, no React.
//
// Coverage map (see .wiki/modules/examples.md):
//  - `defineQuery` + `refetchInterval`  → symbol metadata, slow refresh
//  - `ctx.emitter` + `ctx.on`           → live tick fan-out + alert events
//  - `ctx.effect` + reactive watchlist  → resubscribe when the watchlist changes
//  - `throttled(...)`                   → UI rate-limit for the prices signal
//  - `debounced(...)`                   → debounce search-as-you-type
//  - `usePersisted(ctx, key, signal)`   → watchlist + alerts survive reloads
//  - `defineController` + `createRoot`  → composition

import {
  type Ctx,
  computed,
  createRoot,
  debounced,
  defineController,
  defineQuery,
  type ReadSignal,
  signal,
  throttled,
} from '@kontsedal/olas-core'
import { type StorageAdapter, usePersisted } from '@kontsedal/olas-persist'
import {
  type Alert,
  type AlertFiredEvent,
  addAlert as addAlertPure,
  evaluateAlerts,
  removeAlert as removeAlertPure,
} from './alerts'
import type { Market, SymbolMeta, Tick } from './api'
import { detailsController } from './details'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    market: Market
    storage?: StorageAdapter
  }
}

// --- Shared query: symbol metadata, refetched on a slow interval. ---------

export const symbolsQuery = defineQuery({
  key: () => [],
  fetcher: ({ signal, deps }): Promise<SymbolMeta[]> => deps.market.getSymbols(signal),
  staleTime: 10_000,
  refetchInterval: 30_000,
})

// Re-exports so consumers can import alert types from this single module.
export type { Alert, AlertFiredEvent } from './alerts'

// --- Controller -----------------------------------------------------------

export type TickerProps = {
  initialWatchlist?: string[]
  uiThrottleMs?: number
  searchDebounceMs?: number
  /** Cap on per-symbol price history retained for sparklines. */
  historyCap?: number
}

const DEFAULTS = {
  watchlist: ['AAPL', 'MSFT', 'NVDA'],
  uiThrottleMs: 250,
  searchDebounceMs: 200,
  historyCap: 24,
}

export const tickerController = defineController(
  (ctx: Ctx, props: TickerProps) => {
    const uiThrottleMs = props.uiThrottleMs ?? DEFAULTS.uiThrottleMs
    const searchDebounceMs = props.searchDebounceMs ?? DEFAULTS.searchDebounceMs
    const historyCap = props.historyCap ?? DEFAULTS.historyCap

    const symbols = ctx.use(symbolsQuery)

    // Persisted state. `usePersisted` accepts `storage: undefined` and falls
    // back to localStorage — so tests passing `deps.storage = memoryStorage()`
    // and the browser default both work without a fork.
    const watchlist = signal<string[]>(props.initialWatchlist ?? DEFAULTS.watchlist)
    const alerts = signal<Alert[]>([])
    usePersisted(ctx, 'olas-ticker.watchlist', watchlist, { storage: ctx.deps.storage })
    usePersisted(ctx, 'olas-ticker.alerts', alerts, { storage: ctx.deps.storage })

    // Internal events: live ticks (fan-in from the market) and alert fires.
    const priceEmitter = ctx.emitter<Tick>()
    const alertFiredEmitter = ctx.emitter<AlertFiredEvent>()

    // Folded state: most-recent price + bounded history per symbol.
    const prices = signal<Record<string, number>>({})
    const history = signal<Record<string, number[]>>({})

    ctx.on(priceEmitter, (tick) => {
      const prevPrice = prices.peek()[tick.symbol]
      prices.update((p) => ({ ...p, [tick.symbol]: tick.price }))
      history.update((h) => {
        const arr = h[tick.symbol] ?? []
        const next = [...arr, tick.price].slice(-historyCap)
        return { ...h, [tick.symbol]: next }
      })

      const out = evaluateAlerts(alerts.peek(), tick, prevPrice)
      if (out.changed) {
        alerts.set(out.next)
        for (const ev of out.fired) alertFiredEmitter.emit(ev)
      }
    })

    // Subscribe to api ticks for every watched symbol. Re-runs whenever the
    // watchlist changes, cleaning up the previous unsubs.
    ctx.effect(() => {
      const watched = watchlist.value
      const unsubs = watched.map((sym) =>
        ctx.deps.market.subscribe(sym, (tick) => priceEmitter.emit(tick)),
      )
      return () => {
        for (const u of unsubs) u()
      }
    })

    // Throttled views for the UI.
    const pricesThrottled = throttled(prices, uiThrottleMs)
    const historyThrottled = throttled(history, uiThrottleMs)

    const portfolioTotal = computed(() => {
      const ps = pricesThrottled.value
      let sum = 0
      for (const sym of watchlist.value) sum += ps[sym] ?? 0
      return Math.round(sum * 100) / 100
    })

    const deltas: ReadSignal<Record<string, number>> = computed(() => {
      const h = historyThrottled.value
      const out: Record<string, number> = {}
      for (const sym of watchlist.value) {
        const arr = h[sym] ?? []
        if (arr.length < 2) {
          out[sym] = 0
          continue
        }
        const first = arr[0]!
        const last = arr[arr.length - 1]!
        out[sym] = first === 0 ? 0 : ((last - first) / first) * 100
      }
      return out
    })

    // Search input + debounced read for filtering.
    const searchInput = ctx.field<string>('')
    const searchDebounced = debounced(searchInput, searchDebounceMs)
    const filteredSymbols = computed(() => {
      const q = searchDebounced.value.trim().toLowerCase()
      const all = symbols.data.value ?? []
      if (q === '') return all
      return all.filter(
        (s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
      )
    })

    // ----- Mutators (exposed to the UI) -----
    const addToWatchlist = (sym: string): void => {
      watchlist.update((wl) => (wl.includes(sym) ? wl : [...wl, sym]))
    }
    const removeFromWatchlist = (sym: string): void => {
      watchlist.update((wl) => wl.filter((s) => s !== sym))
    }
    const addAlert = (input: Omit<Alert, 'id' | 'fired'>): void => {
      const id = `${input.symbol}-${input.direction}-${input.target}-${Date.now()}`
      alerts.update((list) => addAlertPure(list, input, id))
    }
    const removeAlert = (id: string): void => {
      alerts.update((list) => removeAlertPure(list, id))
    }

    /**
     * Construct a private `detailsController` for `symbol` via `ctx.attach`.
     * The returned `{ api, dispose }` lets the caller tear down THIS child
     * early — closing the details panel disposes its cache + tick
     * subscription immediately, instead of waiting for the parent to dispose.
     */
    const openDetails = (symbol: string) => ctx.attach(detailsController, { symbol })

    return {
      symbols,
      watchlist,
      alerts,
      prices,
      pricesThrottled,
      historyThrottled,
      deltas,
      portfolioTotal,
      searchInput,
      searchDebounced,
      filteredSymbols,
      alertFiredEmitter,
      ingestTick: (tick: Tick) => priceEmitter.emit(tick),
      addToWatchlist,
      removeFromWatchlist,
      addAlert,
      removeAlert,
      openDetails,
    }
  },
  { name: 'ticker' },
)

// --- Root composition -----------------------------------------------------

export function createAppRoot(market: Market, props: TickerProps = {}) {
  const appController = defineController(
    (ctx) => ({
      ticker: ctx.child(tickerController, props),
    }),
    { name: 'app' },
  )
  return createRoot(appController, { deps: { market } })
}

export type AppRoot = ReturnType<typeof createAppRoot>
