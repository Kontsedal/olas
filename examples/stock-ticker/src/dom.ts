// Tiny DOM-binding helpers — adapters from `signal.value` to DOM mutations.
// The whole point of this example is that Olas works without React.

import { effect, type ReadSignal } from '@kontsedal/olas-core'

/** Reflect a signal into an element's textContent. */
export function bindText(el: HTMLElement, src: ReadSignal<string | number>): void {
  effect(() => {
    el.textContent = String(src.value)
  })
}

/**
 * Reflect a list signal into a `<ul>` (or any container). The `renderItem`
 * callback creates an element per row. Naive — we rebuild on every change.
 */
export function bindList<T>(
  parent: HTMLElement,
  src: ReadSignal<readonly T[]>,
  renderItem: (item: T, index: number) => HTMLElement,
): void {
  effect(() => {
    parent.replaceChildren(...src.value.map(renderItem))
  })
}

/** Reflect a class on/off based on a boolean signal. */
export function bindClass(el: HTMLElement, src: ReadSignal<boolean>, className: string): void {
  effect(() => {
    el.classList.toggle(className, src.value)
  })
}

/** Two-way bind: input.value ↔ a signal-like with `.set(string)`. */
export function bindInput(
  input: HTMLInputElement,
  src: {
    value: string
    set: (v: string) => void
    subscribe?: (h: (v: string) => void) => () => void
  },
): void {
  // signal → DOM. We always pull through effect() so any *future* changes
  // to the signal also reflect into the DOM (e.g. programmatic reset).
  effect(() => {
    if (src.subscribe) {
      // Force-track by reading through the subscribe contract. Caller passed
      // a real signal; this gives us full reactivity. But effect() also tracks
      // direct `.value` reads, so the simpler path below already works for
      // signals. The `subscribe` branch lets non-signal shapes still work.
    }
    if (input.value !== src.value) input.value = src.value
  })
  input.addEventListener('input', () => {
    src.set(input.value)
  })
}

/**
 * Render a sparkline as an SVG path. Takes a series of values and returns an
 * `<svg>` element sized to fit a 200×32 viewport.
 */
export function makeSparkline(values: readonly number[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 200 32')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.classList.add('sparkline')

  if (values.length < 2) {
    return svg
  }

  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min || 1

  const stepX = 200 / (values.length - 1)
  let d = ''
  for (let i = 0; i < values.length; i++) {
    const x = i * stepX
    const y = 32 - ((values[i]! - min) / range) * 30 - 1 // pad 1px top/bottom
    d += `${(i === 0 ? 'M' : ' L') + x.toFixed(1)},${y.toFixed(1)}`
  }

  const trend = values[values.length - 1]! >= values[0]!
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', trend ? 'var(--green)' : 'var(--red)')
  path.setAttribute('stroke-width', '1.4')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('stroke-linecap', 'round')
  svg.appendChild(path)
  return svg
}
