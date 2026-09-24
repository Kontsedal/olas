# `olas/no-react-hooks-in-controllers`

Reports a React hook called inside a `defineController` factory. In `recommended`, as an error.

## Why

A controller factory runs once, when `createRoot` or `ctx.child` constructs the controller, outside any React render. A hook called there has no component to attach to. It throws, or it binds to whichever component happens to be rendering.

The rule treats any call named `use` followed by a capital letter or a digit as a hook: `useState`, `React.useMemo`, a custom `useCart`.

## Examples

```ts
// Reported
const cart = defineController((ctx) => {
  const [items, setItems] = useState([])
  return { items }
})

// Fine: state is a signal, and a component reads it with the olas-react hooks
const cart = defineController((ctx) => {
  const items = signal<Item[]>([])
  return { items }
})
```
