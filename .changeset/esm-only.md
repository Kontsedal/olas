---
"@kontsedal/olas-core": major
"@kontsedal/olas-cross-tab": major
"@kontsedal/olas-devtools": major
"@kontsedal/olas-entities": major
"@kontsedal/olas-mutation-queue": major
"@kontsedal/olas-persist": major
"@kontsedal/olas-react": major
"@kontsedal/olas-realtime": major
"@kontsedal/olas-router": major
"@kontsedal/olas-zod": major
---

**ESM only, Node >= 20.19.** Every package ships one format: `dist/*.js` with `dist/*.d.ts`. The CommonJS build (`.cjs` and `.d.cts`) is gone. A CommonJS consumer can still `require()` the packages on Node 20.19 or later, which loads ES modules through `require()`. `engines.node` is `>=20.19`.

**Types.**
- Internal members no longer ship in the `.d.ts` files. That includes `Ctx`'s internals and the whole `QueryClient` class, which reached the declarations through them.
- Every type that appears in a public signature is exported. New core exports: `DebugEventBody`, `DefineControllerOptions`, `StandardSchemaV1Issue`, `StandardSchemaV1Result`, `QuerySelectOptions` and `TimingOptions`.
- New exports elsewhere:
  - react: `OlasProviderProps`, `HydrationBoundaryProps`, `SuspendOnUnmountProps`, `OlasContext`, `UseValueOptions`, `UseValueSelectOptions` and `UseFieldInputOptions`;
  - entities: `EntityOptions`;
  - zod: `UnwrapZod`.
- `isStandardSchema` and `ErrorContextInput` are no longer exported from core.
- `createQuery`'s `select` form accepts `keepDataWhileDisabled`, like the other forms.

**Bundle size.** A bundle that imports only controllers and signals no longer carries the forms code. Built from the published files, it drops from 8.6 KB to 6.4 KB gzipped.
