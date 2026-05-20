# @kontsedal/olas-entities

## 0.0.1-rc.1

Initial release. Entity-normalization plugin.

- `defineEntity({ name, idOf })` — declare an entity type with an id extractor.
- `entitiesPlugin([Post, User, ...])` — installs as `QueryClientPlugin`. Observes
  every `SetDataEvent` (fetch / set / remote) and walks query data to populate an
  internal normalized store plus a reverse index of (entity-id → queries holding it).
- `entities.signal(Post, id)` — `ReadSignal<Post | undefined>` for per-entity
  subscriptions. Components consume via `use(...)` from `@kontsedal/olas-react`.
- `entities.upsert(Post, raw)` — explicit branding (for events / non-query sources).
- `entities.update(Post, id, patchOrUpdater)` — accepts `Partial<T>` (shallow merge)
  OR `(prev: T) => T` (updater function). Patches every query holding the id via
  `QueryClientPluginApi.setEntryData`. Batched into one notification round.
  Warns in dev when the entity isn't in the store.
- `entities.get(Post, id)` / `entities.invalidate(Post, id)` — non-reactive read /
  store removal.
- `entities.entries(Post)` / `entities.bindings(Post, id)` — devtools snapshots of
  the normalized store and the reverse index.

Notable behaviors:
- Walker uses stack-based cycle detection (`WeakSet` of currently-descending nodes),
  so shared-reference DAGs walk both paths but true cycles still terminate.
- Path accumulator is mutable across the walk; clones happen only at binding
  boundaries (push/pop on descent/ascent).
- `bindingKey` uses the core `stableHash` (now re-exported) so Date / undefined /
  key-ordering match the QueryClient's own entry hash.
- All public methods throw when called with an `EntityDef` that wasn't passed to
  `entitiesPlugin([...])`.
- Dev builds emit a one-shot warning when a single entity partition crosses 10k
  unique ids in the slot map.
