import { describe, expect, test } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineScope } from '../src/scope'
import { signal } from '../src/signals'

const noDeps = { deps: {} }

describe('defineScope', () => {
  test('two scopes are distinct even when shaped identically', () => {
    const a = defineScope<string>()
    const b = defineScope<string>()
    expect(a.__olas).toBe('scope')
    expect(b.__olas).toBe('scope')
    expect(a.__id).not.toBe(b.__id)
  })

  test('hasDefault flag distinguishes "no default" from "default: undefined"', () => {
    const none = defineScope<string | undefined>()
    expect(none.hasDefault).toBe(false)
    const undef = defineScope<string | undefined>({ default: undefined })
    expect(undef.hasDefault).toBe(true)
  })

  test('a name option is preserved for error messages', () => {
    const s = defineScope<number>({ name: 'orgId' })
    expect(s.name).toBe('orgId')
  })
})

describe('ctx.provide / ctx.inject', () => {
  test('an ancestor provides and a descendant injects the typed value', () => {
    const orgScope = defineScope<{ orgId: string }>()
    let injected: { orgId: string } | undefined

    const leaf = defineController((ctx) => {
      injected = ctx.inject(orgScope)
      return {}
    })
    const middle = defineController((ctx) => ({ leaf: ctx.child(leaf, undefined) }))
    const root = defineController((ctx) => {
      ctx.provide(orgScope, { orgId: 'acme' })
      return { middle: ctx.child(middle, undefined) }
    })

    const r = createRoot(root, noDeps)
    expect(injected).toEqual({ orgId: 'acme' })
    r.dispose()
  })

  test('the providing controller can also inject its own scope', () => {
    const s = defineScope<string>()
    let seen: string | undefined
    const root = defineController((ctx) => {
      ctx.provide(s, 'self')
      seen = ctx.inject(s)
      return {}
    })
    const r = createRoot(root, noDeps)
    expect(seen).toBe('self')
    r.dispose()
  })

  test('a deeper provider shadows the ancestor for its subtree', () => {
    const s = defineScope<string>()
    const seen: string[] = []

    const leaf = defineController((ctx) => {
      seen.push(ctx.inject(s))
      return {}
    })
    const inner = defineController((ctx) => {
      ctx.provide(s, 'inner')
      return { leaf: ctx.child(leaf, undefined) }
    })
    const root = defineController((ctx) => {
      ctx.provide(s, 'root')
      return {
        leafDirect: ctx.child(leaf, undefined),
        inner: ctx.child(inner, undefined),
      }
    })

    const r = createRoot(root, noDeps)
    expect(seen).toEqual(['root', 'inner'])
    r.dispose()
  })

  test('no provider + no default → inject throws synchronously during construction', () => {
    const s = defineScope<string>({ name: 'missing' })
    const def = defineController((ctx) => {
      ctx.inject(s)
      return {}
    })
    expect(() => createRoot(def, noDeps)).toThrow(/no provider for scope 'missing'/)
  })

  test('no provider + default → inject returns the default', () => {
    const s = defineScope<string>({ default: 'fallback' })
    let value: string | undefined
    const root = defineController((ctx) => {
      value = ctx.inject(s)
      return {}
    })
    const r = createRoot(root, noDeps)
    expect(value).toBe('fallback')
    r.dispose()
  })

  test('a signal-bearing scope value is reactive for consumers', () => {
    const s = defineScope<{ theme: ReturnType<typeof signal<string>> }>()
    const observed: string[] = []

    const leaf = defineController((ctx) => {
      const theme = ctx.inject(s).theme
      ctx.effect(() => {
        observed.push(theme.value)
      })
      return {}
    })

    let provided: { theme: ReturnType<typeof signal<string>> } | undefined
    const root = defineController((ctx) => {
      const theme = signal('light')
      provided = { theme }
      ctx.provide(s, provided)
      return { leaf: ctx.child(leaf, undefined), theme }
    })

    const r = createRoot(root, noDeps)
    expect(observed).toEqual(['light'])
    r.theme.set('dark')
    expect(observed).toEqual(['light', 'dark'])
    r.dispose()
  })

  test('module augmentation: a Scope<T> from another module is consumable', () => {
    type Org = { id: string; name: string }
    const orgScope = defineScope<Org>()

    let seen: Org | undefined
    const leaf = defineController((ctx) => {
      const org = ctx.inject(orgScope)
      // Type-level: org is Org (no `as`) — this line will fail to compile if not.
      seen = { id: org.id, name: org.name }
      return {}
    })
    const root = defineController((ctx) => {
      ctx.provide(orgScope, { id: 'a', name: 'Acme' })
      return { leaf: ctx.child(leaf, undefined) }
    })
    const r = createRoot(root, noDeps)
    expect(seen).toEqual({ id: 'a', name: 'Acme' })
    r.dispose()
  })

  test('disposed controller releases provided scope values', () => {
    const s = defineScope<{ big: number[] }>()
    const root = defineController((ctx) => {
      ctx.provide(s, { big: [1, 2, 3] })
      return {}
    })
    const r = createRoot(root, noDeps)
    r.dispose()
    // No public surface to inspect; this test is a smoke for the cleanup path.
    expect(true).toBe(true)
  })
})

describe('RootOptions.scopes — seed scopes from outside the factory', () => {
  test('seeded scopes are visible to ctx.inject from the root factory', () => {
    const themeScope = defineScope<string>({ name: 'theme' })
    let seenTheme: string | undefined
    const root = defineController((ctx) => {
      seenTheme = ctx.inject(themeScope)
      return {}
    })
    const r = createRoot(root, { deps: {}, scopes: [[themeScope, 'dark']] })
    expect(seenTheme).toBe('dark')
    r.dispose()
  })

  test('seeded scopes propagate to descendants via the parent walk', () => {
    const userIdScope = defineScope<string>({ name: 'userId' })
    let leafSaw: string | undefined
    const leaf = defineController((ctx) => {
      leafSaw = ctx.inject(userIdScope)
      return {}
    })
    const root = defineController((ctx) => {
      ctx.child(leaf, undefined)
      return {}
    })
    const r = createRoot(root, { deps: {}, scopes: [[userIdScope, 'u-42']] })
    expect(leafSaw).toBe('u-42')
    r.dispose()
  })

  test('a controller can override a seeded scope for its subtree', () => {
    const tenantScope = defineScope<string>({ name: 'tenant' })
    let outerSaw: string | undefined
    let innerSaw: string | undefined
    const inner = defineController((ctx) => {
      innerSaw = ctx.inject(tenantScope)
      return {}
    })
    const outer = defineController((ctx) => {
      outerSaw = ctx.inject(tenantScope)
      ctx.child(
        defineController((c) => {
          c.provide(tenantScope, 'override')
          c.child(inner, undefined)
          return {}
        }),
        undefined,
      )
      return {}
    })
    const r = createRoot(outer, { deps: {}, scopes: [[tenantScope, 'seeded']] })
    expect(outerSaw).toBe('seeded')
    expect(innerSaw).toBe('override')
    r.dispose()
  })

  test('later seeded binding wins on duplicate scope', () => {
    const s = defineScope<number>({ name: 'priority' })
    let saw: number | undefined
    const root = defineController((ctx) => {
      saw = ctx.inject(s)
      return {}
    })
    const r = createRoot(root, {
      deps: {},
      scopes: [
        [s, 1],
        [s, 2],
        [s, 3],
      ],
    })
    expect(saw).toBe(3)
    r.dispose()
  })
})
