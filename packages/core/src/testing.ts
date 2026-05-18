import { createRootWithProps } from './controller/root'
import type { ControllerDef, Root, RootOptions } from './controller/types'

/**
 * Construct an isolated root wrapping a single controller. The returned object
 * is the controller's api plus the standard Root lifecycle controls
 * (`dispose`, `suspend`, `resume`, `__debug`).
 *
 * Equivalent to defining a tiny root wrapper, but ergonomic in tests.
 */
export function createTestController<
  Props,
  Api,
  TDeps extends Record<string, unknown> = Record<string, unknown>,
>(
  def: ControllerDef<Props, Api>,
  options: {
    deps: TDeps
    props: Props
    onError?: RootOptions<TDeps>['onError']
  },
): Root<Api> {
  return createRootWithProps<Props, Api, TDeps>(def, options.props, {
    deps: options.deps,
    onError: options.onError,
  })
}
