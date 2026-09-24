---
"@kontsedal/olas-zod": patch
---

**`createZodForm` enforces the schema's rules on objects and arrays, and a form no longer reads valid while its schema rejects the value.**

The root form used to parse the whole schema and keep only the issues with an empty path. Three kinds of rule were dropped with no warning:

- a root `.refine(fn, { path: ['confirm'] })`;
- an array-level rule, such as `z.array(...).min(3)` or a `.refine` on the array;
- a `.refine` on a nested object.

Each issue now lands on the node its path names: the `confirm` field's `errors`, the `FieldArray`'s `topLevelErrors`, or the nested form's `topLevelErrors`. A root refine with no `path` still lands in `form.topLevelErrors`. A message the leaf's own schema reports is not repeated, so a field that fails its own `.min(1)` and a refine at the same path shows each message once. An async rule on an object is awaited. The old parse threw on one, and the form showed Zod's error in place of the rule's message.

The whole-schema parse runs on every change to the form, so `createZodForm` now installs it only when an object or an array in the schema carries a rule. A schema with rules on its leaves alone no longer parses the whole schema on each change.

A duplicate copy of `zod` now warns once per process, not once for every leaf in every form.

`rootOnlyZodValidator` is unchanged. `createZodForm` no longer uses it.
