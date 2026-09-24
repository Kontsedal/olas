import { OlasProvider } from '@kontsedal/olas-react'
import { root } from './app'
import { SuspendOnUnmount, useValue, useMutation } from './olas'

export function TodoInput() {
  const api = root.api
  const draft = useValue(api.draft)
  const { run: mutateAsync } = useMutation(api.add)
  return <input value={draft} onBlur={() => mutateAsync(draft)} />
}

export function App() {
  return (
    <OlasProvider root={root}>
      <SuspendOnUnmount controller={null}>
        <TodoInput />
      </SuspendOnUnmount>
    </OlasProvider>
  )
}
