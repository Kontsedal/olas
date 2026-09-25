---
"@kontsedal/olas-core": patch
---

**A field array that churns rows no longer grows its controller.**

An item built with `createField(ctx, …)`, `createForm(ctx, …)` or `createFieldArray(ctx, …)` registers teardown on the controller. `remove`, `clear`, `set` and `reset` disposed the item but kept that registration. A hundred add and remove cycles left a hundred entries, and the root's dispose called each dropped item's `dispose` again. A disposed field, form or field array now drops its own registration.
