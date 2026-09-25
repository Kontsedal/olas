---
"@kontsedal/olas-core": patch
---

**A failing sync validator no longer leaves an unhandled rejection behind.** A field, form or field array called its sync and async validators in one pass. When a sync one failed, the pass ended before the async ones settled, and the next pass or dispose aborted them with no handler attached. Clearing a field that had `required` and a `debouncedValidator` put an unhandled `AbortError` in the console. The pass now aborts the async validators it walks away from and observes their rejections, which also stops their requests early. A validator already known to be async is no longer called at all when a sync one fails; the entry on validator order has the rule.
