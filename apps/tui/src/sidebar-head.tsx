import {
  BrainFrame,
  type BrainTrace,
  OrbCanvas,
  type OrbMode,
  useFrameClock,
  useTheme,
} from '@keith/ui'
import { Box } from 'ink'

/** The smallest orb of the sidebar, in rows (about 17 columns wide when round); taller terminals give it more, up to the column's width (`orbRowsFor`). */
export const SIDEBAR_ORB_MIN_ROWS = 8
/** The wave graph keeps the 4 braille rows it has in the chat header; its frame adds two borders and the trail row. */
const GRAPH_LINES = 4
export const SIDEBAR_GRAPH_ROWS = GRAPH_LINES + 3

export interface SidebarOrb {
  mode: OrbMode
  trace: BrainTrace
  cellAspect: number
  /** `false` stops the timers (the chat is not on screen, or the orb is in flight). */
  running: boolean
}

/** The top of the wide sidebar: the orb and the wave graph, one clock for both. */
export function SidebarHead({
  orb,
  width,
  rows,
  graph,
}: {
  orb: SidebarOrb
  width: number
  /** Rows of the orb canvas (as wide as the column; the orb is round inside it). */
  rows: number
  /** The graph frame is drawn (the Brain panel setting). */
  graph: boolean
}) {
  const theme = useTheme()
  const clock = useFrameClock({ fps: theme.depth === 'none' ? 2 : 12, running: orb.running })
  return (
    <Box width={width} flexDirection="column" flexShrink={0}>
      <OrbCanvas
        mode={orb.mode}
        width={width}
        height={rows}
        cellAspect={orb.cellAspect}
        running={orb.running}
        clock={clock}
      />
      {graph && (
        <BrainFrame
          trace={orb.trace}
          width={width}
          status={orb.mode}
          graphRows={GRAPH_LINES}
          regions={false}
          running={orb.running}
          clock={clock}
        />
      )}
    </Box>
  )
}
