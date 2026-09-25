---
"@kontsedal/olas-core": patch
---

**`debounced` and `throttled` with a `NaN` window emit again.**

The shared timer scheduler creates no timer for a non-finite delay, `NaN` included. A `NaN` window, such as a failed `Number(...)` parse, therefore never emitted, where it used to fire at once. It now runs as `0`, with a development warning.
