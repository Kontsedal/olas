---
"@kontsedal/olas-core": patch
---

**Two form-level validators that target one field no longer erase each other's message.**

Every form routing issues onto a field wrote one shared list. An inner form's rule and an outer form's rule can both target the same field. Fixing the outer rule cleared the list, and the inner rule's still-failing message vanished: the field read `errors: []` and `isValid: true`. Each routing form now keeps its own list on the target, and the field shows them merged.
