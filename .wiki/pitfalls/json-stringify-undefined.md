---
name: json-stringify-undefined
description: "`JSON.stringify(undefined)` returns `undefined`, not a string, and inside an object the key is dropped: a serializer typed `(value: T) => string` lies for `undefined`."
type: pitfall
covers:
  - packages/persist/src/index.ts:458-483
edges:
  - { type: related, target: ../modules/persist.md }
  - { type: tested-by, target: ../../packages/persist/tests/undefined-value.test.ts }
last_verified: 2026-09-25
confidence: medium
---

# `JSON.stringify(undefined)` is not a string

## The trap

`JSON.stringify` returns `undefined` for `undefined`, for a function and for a symbol. TypeScript's `lib.es5.d.ts` still declares the return type as `string`. So a default serializer of `JSON.stringify` passes a `(value: T) => string` check, and hands a non-string to the next line for any `T` that admits `undefined`.

Inside an object the same values are dropped: `JSON.stringify({ d: undefined })` is `'{}'`. An envelope that nests the serialized payload loses the key that held it.

`createPersisted` met both before the third 1.0 review:

- **With `version`**, the envelope `{ $olas: 1, v: N, d: inner }` lost `d` and stored `{"$olas":1,"v":N}`. That no longer looked like an envelope, so every reader deserialized it as a raw value, the object `{ $olas: 1, v: N }`.
- **Without `version`**, the escape check read `raw[0]` of `undefined` and threw a TypeError. The write was reported as `'serialize'`, storage kept the old value, and a reload brought back what the user had cleared.

## The fix

Decide what `undefined` means before calling the serializer, and give it an encoding of its own. `encodeForStorage` (`packages/persist/src/index.ts:458-468`) writes `undefined` as the marked envelope with no `d`, and `decode` (`index.ts:478-483`) maps that back to `undefined`. Then check that the serializer returned a string for every other value, and report a non-string as a serialize error rather than let it reach storage.

Pick an encoding that data stored earlier cannot collide with. For persist the bug's own output, `{"$olas":1,"v":N}`, became the encoding, so what the bug stored reads back as the `undefined` the user set.

## How to spot it

A serializer parameter with a `JSON.stringify` default, and a `T` with no bound. Test `set(undefined)` followed by a reload, with and without every option that wraps the payload.
