# Example — stock-ticker (vanilla TS)

A live trading dashboard built without any UI framework. Reactivity comes from
Olas signals; DOM bindings come from `effect()` wrappers in `src/dom.ts`.

## What it shows

- **DOM bindings via `effect()`** — no React, no Vue, no template engine. `src/dom.ts:9-12` is the whole "framework."
- **`createEmitter` (via `ctx.emitter`)** — a price-tick event bus internal to the controller.
- **Reactive `ctx.effect` for subscriptions** — when the watchlist changes, the market subscriptions resubscribe automatically. The effect's dependency set is *discovered* (signal reads) rather than declared.
- **`defineQuery` with `refetchInterval`** — symbol metadata refreshes every 30s.
- **`throttled(prices, 250)`** — UI updates rate-limited; the underlying `prices` signal still updates exactly.
- **`debounced(searchInput, 200)`** — search filter waits for the user to stop typing.
- **`usePersisted`** — the watchlist survives page reloads via `localStorage`; tests use a memory adapter for round-trip assertions.
- **`createTestController`** — every behavior above is verified in `tests/controller.test.ts` with zero DOM and zero real time.

## Files

- `src/api.ts` — in-memory market simulator. Subscribe-and-callback shape; tests drive ticks via `market.tick(...)`.
- `src/controller.ts` — the entire app's behavior. No DOM imports.
- `src/dom.ts` — three small helpers: `bindText`, `bindList`, `bindInput`.
- `src/main.ts` — bootstrap: build the root, wire DOM nodes to signals.
- `tests/controller.test.ts` — tests covering emitter fan-out, reactive resubscribe, throttle coalescing, debounce, persistence (write + restore), and portfolio sum.

## Run it

```bash
pnpm install
pnpm --filter @kontsedal/olas-example-stock-ticker dev        # vite dev server
pnpm --filter @kontsedal/olas-example-stock-ticker test       # vitest
pnpm --filter @kontsedal/olas-example-stock-ticker typecheck  # tsc --noEmit
pnpm --filter @kontsedal/olas-example-stock-ticker build      # vite build → dist/
```

Then open the printed `http://localhost:5180` and watch the prices wiggle.

## Read order

1. `src/api.ts` — the fake market (skim).
2. `src/controller.ts` top to bottom — query, watchlist, emitter, effects, throttle/debounce, persistence. This is the meat.
3. `tests/controller.test.ts` — see how `createTestController` exercises the controller without a DOM or real time.
4. `src/main.ts` — DOM wiring at the end.

## Notes

- The library does not bundle `@preact/signals-core`; it's a peer dependency. The example installs it in `devDependencies` so `pnpm install` is enough.
- `setMarketForQuery(market)` is a module-level hand-off: a `defineQuery` at module scope can't read `ctx.deps`, so we expose a setter the bootstrap calls once. A real app would inject the api through `ctx.deps` everywhere (which we do for the controller itself — only the module-scoped query needs this hand-off).
- `usePersisted` falls back to `localStorageAdapter` when `ctx.deps.storage` is `undefined`. The controller branches on this so tests can substitute a memory storage and assert against `storage.store`.
