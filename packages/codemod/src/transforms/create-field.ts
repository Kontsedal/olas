import { Node, SyntaxKind, type Type } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { member } from '../util/ast'
import { isRef } from '../util/olas'

export const FIELD_THIRD_ARGUMENT =
  "`createField`'s third argument is `{ validators, validateOn }` in 1.0: check what this passes"

const isList = (type: Type): boolean => type.isArray() || type.isReadonlyArray() || type.isTuple()

/**
 * `createField(ctx, initial, validators, options)` →
 * `createField(ctx, initial, { validators, ...options })`, like `createForm`
 * and `createFieldArray`.
 */
export const createField: Transform = {
  name: 'create-field',
  description:
    '`createField(ctx, initial, [validators], { validateOn })` → `createField(ctx, initial, { validators, validateOn })`',
  run: (files) =>
    runPerFile('create-field', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!isRef(call.getExpression(), 'core', 'createField')) continue
        const [, initial, validators, options] = call.getArguments()
        if (validators === undefined || Node.isObjectLiteralExpression(validators)) continue
        const noValidators = validators.getText() === 'undefined'
        if (!noValidators && !isList(validators.getType())) {
          // Already an options value, or something this cannot read.
          const type = validators.getType()
          if (
            type.getProperty('validators') === undefined &&
            type.getProperty('validateOn') === undefined
          ) {
            changes.todo(validators, FIELD_THIRD_ARGUMENT)
          }
          continue
        }
        const parts: string[] = []
        if (!noValidators) parts.push(member('validators', validators.getText()))
        if (Node.isObjectLiteralExpression(options)) {
          for (const p of options.getProperties()) parts.push(p.getText())
        } else if (options !== undefined && options.getText() !== 'undefined') {
          parts.push(`...${options.getText()}`)
        }
        const end = (options ?? validators).getEnd()
        if (parts.length === 0) {
          changes.replace((initial as Node).getEnd(), end, '')
        } else {
          changes.replace(validators.getStart(), end, `{ ${parts.join(', ')} }`)
        }
        changes.site()
      }
    }),
}
