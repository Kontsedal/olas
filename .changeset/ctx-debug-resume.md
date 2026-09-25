---
"@kontsedal/olas-core": patch
---

**A `ctx.debug(...)` call while suspended reaches the devtools on resume.**

A suspended controller stored the new values but sent no event, so the panel showed the old variables until the next `ctx.debug` call after resume. `resume()` now sends one `controller:debug` event with the merged values, after `controller:resumed`. A controller that called nothing while suspended sends nothing extra.
