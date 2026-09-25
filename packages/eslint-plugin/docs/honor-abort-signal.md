# `olas/honor-abort-signal`

Reports a `fetcher` or `mutate` that does not read the `signal` from its context. Opt-in: `strict` turns it on as an error, and `recommended` leaves it off.

## Why

The engine hands every fetcher and every `mutate` an `AbortSignal`. It aborts the signal when it gives up on the run:
- a newer fetch supersedes the old one;
- `cancel()` runs before an optimistic write;
- a `latest-wins` mutation starts again;
- the controller that owns a mutation or a cache is disposed.

The signal is cooperative, so a request that does not receive it runs to the end. The engine drops a superseded fetch's result and races `mutate` against the signal, so the state stays right. The network and the server still pay for the whole request, and a `latest-wins` search sends the request for each keystroke to completion.

## What it checks

- The `fetcher` of `defineQuery` and `defineInfiniteQuery`, and the fetcher passed to `createCache(ctx, fetcher)`. The context is the first parameter.
- The `mutate` of `defineMutation`, and of an inline `createMutation(ctx, { mutate })` spec. The context is the second parameter.

It reports three shapes:
- a function with no context parameter, as in `fetcher: () => fetch('/me')`;
- a context that does not give up `signal`, as in `({ deps }) => …` or `(ctx) => ctx.deps.api.load()`;
- a `signal` that is destructured and not read.

The rule checks a function written in place. A function passed by name, as in `fetcher: loadUser`, is not followed.

## Helpers that take the whole context

Syntax cannot see into a helper, so a use of the whole context object counts as passing the signal on. `getUser(ctx, id)`, `{ ...ctx }`, `ctx[key]` and a rest parameter that is read all count. A read of another property, as in `ctx.deps`, does not.

## Work with nothing to abort

A fetcher that reads local state, such as IndexedDB or a value computed in memory, has no request to pass the signal to. Name its context with a leading underscore to say so: `fetcher: (_ctx) => db.get('draft')`. The same works for a destructured signal, `{ signal: _signal }`, and for a rest parameter.

## Options

```js
'olas/honor-abort-signal': ['error', { ignorePattern: '^_' }]
```

`ignorePattern` is a regular expression, and its default is `'^_'`. The rule skips a context parameter, a `signal` binding or a rest parameter whose name matches it.

## Why it is not in `recommended`

`recommended` carries rules whose findings are bugs. This rule's findings are waste: the engine already keeps the state right when a request ignores its signal. The rule also cannot tell a request from local work. Test fixtures such as `fetcher: async () => user` are correct code, and each one would need an underscore. Turn it on alone after `recommended` with `{ rules: { 'olas/honor-abort-signal': 'error' } }`.

## Examples

```ts
// Reported: the context is taken for `deps`, and `signal` is left behind
export const user = defineQuery({
  id: 'user',
  key: (id: string) => [id],
  fetcher: ({ deps }, id: string) => deps.api.getUser(id),
})

// Fine
export const user = defineQuery({
  id: 'user',
  key: (id: string) => [id],
  fetcher: ({ signal, deps }, id: string) => deps.api.getUser(id, { signal }),
})

// Fine: the helper receives the whole context
export const user = defineQuery({
  id: 'user',
  key: (id: string) => [id],
  fetcher: (ctx, id: string) => getUser(ctx, id),
})
```
