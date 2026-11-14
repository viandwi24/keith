import type { Node } from '@keith/contracts'
import { type Column, ListRow, Panel, useNow } from '@keith/ui'
import { countNodes, formatLastSeen, nodeIcon } from './nodes-state.ts'

/**
 * The sidebar panel: online nodes first (revoked ones are not listed), offline ones with their
 * last-seen time at the right. `rows` is the height the frame may take (borders included).
 */
export function NodesPanel({
  nodes,
  rows = 6,
  width = 32,
}: {
  nodes: readonly Node[]
  rows?: number
  width?: number
}) {
  const { online, total } = countNodes(nodes)
  const live = nodes.filter((n) => n.status !== 'revoked')
  const now = useNow(live.some((n) => n.status !== 'online'))
  const shown = live.slice(0, Math.max(1, rows - 2))
  return (
    <Panel
      width={width}
      title="Nodes"
      {...(total > 0 ? { count: `${online}/${total} online` } : {})}
      more={{ n: live.length - shown.length, command: '/nodes' }}
    >
      {live.length === 0 && (
        <ListRow plain columns={[{ text: 'no nodes · keith-core pair', tone: 'muted' }]} />
      )}
      {shown.map((n) => {
        const up = n.status === 'online'
        const columns: Column[] = [
          { text: nodeIcon(n.status), width: 1, tone: up ? 'success' : 'muted' },
          { text: n.name, flex: true, tone: up ? 'text' : 'muted' },
          ...(up ? [] : [{ text: formatLastSeen(n.lastSeenAt, now), tone: 'muted' as const }]),
        ]
        return <ListRow key={n.id} plain columns={columns} />
      })}
    </Panel>
  )
}
