---
"@kontsedal/olas-core": patch
"@kontsedal/olas-react": patch
---

Correct hover docs that described the wrong code, or showed an example that does not work.

In core:

- The `createField` example called `createField(ctx, '', { validators })`, which infers `Field<''>`, so the field's `set` then rejects every other string. The example now names the type, `createField<string>(...)`, as `API.md` does.
- The `createFieldArray` example used a factory that ignored its argument, so `add('x')` built an empty field. The factory now uses its `initial`.
- The `TimingSignal` doc sat above `TimingOptions`, so a hover on `TimingSignal` showed nothing. It is now on `TimingSignal`.

In React:

- The docs of `OlasProvider`, `createOlasContext`, `HydrationBoundary` and `SuspendOnUnmount` sat above their props types, so a hover on the component showed nothing. Each doc is now on its component.
- The `HydrationBoundary` example passed `hydrate` without a query engine, so a development build warned and discarded the payload. It now passes `queries: queryEngine()`.

No behavior changed.
