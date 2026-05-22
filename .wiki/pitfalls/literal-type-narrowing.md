---
name: literal-type-narrowing
description: ctx.field('') infers Field<''> because of literal narrowing. Annotate the type parameter.
type: pitfall
covers:
  - packages/core/src/controller/types.ts:114
  - packages/core/src/controller/define.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
last_verified: 2026-05-22
confidence: high
---

# `ctx.field('')` infers `Field<''>` — annotate

## The trap

```ts
const name = ctx.field('')          # infers as Field<''>, not Field<string>
name.set('Alice')                   # ERROR — '"Alice"' not assignable to '""'

const n = ctx.field(0)              # Field<0>
n.set(42)                           # ERROR — '42' not assignable to '0'
```

`ctx.field<T>(initial: T, validators?: ReadonlyArray<Validator<T>>): Field<T>` infers `T` from `initial`. TypeScript narrows literal types (`''`, `0`, `false`, etc.) to their literal form by default. The result is a Field that can only hold that exact literal value — useless.

## The fix

Annotate explicitly:

```ts
const name = ctx.field<string>('')
const n    = ctx.field<number>(0)
const flag = ctx.field<boolean>(false)
```

Or pass a non-literal initial — `let s: string = ''; ctx.field(s)` works, but the annotation form is clearer.

## Why we don't widen automatically

Two options to avoid the trap:

1. Generic widening: `field<T>(initial: T): Field<Widen<T>>` where `Widen<''>=string, Widen<0>=number, ...`. Complicates the type, and consumers who DO want a literal field (`ctx.field<'light' | 'dark'>('light')`) would lose that.
2. Make `initial` typed as `T` via a different inference position (e.g. accept a thunk that returns `T`). Awkward API.

Neither is worth it. Annotation is one extra character (`<string>`) and is grep-able.

## Where you'll hit this

- Empty-string initial fields: `ctx.field<string>('')`.
- Numeric initials that should accept any number: `ctx.field<number>(0)`.
- Pre-fill an enum-typed field with a default: `ctx.field<'light' | 'dark'>('light')`. (No annotation = `Field<'light'>`.)

If you forget, TypeScript will complain at the first `.set(otherValue)` call.

## Form schemas — the same trap, one level up

```ts
ctx.form({
  name: ctx.field(''),                       # Form<{ name: Field<''> }>  ← bad
  name: ctx.field<string>(''),               # Form<{ name: Field<string> }>  ← good
})
```

The `FormValue<S>` mapping flows the literal type through. Every leaf with a literal initial widens the whole form's type incorrectly. Catch this at the leaf level.

## See also

The form tests in `packages/core/tests/form.test.ts` use `ctx.field<string>(...)` everywhere to dodge this. Use them as a reference for new test code.
