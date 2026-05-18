export type Validator<T> = (value: T, signal: AbortSignal) => string | null | Promise<string | null>
