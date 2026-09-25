import { OlasProvider, useController } from '@kontsedal/olas-react'
import { root } from './app'
import { KeepAlive, use, useMutation } from './olas'

export function TodoInput() {
  const api = useController(root)
  const draft = use(api.draft)
  const { mutateAsync } = useMutation(api.add)
  return <input value={draft} onBlur={() => mutateAsync(draft)} />
}

export function App() {
  return (
    <OlasProvider root={root}>
      <KeepAlive controller={null}>
        <TodoInput />
      </KeepAlive>
    </OlasProvider>
  )
}
