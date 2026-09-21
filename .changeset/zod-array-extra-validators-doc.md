---
"@kontsedal/olas-zod": patch
---

Correct what an `extraValidators` path means at an array.

The doc said a path of `'tags'` matched the `FieldArray` and applied to the array as a whole. It never did: a path names a position in the schema, an array contributes no segment to it, and the walker hands the same path to every element. So `'tags'` validates each tag, and `'tags.name'` validates each item's `name`. The doc now says that, and a test pins it. No behavior changed.

There is no path that addresses the `FieldArray` itself, which the doc now also says. An array-level rule takes a `FieldArrayValidator` over the whole item list, a different signature that `formFromZod` does not wire. Express those in the Zod schema (`z.array(...).min(3)`) instead.
