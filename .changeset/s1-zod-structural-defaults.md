---
"@kontsedal/olas-zod": patch
---

**zod: `createZodForm` honours `.default(...)` on arrays and objects.**

`tags: z.array(z.string()).default(['inbox'])` used to start as `[]`, and `address: z.object({ city }).default({ city: 'Kyiv' })` as `{ city: '' }`, while `schema.parse({})` gave the defaults. The field array and the nested form now start from them, and `reset()` returns to them. An `initial` value for the key still wins.
