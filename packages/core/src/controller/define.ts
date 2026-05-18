import type { ControllerDef, Ctx } from './types'

type InternalControllerDef<Props, Api> = ControllerDef<Props, Api> & {
  readonly __factory: (ctx: Ctx, props: Props) => Api
  readonly __name?: string
}

/** Optional configuration for `defineController`. */
export type DefineControllerOptions = {
  /**
   * A short, human-readable name for this controller — used in the devtools
   * tree, `controller:*` events, and error contexts (e.g. `["root","board[0]"]`).
   *
   * When omitted, the runtime falls back to `factory.name` (the JS-inferred
   * function name) or `"anonymous"` for arrow-function factories defined
   * inline. Naming is strongly recommended in app code.
   */
  name?: string
}

/**
 * Create a controller definition. The factory is stored on the returned object
 * and invoked during `createRoot` / `ctx.child` to build instances.
 *
 * `Props` defaults to `void` so a factory written as `(ctx) => ...` is typed
 * as `ControllerDef<void, Api>` — the form `createRoot` requires.
 */
export function defineController<Props = void, Api = unknown>(
  factory: (ctx: Ctx, props: Props) => Api,
  options?: DefineControllerOptions,
): ControllerDef<Props, Api> {
  const def: InternalControllerDef<Props, Api> = {
    __olas: 'controller',
    __factory: factory,
    ...(options?.name !== undefined ? { __name: options.name } : {}),
  } as InternalControllerDef<Props, Api>
  return def
}

/** Internal — extracts the factory from a ControllerDef. */
export function getFactory<Props, Api>(
  def: ControllerDef<Props, Api>,
): (ctx: Ctx, props: Props) => Api {
  return (def as InternalControllerDef<Props, Api>).__factory
}

/** Internal — extracts the explicit `name` option from a ControllerDef, if any. */
export function getName<Props, Api>(def: ControllerDef<Props, Api>): string | undefined {
  return (def as InternalControllerDef<Props, Api>).__name
}
