---
layout: home

hero:
  name: Olas
  text: Application logic with explicit lifetimes
  tagline: Controllers, queries, mutations and forms on signals. The logic runs and tests without a renderer, and React, Vue, Svelte or Preact only draws it.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Concepts
      link: /guide/concepts
    - theme: alt
      text: Migrating from 0.8
      link: /guide/migration

features:
  - title: Controllers own their lifetime
    details: A controller tree holds the state, effects, queries and forms of each screen. Dispose a branch and everything it created goes with it, with no effect cleanup to forget.
  - title: A query engine per root
    details: Shared queries with stable ids, keyed caching, deduplication, stale times, retries, infinite pagination and optimistic writes with ordered rollback. Each root has its own cache, so server requests and tests never share state.
  - title: Forms as signals
    details: Fields, forms and field arrays are signals of their value, with sync and async validators, server errors and a submit that resolves a typed result.
  - title: Tested without a DOM
    details: createTestController runs a controller with fake deps and no renderer. Test plugins mock fetches and record every cache write.
  - title: Plugins with a real contract
    details: One plugin definition serves every root. It observes writes and mutations, wraps fetches, and exposes services through scopes. Cross-tab sync, entity normalization, a durable mutation queue and cache persistence are built on it.
  - title: SSR and streaming
    details: Dehydrate a root on the server and hydrate it on the client, or stream each query's result into the page as it settles, with CSP nonces and injection only between elements.
---
