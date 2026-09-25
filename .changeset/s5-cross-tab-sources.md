---
"@kontsedal/olas-cross-tab": patch
---

**A peer's write is applied as what it was: a guess stays a guess, and a replace is a replace.**

- A peer's optimistic write is shown as a guess of the receiving tab's own, through `host.queries.setData`. It used to arrive as a canonical write, which restarted the receiving tab's stale clock, and `persistQueryCachePlugin` stored the guess. The peer's rollback removes it. A guess the peer says nothing more about for 30 seconds is rolled back, since a tab that closes mid-mutation never settles it.
- A commit crosses, with `optimistic: true` and with `false`, and the receiving tab ends on the committed value without restarting its stale clock.
- A peer's `replace` is applied as a `replace`, so it supersedes a fetch the receiving tab has in flight. It arrived as a patch, and an older response then overwrote the record the peer had replaced.
- A canonical write made while the sender shows a guess carries the data beneath it, which the receiving tab writes as server truth. With `optimistic: false` the sender sends that data alone.
- `SetDataMessage` gains `source` and `server`. A message without `source`, as versions before 1.0 send, is applied as a write. One with a source the tab does not know, or a malformed `server`, is dropped with a warning. The devtools lane shows each setData message's `source`.
