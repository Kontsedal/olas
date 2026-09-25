---
"@kontsedal/olas-core": patch
---

**`keepPreviousData` no longer shows another key's data on a disabled subscription.** A subscription that moved from key `a` to `b` and was then disabled read `a`'s data instead of `undefined`, and a re-enable on a new key bridged with `a` instead of `b`. `keepPreviousData` now covers key changes only, and `keepDataWhileDisabled` alone covers the disabled gap. The data on screen at the disable becomes the bridge for the next key. The same holds for infinite queries.
