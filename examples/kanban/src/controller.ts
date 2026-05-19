// Public barrel — keeps imports stable while internal files moved to
// `query.ts`, `schema.ts`, `controllers/`, and `app.ts`. Tests + the existing
// example doc can import from `./controller` unchanged.

export type { Subtask } from './api'
export { type AppApi, type AppRoot, createAppRoot } from './app'
export {
  applyMove,
  type BoardProps,
  boardController,
  type MoveVars,
} from './controllers/board'
export {
  type CardEditorProps,
  type CardEditorTarget,
  cardEditorController,
} from './controllers/cardEditor'
export { boardQuery } from './query'
export {
  buildCardForm,
  type CardForm,
  type CardFormValue,
  cardSchema,
  prioritySchema,
  type SubtaskForm,
  subtaskSchema,
} from './schema'
