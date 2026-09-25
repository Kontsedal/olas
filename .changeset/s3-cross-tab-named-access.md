---
"@kontsedal/olas-cross-tab": patch
---

**A page element with the id `Bun` or `Deno` no longer turns cross-tab off.**

HTML named access makes such an element a global of that name, and the default channel factory checked those names before the `document`. It now checks the `document` first.
