import { createField, required } from '@kontsedal/olas-core'
import type { Ctx, Validator } from '@kontsedal/olas-core'

declare const ctx: Ctx
declare const opts: { validateOn: 'blur' }
declare const mystery: number
declare const tuple: [Validator<string>]
const validators: Validator<string>[] = [required()]
const frozen: readonly Validator<string>[] = [required()]

export const a = createField(ctx, '', [required()])
export const b = createField(ctx, '', [required()], { validateOn: 'blur' })
export const c = createField(ctx, '', undefined, { validateOn: 'blur' })
export const d = createField(ctx, '', validators, opts)
export const e = createField(ctx, '', frozen)
export const f = createField(ctx, '', undefined)
export const g = createField(ctx, '', [required()], undefined)
export const h = createField(ctx, '', tuple)
export const i = createField(ctx, '')

// Already the 1.0 shape: left alone.
export const j = createField(ctx, '', { validators: [required()] })
export const k = createField(ctx, '', opts)

// Something this cannot read: reported.
export const l = createField(ctx, '', mystery)
