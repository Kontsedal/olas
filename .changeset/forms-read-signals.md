---
"@kontsedal/olas-core": major
---

**`Form` and `FieldArray` are `ReadSignal`s of their value, like `Field`.** `form.value` is the form's value, not a signal holding it.

```ts
// 0.8
form.value.value
use(form.value)
form.value.subscribe(fn)

// 1.0
form.value
useValue(form)
form.subscribe(fn)
```

The same holds for a `FieldArray`: `array.value` is the array of item values, and `array.items` still holds the item nodes.

**`Form.resetWithInitial` is renamed `setAsInitial`**, matching `Field.setAsInitial`. `FieldArray` gains `set(values)` and `setAsInitial(values)`. `set` keeps the items at overlapping indices, so their touched state survives. `setAsInitial` rebuilds the items as a clean baseline that `reset()` returns to.

**`Form.submit` resolves a `SubmitResult<R>` union.** Narrow on `ok`, then on `reason`:

```ts
const result = await form.submit(save)
if (result.ok) result.data
else if (result.reason === 'error') result.error
else result.reason // 'invalid' | 'busy' | 'disposed'
```

Before, a submit that was already in flight and a disposed form both resolved `{ ok: false, error }`, and told apart only by the error message. `SubmitResult` and `SubmitOptions` are exported.
