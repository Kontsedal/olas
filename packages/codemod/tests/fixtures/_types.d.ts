// Minimal stubs of the Olas 0.8 public types, for the codemod fixtures. They
// carry the members the type-driven transforms look for, and little else.

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [name: string]: any
  }
}

declare module '@kontsedal/olas-core' {
  export type ReadSignal<T> = {
    readonly value: T
    peek(): T
    subscribe(fn: (value: T) => void): () => void
  }
  export type Signal<T> = ReadSignal<T> & { value: T; set(value: T): void }
  export type Computed<T> = ReadSignal<T>
  export function signal<T>(initial: T): Signal<T>
  export function computed<T>(fn: () => T): Computed<T>

  export interface AmbientDeps {
    [key: string]: unknown
  }

  export type Validator<T> = (value: T) => string | null
  export function required(): Validator<any>

  export type Field<T> = ReadSignal<T> & {
    errors: ReadSignal<string[]>
    set(value: T): void
    setAsInitial(value: T): void
    reset(): void
  }
  export type FormSchema = Record<string, Field<any> | Form<any> | FieldArray<any>>
  export type Form<S extends FormSchema> = {
    readonly fields: S
    readonly value: ReadSignal<{ [K in keyof S]: unknown }>
    readonly isValid: ReadSignal<boolean>
    set(partial: unknown): void
    resetWithInitial(partial: unknown): void
    reset(): void
    markAllTouched(): void
    submit<R>(
      handler: (value: unknown) => R | Promise<R>,
    ): Promise<{ ok: boolean; data?: Awaited<R>; error?: unknown }>
  }
  export type FieldArray<I> = {
    readonly items: ReadSignal<readonly I[]>
    readonly value: ReadSignal<unknown[]>
    add(initial?: unknown): void
    insert(index: number, initial?: unknown): void
    remove(index: number): void
    move(from: number, to: number): void
  }

  export type AsyncState<T> = {
    data: ReadSignal<T | undefined>
    isFetching: ReadSignal<boolean>
    refetch(): Promise<T>
    firstValue(): Promise<T>
    promise(): Promise<T>
  }
  export type QuerySubscription<T> = AsyncState<T>
  export type LocalCache<T> = AsyncState<T>
  export type Query<Args extends unknown[], T> = {
    readonly __olas: 'query'
    invalidate(...args: Args): Promise<void>
    __t?: T
  }
  export type InfiniteQuery<Args extends unknown[], TPage> = {
    readonly __olas: 'infiniteQuery'
    __t?: [Args, TPage]
  }
  export type DefaultQueryOptions = { staleTime?: number; retry?: number }
  export type UseOptions<Args> = { key?: () => Args; enabled?: () => boolean }
  export function defineQuery<Args extends unknown[], T>(spec: {
    queryId?: string
    key: (...args: Args) => unknown[]
    fetcher: (ctx: { signal: AbortSignal }, ...args: Args) => Promise<T>
    crossTab?: boolean | 'data'
    staleTime?: number
  }): Query<Args, T>
  export function defineInfiniteQuery<Args extends unknown[], TPage>(spec: any): InfiniteQuery<Args, TPage>

  export type Mutation<V, R> = {
    run(vars: V): Promise<R>
    isPending: ReadSignal<boolean>
    reset(): void
    __t?: [V, R]
  }
  export type MutationSpec<V, R> = {
    name?: string
    mutationId?: string
    persist?: boolean
    mutate: (vars: V, signal: AbortSignal) => Promise<R>
    onMutate?: (vars: V) => unknown
    onSuccess?: (result: R, vars: V) => void
    onError?: (err: unknown, vars: V) => void
    onSettled?: () => void
    concurrency?: 'parallel' | 'latest-wins' | 'serial'
  }
  export type MutationDef<V, R> = MutationSpec<V, R> & {
    readonly __olas: 'mutation'
    readonly mutationId: string
  }
  export function defineMutation<V, R>(spec: MutationSpec<V, R> & { mutationId: string }): MutationDef<V, R>
  export class MutationDisposedError extends Error {
    readonly mutationName: string
    readonly controllerPath: readonly string[]
  }

  export type ErrorContext = {
    kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'
    controllerPath: readonly string[]
    queryKey?: readonly unknown[]
    eventId: string
    timestamp: number
  }
  export type ErrorContextInput = Omit<ErrorContext, 'eventId' | 'timestamp'>
  export function isStandardSchema(value: unknown): boolean

  export type Emitter<T> = { emit(value: T): void }
  export type ControllerDef<Props, Api> = {
    readonly __olas: 'controller'
    readonly __types?: { props: Props; api: Api }
  }
  export type Ctx<TDeps = AmbientDeps> = {
    readonly deps: TDeps
    field<T>(initial: T, validators?: ReadonlyArray<Validator<T>>, options?: { validateOn?: 'change' | 'blur' }): Field<T>
    form<S extends FormSchema>(schema: S, options?: unknown): Form<S>
    fieldArray<I>(factory: (initial?: unknown) => I, options?: unknown): FieldArray<I>
    cache<T>(fetcher: (signal: AbortSignal) => Promise<T>, options?: unknown): LocalCache<T>
    use<Args extends unknown[], T>(query: Query<Args, T>, key?: () => Args): QuerySubscription<T>
    mutation<V, R>(spec: MutationSpec<V, R>): Mutation<V, R>
    signal<T>(initial: T): Signal<T>
    computed<T>(fn: () => T): Computed<T>
    emitter<T>(): Emitter<T>
    child<P, A>(def: ControllerDef<P, A>, props: P): A
    attach<P, A>(def: ControllerDef<P, A>, props: P): { api: A; dispose(): void }
    session<P, A>(def: ControllerDef<P, A>, props: P): readonly [A, () => void]
    effect(fn: () => void | (() => void)): void
    onDispose(fn: () => void): void
  }
  export function defineController<Props, Api>(factory: (ctx: Ctx, props: Props) => Api): ControllerDef<Props, Api>

  export type DehydratedState = { version: number; entries: unknown[] }
  export type DebugBus = { subscribe(fn: (event: unknown) => void): () => void }
  export type Scope<T> = { readonly __id: symbol; __t?: T }
  export type RootOptions<TDeps> = {
    deps: TDeps
    onError?: (err: unknown, context: ErrorContext) => void
    hydrate?: DehydratedState
    refetchOnWindowFocus?: boolean
    refetchOnReconnect?: boolean
    defaultQueryOptions?: DefaultQueryOptions
    plugins?: QueryClientPlugin[]
    scopes?: ReadonlyArray<readonly [Scope<unknown>, unknown]>
  }
  export type Root<Api> = Api & {
    dispose(): void
    suspend(options?: { maxIdle?: number }): void
    resume(): void
    dehydrate(): DehydratedState
    waitForIdle(): Promise<void>
    applyDehydratedEntry(queryId: string, keyArgs: readonly unknown[], data: unknown, at: number): void
    readonly __debug: DebugBus
  }
  export function createRoot<Api, TDeps>(def: ControllerDef<void, Api>, options: RootOptions<TDeps>): Root<Api>

  export type Selection<T> = { isSelected(id: string): boolean; __t?: T }
  export function selection<T = unknown>(options?: { initial?: readonly string[] }): Selection<T>

  export type QueryClientPlugin = { name?: string; init(api: QueryClientPluginApi): void }
  export type QueryClientPluginApi = { setData(queryId: string, key: unknown[], data: unknown): void }
  export type SetDataEvent = { queryId: string }
  export type InvalidateEvent = { queryId: string }
  export type GcEvent = { queryId: string }
  export type MutationEnqueueEvent = { mutationId: string }
  export type MutationSettleEvent = { mutationId: string }
  export type RegisteredQuery = { queryId: string }
  export type RegisteredMutation = { mutationId: string }
  export function lookupRegisteredQuery(id: string): RegisteredQuery | undefined
  export function lookupRegisteredMutation(id: string): RegisteredMutation | undefined
  export function stableHash(value: unknown): string
}

declare module '@kontsedal/olas-core/testing' {
  import type { ControllerDef, DefaultQueryOptions, Root } from '@kontsedal/olas-core'
  export function createTestController<Props, Api>(
    def: ControllerDef<Props, Api>,
    options: { deps: Record<string, unknown>; props: Props; defaultQueryOptions?: DefaultQueryOptions },
  ): Root<Api>
}

declare module '@kontsedal/olas-react' {
  import type { ControllerDef, Mutation, ReadSignal, Root, RootOptions } from '@kontsedal/olas-core'
  export function use<T>(signal: ReadSignal<T>): T
  export function useRoot<Api>(): Api
  export function useController<Api>(root: Root<Api>): Api
  export function useMutation<V, R>(
    mutation: Mutation<V, R>,
  ): {
    isPending: boolean
    mutate: (vars: V) => Promise<R>
    mutateAsync: (vars: V) => Promise<R>
    reset: () => void
  }
  export function OlasProvider(props: { root: unknown; children?: unknown }): JSX.Element
  export function KeepAlive(props: { controller: unknown; children?: unknown }): JSX.Element
  export function SuspendOnUnmount(props: { controller: unknown; children?: unknown }): JSX.Element
  export function HydrationBoundary<Api>(props: {
    def: ControllerDef<void, Api>
    options: RootOptions<Record<string, unknown>>
    children?: unknown
  }): JSX.Element
}

declare module '@kontsedal/olas-persist' {
  import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
  export type StorageAdapter = {
    get(key: string): string | null
    set(key: string, value: string): void
    delete(key: string): void
  }
  export const localStorageAdapter: StorageAdapter
  export function indexedDbAdapter(options?: { databaseName?: string }): StorageAdapter
  export function usePersisted<T>(
    ctx: Ctx,
    key: string,
    source: ReadSignal<T>,
    options?: { storage?: StorageAdapter },
  ): { ready: ReadSignal<boolean> }
  export function clearPersisted(
    storage?: StorageAdapter,
    prefix?: string,
    onError?: (err: unknown, key: string) => void,
  ): Promise<void>
}

declare module '@kontsedal/olas-realtime' {
  import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
  export function useRealtimePatcher(ctx: Ctx, channel: string, handlers: object): void
  export function useLiveStream<T>(ctx: Ctx, channel: string): { events: ReadSignal<readonly T[]> }
  export function useRealtimeConnection(ctx: Ctx): ReadSignal<string>
  export function onReconnect(ctx: Ctx, fn: () => void): void
}

declare module '@kontsedal/olas-zod' {
  import type { Ctx, Form, Validator } from '@kontsedal/olas-core'
  export type FormFromZodOptions<T> = { initials?: Partial<T> }
  export function formFromZod<T>(ctx: Ctx, schema: T, options?: FormFromZodOptions<T>): Form<any>
  export function zodValidator<T>(schema: unknown): Validator<T>
}

declare module '@kontsedal/olas-entities' {
  import type { QueryClientPlugin, ReadSignal } from '@kontsedal/olas-core'
  export type EntityDef<T> = { readonly name: string; __t?: T }
  export function defineEntity<T>(options: { name: string; idOf: (value: T) => string }): EntityDef<T>
  export type EntitiesPlugin = QueryClientPlugin & {
    signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined>
    get<T>(entity: EntityDef<T>, id: string): T | undefined
    upsert<T>(entity: EntityDef<T>, value: T): void
    update<T>(entity: EntityDef<T>, id: string, patch: Partial<T>): void
    invalidate<T>(entity: EntityDef<T>, id: string): void
    entries<T>(entity: EntityDef<T>): ReadonlyMap<string, T>
    bindings<T>(entity: EntityDef<T>, id: string): readonly unknown[]
  }
  export function entitiesPlugin(entities: ReadonlyArray<EntityDef<any>>): EntitiesPlugin
}

declare module '@kontsedal/olas-mutation-queue' {
  import type { QueryClientPlugin } from '@kontsedal/olas-core'
  import type { StorageAdapter } from '@kontsedal/olas-persist'
  export type ReplaySettleApi = { invalidate(query: unknown, keyArgs?: readonly unknown[]): void }
  export type MutationQueueOptions = {
    adapter: StorageAdapter
    keyPrefix: string
    onReplaySettle?: (entry: unknown, result: unknown, api: ReplaySettleApi) => void
  }
  export function mutationQueuePlugin(
    options: MutationQueueOptions,
  ): QueryClientPlugin & { replayNow(): Promise<void> }
}

declare module '@kontsedal/olas-cross-tab' {
  import type { QueryClientPlugin } from '@kontsedal/olas-core'
  export function crossTabPlugin(options: { channelName: string }): QueryClientPlugin
}

declare module '@kontsedal/olas-router' {
  import type { Scope } from '@kontsedal/olas-core'
  export type RouterAdapter = {
    readonly scopes: ReadonlyArray<readonly [Scope<unknown>, unknown]>
    readonly Bridge: (props: { params: Record<string, string> }) => JSX.Element
  }
  export function createRouterAdapter(): RouterAdapter
}
