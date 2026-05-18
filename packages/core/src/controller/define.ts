import type { ControllerDef, Ctx } from './types'

type InternalControllerDef<Props, Api> = ControllerDef<Props, Api> & {
  readonly __factory: (ctx: Ctx, props: Props) => Api
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
): ControllerDef<Props, Api> {
  return {
    __olas: 'controller',
    __factory: factory,
  } as InternalControllerDef<Props, Api>
}

/** Internal — extracts the factory from a ControllerDef. */
export function getFactory<Props, Api>(
  def: ControllerDef<Props, Api>,
): (ctx: Ctx, props: Props) => Api {
  return (def as InternalControllerDef<Props, Api>).__factory
}
