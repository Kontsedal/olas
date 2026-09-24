# Example: vue-tasks (Vue 3)

A task list in Vue, with every piece of state in one Olas controller. The components under `src/components` read what the controller returns and call its actions, and nothing else.

## What it shows

- **A query in a controller.** `tasksQuery` loads the list through `deps.api`, and `App.vue` reads it with `useQuery`.
- **An optimistic write.** Ticking a box flips it at once. The `toggle` mutation's `onMutate` cancels any fetch in flight, writes the guess with `setData`, and returns the snapshot. When the server rejects the change, the runner rolls it back, and the checkbox goes back.
- **A canonical write.** Adding a task waits for the server, because the new task needs the server's id. `onSuccess` puts the returned task into the cache with `write`, so no refetch runs.
- **A validated form.** `createForm` with `required` and `maxLength` validators. `v-model` binds the field through `useField`'s writable `value`.
- **A typed `useRoot()`.** `src/root.ts` registers the root's type once, so no component names the api type.
- **Tests without a renderer.** `tests/controller.test.ts` checks every behaviour above in plain Node through `createTestController`. `tests/app.test.ts` mounts the real `App.vue` once, to show the components are only a view.

The "Fail the next change" button makes the fake server reject the next write, so the rollback can be seen.

## Files

- `src/api.ts`: the in-memory server, with latency and `failNext()`.
- `src/controller.ts`: the whole app's behaviour. No Vue imports.
- `src/root.ts`: builds the root and registers its type.
- `src/main.ts`: installs the root with `app.use(olasPlugin(root))`.
- `src/App.vue` and `src/components/*.vue`: the view.

## Run it

```bash
pnpm install
pnpm --filter @kontsedal/olas-example-vue-tasks dev        # vite dev server
pnpm --filter @kontsedal/olas-example-vue-tasks test       # vitest
pnpm --filter @kontsedal/olas-example-vue-tasks typecheck  # vue-tsc --noEmit
pnpm --filter @kontsedal/olas-example-vue-tasks build      # vite build → dist/
```

Then open the printed `http://localhost:5184`.

## Read order

1. `src/controller.ts` top to bottom. This is the app.
2. `tests/controller.test.ts`, which drives it with no DOM.
3. `src/components/TaskList.vue` and `src/components/AddTask.vue`, to see how little the view does.
