// Entry. Builds the root, then wires DOM nodes to signals via `effect()`.
// No frameworks involved.

import { computed, effect } from '@olas/core'
import { createFakeMarket } from './api'
import { createAppRoot } from './controller'
import { bindList, bindText, makeSparkline } from './dom'
import './styles.css'

const market = createFakeMarket({ autoTick: true })
const root = createAppRoot(market, { initialWatchlist: ['AAPL', 'MSFT', 'NVDA'] })

const totalEl   = mustEl<HTMLElement>('#total')
const wlEl      = mustEl<HTMLUListElement>('#watchlist')
const searchEl  = mustEl<HTMLInputElement>('#search')
const resultsEl = mustEl<HTMLUListElement>('#results')
const aSymEl    = mustEl<HTMLSelectElement>('#alert-symbol')
const aDirEl    = mustEl<HTMLSelectElement>('#alert-direction')
const aTgtEl    = mustEl<HTMLInputElement>('#alert-target')
const aAddEl    = mustEl<HTMLButtonElement>('#alert-add')
const alertsEl  = mustEl<HTMLUListElement>('#alerts')
const toastRoot = mustEl<HTMLElement>('#toast-root')

// --- Portfolio total -----------------------------------------------------
bindText(totalEl, root.ticker.portfolioTotal)

// --- Watchlist rows ------------------------------------------------------

type Row = { symbol: string; price: number; history: number[]; delta: number }
const watchlistRows = computed<Row[]>(() => {
  const ps = root.ticker.pricesThrottled.value
  const hs = root.ticker.historyThrottled.value
  const ds = root.ticker.deltas.value
  return root.ticker.watchlist.value.map((symbol) => ({
    symbol,
    price: ps[symbol] ?? 0,
    history: hs[symbol] ?? [],
    delta: ds[symbol] ?? 0,
  }))
})

bindList(wlEl, watchlistRows, (row) => {
  const li = document.createElement('li')
  li.className =
    'group rounded-lg border border-(--color-border) bg-(--color-bg-sunk) px-3 py-2.5 flex flex-col gap-1.5 transition hover:-translate-y-px hover:shadow-[var(--shadow-card)]'

  const header = document.createElement('div')
  header.className = 'flex items-center justify-between gap-2'

  const sym = document.createElement('span')
  sym.className = 'font-mono font-bold text-sm'
  sym.textContent = row.symbol

  const right = document.createElement('div')
  right.className = 'flex items-center gap-1.5'

  const direction = row.delta > 0.001 ? 'up' : row.delta < -0.001 ? 'down' : 'flat'
  const deltaEl = document.createElement('span')
  deltaEl.className =
    direction === 'up'
      ? 'font-mono text-[11px] font-medium px-1.5 py-0.5 rounded text-(--color-success) bg-(--color-success-bg)'
      : direction === 'down'
        ? 'font-mono text-[11px] font-medium px-1.5 py-0.5 rounded text-(--color-danger) bg-(--color-danger-bg)'
        : 'font-mono text-[11px] font-medium px-1.5 py-0.5 rounded text-(--color-fg-mute) bg-(--color-bg-elev)'
  deltaEl.textContent = `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(2)}%`

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className =
    'opacity-0 group-hover:opacity-100 text-(--color-fg-mute) hover:text-(--color-danger) text-xs px-1 transition'
  remove.textContent = '✕'
  remove.title = 'Remove from watchlist'
  remove.onclick = () => root.ticker.removeFromWatchlist(row.symbol)

  right.append(deltaEl, remove)
  header.append(sym, right)

  const spark = makeSparkline(row.history)
  spark.classList.add('block', 'h-8', 'w-full')

  const price = document.createElement('div')
  price.className = 'font-mono font-semibold text-base tabular-nums text-right'
  price.textContent = row.price > 0 ? row.price.toFixed(2) : '—'

  li.append(header, spark, price)
  return li
})

// --- Search + add to watchlist ------------------------------------------

const searchField = root.ticker.searchInput
effect(() => {
  if (searchEl.value !== searchField.value) searchEl.value = searchField.value
})
searchEl.addEventListener('input', () => searchField.set(searchEl.value))

bindList(resultsEl, root.ticker.filteredSymbols, (sym) => {
  const li = document.createElement('li')
  li.className =
    'flex items-center gap-2 px-3 py-2 border-b border-(--color-border) last:border-b-0'
  const s = document.createElement('span')
  s.className = 'font-mono font-bold text-sm'
  s.textContent = sym.symbol
  const meta = document.createElement('span')
  meta.className = 'flex-1 text-xs text-(--color-fg-mute)'
  meta.textContent = `${sym.name} · ${sym.sector}`
  const add = document.createElement('button')
  add.type = 'button'
  const alreadyIn = root.ticker.watchlist.value.includes(sym.symbol)
  if (alreadyIn) {
    add.textContent = 'Added'
    add.disabled = true
    add.className = 'rounded-md border border-(--color-border) bg-(--color-bg-sunk) px-2 py-0.5 text-[11px] text-(--color-fg-mute) cursor-not-allowed'
  } else {
    add.textContent = '+ add'
    add.className = 'rounded-md bg-(--color-accent) px-2 py-0.5 text-[11px] font-medium text-white hover:brightness-110'
    add.onclick = () => root.ticker.addToWatchlist(sym.symbol)
  }
  li.append(s, meta, add)
  return li
})

// --- Alerts form ---------------------------------------------------------

effect(() => {
  const watched = root.ticker.watchlist.value
  const previous = aSymEl.value
  aSymEl.replaceChildren(
    ...watched.map((sym) => {
      const opt = document.createElement('option')
      opt.value = sym
      opt.textContent = sym
      return opt
    }),
  )
  if (watched.includes(previous)) aSymEl.value = previous
})

aAddEl.addEventListener('click', () => {
  const symbol = aSymEl.value
  const direction = (aDirEl.value as 'above' | 'below')
  const target = parseFloat(aTgtEl.value)
  if (Number.isNaN(target)) return
  root.ticker.addAlert({ symbol, target, direction })
  aTgtEl.value = ''
})

bindList(alertsEl, root.ticker.alerts, (alert) => {
  const li = document.createElement('li')
  li.className =
    'flex items-center gap-3 rounded-md border border-(--color-border) bg-(--color-bg-sunk) px-3 py-1.5 font-mono text-xs'
  const label = document.createElement('span')
  const fired = alert.fired
  label.innerHTML = `<span class="font-bold">${alert.symbol}</span> <span class="text-(--color-fg-mute)">${alert.direction}</span> <span class="tabular-nums">${alert.target.toFixed(2)}</span>`
  const status = document.createElement('span')
  status.className = fired
    ? 'ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-(--color-success-bg) text-(--color-success)'
    : 'ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-(--color-bg-elev) text-(--color-fg-mute)'
  status.textContent = fired ? 'fired' : 'armed'
  const rm = document.createElement('button')
  rm.className = 'text-(--color-fg-mute) hover:text-(--color-danger) text-xs px-1'
  rm.type = 'button'
  rm.textContent = '✕'
  rm.onclick = () => root.ticker.removeAlert(alert.id)
  li.append(label, status, rm)
  return li
})

// --- Alert toast (via emitter) -------------------------------------------

root.ticker.alertFiredEmitter.on((ev) => {
  const toast = document.createElement('div')
  toast.className =
    'fixed left-1/2 bottom-5 -translate-x-1/2 z-50 max-w-[90vw] px-4 py-3 rounded-xl bg-(--color-warning) text-black shadow-[var(--shadow-pop)] font-mono text-sm flex items-center gap-2'
  toast.textContent = `🔔 ${ev.alert.symbol} ${ev.alert.direction} ${ev.alert.target.toFixed(2)} — now ${ev.price.toFixed(2)}`
  toastRoot.appendChild(toast)
  setTimeout(() => toast.remove(), 4500)
})

// --- Cleanup -------------------------------------------------------------

window.addEventListener('beforeunload', () => root.dispose())

function mustEl<E extends Element>(selector: string): E {
  const el = document.querySelector(selector)
  if (el === null) throw new Error(`Missing element: ${selector}`)
  return el as E
}
