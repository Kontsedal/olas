import { use, useRoot } from '@kontsedal/olas-react'
import type { AppApi } from '../../app.controller'
import { Toast, ToastRegion } from '../../ui'

export function Notifications() {
  const app = useRoot<AppApi>()
  const queue = use(app.notifications.queue)
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
