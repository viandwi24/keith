import { G, GUTTER, Txt } from '@keith/ui'
import { Box, Text } from 'ink'

export interface ActivityStripProps {
  cortex: number
  running: number
  online: number
  total: number
}

/** One row for 60-99 columns, where the sidebar is hidden: `◐ cortex ×2   2 tasks running   nodes 1/2`. */
export function ActivityStrip({ cortex, running, online, total }: ActivityStripProps) {
  return (
    <Box paddingLeft={GUTTER} flexShrink={0}>
      <Text wrap="truncate-end">
        {cortex > 0 ? (
          <Txt tone="warning">{`${G.working} cortex ×${cortex}`}</Txt>
        ) : (
          <Txt tone="muted">{`${G.idle} cortex`}</Txt>
        )}
        <Txt tone="muted">
          {running > 0
            ? `   ${running} ${running === 1 ? 'task' : 'tasks'} running`
            : '   no tasks running'}
          {`   nodes ${online}/${total}`}
        </Txt>
      </Text>
    </Box>
  )
}
