import { useRoot, useValue } from '@kontsedal/olas-react'
import { Toast, ToastRegion } from '../../ui'

export function Notifications() {
  const app = useRoot()
  const queue = useValue(app.notifications.queue)
  return (
    <ToastRegion>
      {queue.map((e) => (
        <Toast
          key={e.id}
          tone={e.kind}
          title={e.title}
          message={e.message}
          action={e.retry ? { label: 'Retry', onClick: e.retry } : undefined}
          onDismiss={() => app.notifications.dismiss(e.id)}
        />
      ))}
    </ToastRegion>
  )
}
