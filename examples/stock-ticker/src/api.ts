// Fake market data — in-memory, deterministic on demand.
//
// `subscribe(symbol, handler)` mimics a WebSocket: returns an unsub. When run
// from a browser, the constructor starts a setInterval that emits random walks.
// Tests construct with `{ autoTick: false }` and drive ticks with `.tick(...)`
// so they don't depend on real time.

export type SymbolMeta = {
  symbol: string
  name: string
  sector: string
}

export type Tick = { symbol: string; price: number; ts: number }

export type Market = {
  getSymbols(signal?: AbortSignal): Promise<SymbolMeta[]>
  subscribe(symbol: string, handler: (tick: Tick) => void): () => void
  /** Test hook — drive one synthetic tick. Browsers use the timer; tests use this. */
  tick(symbol: string, price?: number): void
}

const SEED: SymbolMeta[] = [
  { symbol: 'AAPL', name: 'Apple Inc.',          sector: 'Tech'       },
  { symbol: 'MSFT', name: 'Microsoft Corp.',     sector: 'Tech'       },
  { symbol: 'GOOG', name: 'Alphabet Inc.',       sector: 'Tech'       },
  { symbol: 'NVDA', name: 'NVIDIA Corp.',        sector: 'Semis'      },
  { symbol: 'AMD',  name: 'AMD Inc.',            sector: 'Semis'      },
  { symbol: 'TSLA', name: 'Tesla Inc.',          sector: 'Autos'      },
  { symbol: 'F',    name: 'Ford Motor Co.',      sector: 'Autos'      },
  { symbol: 'JPM',  name: 'JPMorgan Chase',      sector: 'Banks'      },
  { symbol: 'GS',   name: 'Goldman Sachs',       sector: 'Banks'      },
  { symbol: 'XOM',  name: 'Exxon Mobil',         sector: 'Energy'     },
]

const STARTING_PRICES: Record<string, number> = {
  AAPL: 180, MSFT: 410, GOOG: 145, NVDA: 880, AMD: 165,
  TSLA: 240, F: 12, JPM: 195, GS: 420, XOM: 110,
}

export function createFakeMarket(options: { autoTick?: boolean } = {}): Market {
  const autoTick = options.autoTick ?? false
  const subscribers = new Map<string, Set<(tick: Tick) => void>>()
  const lastPrice: Record<string, number> = { ...STARTING_PRICES }

  let timer: ReturnType<typeof setInterval> | null = null
  const ensureTimer = () => {
    if (!autoTick || timer != null) return
    timer = setInterval(() => {
      for (const symbol of subscribers.keys()) {
        const prev = lastPrice[symbol] ?? 100
        // small random walk, ±0.5%
        const next = round2(prev * (1 + (Math.random() - 0.5) * 0.01))
        api.tick(symbol, next)
      }
    }, 800)
  }

  const api: Market = {
    async getSymbols(_signal) {
      await delay(80)
      return SEED.slice()
    },
    subscribe(symbol, handler) {
      let set = subscribers.get(symbol)
      if (!set) {
        set = new Set()
        subscribers.set(symbol, set)
      }
      set.add(handler)
      ensureTimer()
      return () => {
        set?.delete(handler)
        if (set?.size === 0) subscribers.delete(symbol)
        if (subscribers.size === 0 && timer != null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    tick(symbol, priceOverride) {
      const next = priceOverride ?? round2((lastPrice[symbol] ?? 100) * (1 + (Math.random() - 0.5) * 0.01))
      lastPrice[symbol] = next
      const handlers = subscribers.get(symbol)
      if (!handlers) return
      const tick: Tick = { symbol, price: next, ts: Date.now() }
      for (const h of handlers) h(tick)
    },
  }
  return api
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
