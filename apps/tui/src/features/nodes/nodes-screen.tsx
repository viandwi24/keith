import type { Node } from '@keith/contracts'
import {
  type Column,
  G,
  ListRow,
  Notice,
  ScrollView,
  type Tone,
  Txt,
  useFooter,
  useNow,
} from '@keith/ui'
import { Box } from 'ink'
import { countNodes, driverLines, formatLastSeen, nodeIcon, refusedLines } from './nodes-state.ts'

export interface NodesScreenProps {
  nodes: readonly Node[]
  error: string | undefined
  /** Columns of the content (inside the screen frame's margins). */
  width: number
}

const FOOTER = [{ key: 'esc', action: 'back', priority: 80 }] as const
const TONE = { online: 'success', offline: 'muted', revoked: 'danger' } as const

/** The platform column needs this much room, the version column a little more. */
const PLATFORM_FROM = 56
const VERSION_FROM = 72

/** `/nodes`: every node, read only (no selection; pairing and revoking are `keith-core`). */
export function NodesScreen({ nodes, error, width }: NodesScreenProps) {
  const now = useNow(true)
  useFooter(FOOTER)
  const { online, total } = countNodes(nodes)
  const nameWidth = Math.min(16, Math.max(4, ...nodes.map((n) => n.name.length)))
  const columnsOf = (cells: {
    glyph: string
    name: string
    status: string
    platform: string
    version: string
    seen: string
    tone?: (typeof TONE)[keyof typeof TONE]
    muted?: boolean
  }): Column[] => {
    const tone: Tone = cells.muted === true ? 'muted' : 'text'
    return [
      { text: cells.glyph, width: 1, tone: cells.tone ?? 'muted' },
      { text: cells.name, width: nameWidth, tone },
      { text: cells.status, width: 7, tone: cells.tone === 'danger' ? 'danger' : tone },
      ...(width >= PLATFORM_FROM ? [{ text: cells.platform, width: 13, tone }] : []),
      ...(width >= VERSION_FROM ? [{ text: cells.version, width: 8, tone }] : []),
      { text: cells.seen, flex: true, tone: 'muted' as const },
    ]
  }
  return (
    <Box flexDirection="column" flexGrow={1}>
      {nodes.length === 0 ? (
        <Txt tone="muted">No nodes yet. Pair one on the core machine: keith-core pair</Txt>
      ) : (
        <>
          <Txt tone="muted">{`${total} ${total === 1 ? 'node' : 'nodes'} ${G.sep} ${online} online`}</Txt>
          <ListRow
            plain
            width={width}
            columns={columnsOf({
              glyph: '',
              name: 'name',
              status: 'status',
              platform: 'platform',
              version: 'version',
              seen: 'last seen',
              muted: true,
            })}
          />
          <ScrollView anchor="top">
            {nodes.map((n) => {
              const columns = columnsOf({
                glyph: nodeIcon(n.status),
                name: n.name,
                status: n.status,
                platform: `${n.os}/${n.arch}`,
                version: `v${n.version}`,
                seen: formatLastSeen(n.lastSeenAt, now),
                tone: TONE[n.status],
                muted: n.status !== 'online',
              })
              return (
                <Box key={n.id} flexDirection="column">
                  <ListRow plain width={width} columns={columns} />
                  <Box paddingLeft={2} flexDirection="column">
                    {driverLines(n).map((line) => (
                      <Txt key={line} tone="muted" wrap="truncate-end">
                        {line}
                      </Txt>
                    ))}
                    {refusedLines(n).map((line) => (
                      <Txt key={line} tone="muted" wrap="truncate-end">
                        {line}
                      </Txt>
                    ))}
                    <Txt tone="muted" wrap="truncate-end">
                      {`shell ${n.allowShell ? 'allowed' : 'off'}`}
                    </Txt>
                  </Box>
                </Box>
              )
            })}
          </ScrollView>
        </>
      )}
      {error !== undefined && <Notice level="error" rows={[`Failed to load nodes: ${error}`]} />}
      <Txt tone="muted" wrap="truncate-end">
        Pair or revoke nodes on the core machine: keith-core pair, keith-core nodes revoke
      </Txt>
    </Box>
  )
}
