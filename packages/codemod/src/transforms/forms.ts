import { Node, SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { resultUse } from '../util/ast'
import { isOldFieldArray, isOldForm, isSignal } from '../util/shape'

export const SUBMIT_RESULT =
  '`submit` resolves a `SubmitResult` union in 1.0: narrow on `ok`, then on `reason`'

/**
 * A `Form` and a `FieldArray` are `ReadSignal`s of their value in 1.0, like a
 * `Field`. In 0.8 the signal was their `value` member, so `form.value` (the
 * signal) becomes `form`, and with it `form.value.value` → `form.value`,
 * `useValue(form.value)` → `useValue(form)` and `form.value.subscribe` →
 * `form.subscribe`.
 */
export const forms: Transform = {
  name: 'forms',
  description:
    '`form.value.value` → `form.value` for a Form or FieldArray; `resetWithInitial` → `setAsInitial`',
  run: (files) =>
    runPerFile('forms', files, (file, changes) => {
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const target = access.getExpression()
        const name = access.getName()
        if (name === 'value') {
          if (!isOldForm(target) && !isOldFieldArray(target)) continue
          if (!isSignal(access)) continue
          // `form?.value.peek()` → `form?.peek()`: a chain that goes on keeps its `?`.
          const parent = access.getParent()
          const chained =
            access.hasQuestionDotToken() &&
            Node.isPropertyAccessExpression(parent) &&
            parent.getExpression() === access
          changes.replace(target.getEnd(), access.getEnd(), chained ? '?' : '')
          changes.site()
        } else if (name === 'resetWithInitial' && isOldForm(target)) {
          changes.replaceNode(access.getNameNode(), 'setAsInitial')
          changes.site()
        } else if (name === 'submit' && isOldForm(target)) {
          const call = access.getParent()
          if (
            Node.isCallExpression(call) &&
            call.getExpression() === access &&
            resultUse(call) === 'used'
          ) {
            changes.todo(call, SUBMIT_RESULT)
          }
        }
      }
    }),
}
