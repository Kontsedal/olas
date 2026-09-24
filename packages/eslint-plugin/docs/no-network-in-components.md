# `olas/no-network-in-components`

Reports `fetch` and `axios` calls inside a React component. Opt-in: `strict` turns it on, `recommended` does not.

## Why

In an Olas app a component reads state a controller owns. A `fetch` in a component duplicates what a query does: cache, dedupe, race protection and SSR. It also moves the request out of the controller tree, where tests without a renderer cannot reach it.

A component is a function whose name starts with a capital letter. `fetch` counts whether it is called bare or through `window`, `globalThis` or `self`.

## Examples

```tsx
// Reported
function Profile() {
  useEffect(() => {
    fetch('/me').then(setUser)
  }, [])
  return null
}

// Fine: the request lives in a query, and the component reads it
export const me = defineQuery({ id: 'me', key: () => [], fetcher: ({ signal }) => fetch('/me', { signal }) })
function Profile() {
  const { data } = useQuery(useRoot().me)
  return <p>{data?.name}</p>
}
```
