import { Avatar, type AvatarProps } from './Avatar'

export type AvatarStackProps = {
  members: ReadonlyArray<{ id: string; name: string; hue?: number }>
  max?: number
  size?: AvatarProps['size']
}

export function AvatarStack({ members, max = 3, size = 'sm' }: AvatarStackProps) {
  const shown = members.slice(0, max)
  const overflow = members.length - shown.length
  return (
    <span className="olas-avatar-stack">
      {shown.map((m) => (
        <Avatar key={m.id} name={m.name} hue={m.hue} size={size} />
      ))}
      {overflow > 0 && <Avatar key="overflow" name={`+${overflow}`} hue={270} size={size} />}
    </span>
  )
}
