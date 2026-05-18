// Public barrel — keeps imports stable while internal files moved to
// `query.ts`, `schema.ts`, `controllers/`, and `app.ts`. Tests + the existing
// example doc can import from `./controller` unchanged.

export { boardQuery, setApiForQuery } from './query'
export {
  cardSchema,
  prioritySchema,
  subtaskSchema,
  buildCardForm,
  type CardForm,
  type CardFormValue,
  type SubtaskForm,
} from './schema'
export {
  boardController,
  applyMove,
  type BoardProps,
  type MoveVars,
} from './controllers/board'
export {
  cardEditorController,
  type CardEditorTarget,
  type CardEditorProps,
} from './controllers/cardEditor'
export { createAppRoot, type AppRoot, type AppApi } from './app'
export type { Subtask } from './api'
