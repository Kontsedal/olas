---
"@kontsedal/olas-core": minor
---

`refetchInterval` accepts a function of the entry's data.

```ts
type RefetchInterval<T> = number | ((data: T | undefined) => number)
```

Both `QuerySpec` and `InfiniteQuerySpec` take either form. The canonical use is the one a fixed number can't express — poll fast while there's work, slowly when there isn't:

```ts
defineQuery({
  key: () => ['jobs'],
  fetcher: async ({ signal }) => api.jobs(signal),
  refetchInterval: (jobs) => (jobs?.some((j) => j.state === 'running') ? 1_000 : 30_000),
})
```

Without it you choose between a wasteful cadence at rest and a sluggish one under load, or you run a second timer beside the query and race it.

The thunk is resolved **once per scheduling decision** — on each tick, for the *next* gap — against the entry's latest data, read without subscribing. So it isn't reactive: a signal read inside yields that tick's value and registers no dependency. Its first call is synchronous at the 0→1 subscribe, before the initial fetch settles, so it must handle `data === undefined`. For infinite queries the argument is the entry's pages array (`TPage[] | undefined`).

A resolved gap must be a positive finite number. `0` / `NaN` / negative / `Infinity` stops the timer for that entry with a dev warning instead of spinning a fetch-per-macrotask loop; once stopped it restarts only on the entry's next 0→1 subscriber transition (a subscriber joining an entry that still has others does not re-arm it). A thunk that **throws** is handled the same way — chain stopped, dev warning naming the throw and carrying the error — rather than escaping the timer callback, where it would end polling permanently with nothing but an uncaught error to show for it.

It is deliberately **per cache entry, not per subscriber** — the timer belongs to the shared entry, so ten controllers on one key share one interval. That's why `UseOptions` still has no `refetchInterval` (per-subscriber intervals would need a "whose interval wins" rule) and why `DefaultQueryOptions` still excludes it. `ctx.cache` / `LocalCache` has no interval mechanism and doesn't gain one here.

Internally both interval timers became a self-rescheduling `setTimeout` chain, since a fixed-period timer can't re-ask for its period. The cadence stays a metronome (a fetch slower than the gap doesn't stretch the schedule), and the hidden-tab skip, in-flight skip and suspend-pause behave as before. SPEC §5.9 carries the contract.

**Two changes to disclose**, both narrow:

- *An invalid numeric literal no longer polls.* The positive-finite rule binds the resolved gap, so it also binds a literal — `refetchInterval: 0` (or `NaN`, or negative) now warns once and never arms, where `setInterval(fn, 0)` used to clamp to about one tick and refetch every macrotask. Any code relying on that was asking for a hot loop, but the runaway fetching would have been visible, and its absence is also visible.
- *`QuerySpec<Args, T>` is now invariant in `T`.* The thunk puts `T` in a function-parameter position, so `QuerySpec<[], Dog>` no longer flows into a `QuerySpec<[], Animal>` slot. Blast radius is small: `defineQuery` infers `T` from the fetcher, which is the normal path and is unaffected; only code that writes the type explicitly and relies on assignability between two instantiations is touched.
