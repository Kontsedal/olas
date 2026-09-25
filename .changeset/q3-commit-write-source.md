---
"@kontsedal/olas-core": minor
---

**Plugins hear a committed optimistic write as a new `'commit'` write source.**

`finalize()` reported nothing, so a plugin that keeps canonical sources only, such as the query-cache persister, never saw the committed value. A reload then brought back the value from before the mutation. `WriteSource` gains `'commit'`. It is reported once no optimistic write on the entry is live, so its `data` holds no pending guess. A commit made while another optimistic write is live is reported by the settle that clears the last one, a rollback included, in place of that `'rollback'`. Its `updatedAt` is when the server last answered, since a commit does not make data fresh, and `0` when it never did. Devtools see it as a `cache:set-data` with `source: 'commit'`.
