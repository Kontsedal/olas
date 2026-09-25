---
"@kontsedal/olas-router": patch
---

`Bridge` picks its effect by environment.

The bridge pushed router state through an unguarded `useLayoutEffect`. React 18 — the floor of the `react: ">=18"` peer range — warns on `console.error` for every server render that reaches it. The sanctioned SSR path seeds `createRouterAdapter(initial)` and never renders the `Bridge`, but a consumer's shared layout mounts it anyway. It now uses `useLayoutEffect` on the client and `useEffect` on the server. React 19 dropped the warning; client behavior is unchanged either way.
