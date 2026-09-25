---
"@kontsedal/olas-core": patch
---

**Binding a bigint-keyed query twice no longer crashes a development build.** The warning for a second bind with diverging call args printed the key with `JSON.stringify`, which throws on a bigint, so `createRoot` threw in development. The key now prints with a bigint written as `1n`. The check also compared call args by identity, and warned on equal args built afresh on every re-key. It now compares them by value.
