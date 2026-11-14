import { GUTTER, VRule } from '@keith/ui'
import { Box } from 'ink'
import { Sidebar, type SidebarProps } from './sidebar.tsx'

/**
 * The sidebar with its separator: a blank column, the `│` over the full height of the column, a
 * blank column, then the frames, and the right margin of the title row.
 */
export function SidebarColumn({ top, ...props }: SidebarProps & { top: number }) {
  return (
    <Box marginLeft={1} marginRight={GUTTER} marginTop={top} flexShrink={0}>
      <VRule height={props.height} />
      <Box marginLeft={1} flexShrink={0}>
        <Sidebar {...props} />
      </Box>
    </Box>
  )
}
