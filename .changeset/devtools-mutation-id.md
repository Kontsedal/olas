---
"@kontsedal/olas-core": major
"@kontsedal/olas-devtools": major
---

**Devtools: mutation events carry `id`, and `inspectorPollMs` is gone.**

- **core:** the `mutation:run`, `mutation:success`, `mutation:error` and `mutation:rollback` events carried the mutation's `id` in a field named `name`. 1.0 removed `name` from mutations, so the event field now matches the spec field: `event.id`. It is absent for an inline `createMutation` spec without an `id`.
- **devtools:** `MutationEntry.name` is now `MutationEntry.mutationId`. `MutationEntry.id` already numbers the log entry, so the mutation's own id takes the longer name. The panel shows and searches the same text as before.
- **devtools:** the deprecated `DevtoolsPanelProps.inspectorPollMs` is removed. The panel ignored it: the cache inspector refreshes on every cache event, so there is no interval to set. Delete the prop.
