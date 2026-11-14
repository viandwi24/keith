import { type ConnectionKind, ConnectionMark, Txt } from '@keith/ui'
import { Box } from 'ink'
import { TITLE } from './home-state.ts'

export interface HomeHeaderProps {
  columns: number
  connection: ConnectionKind
  /** What the first connect is trying (`connecting` shows it). */
  target?: string
}

/**
 * The title row: `K E I T H` alone, centred. The connection is the pulsing `✳` at the right end of
 * the row, in its colour (a word follows only without colour). It is drawn over the top border of
 * the brain frame (same row), so it is absolutely positioned and one row high.
 */
export function HomeHeader({ columns, connection, target }: HomeHeaderProps) {
  const status = { connection, ...(target === undefined ? {} : { target }) }
  return (
    <Box position="absolute" top={0} left={0} width={columns} height={1}>
      <Box position="absolute" top={0} left={0} width={columns} justifyContent="center">
        <Txt bold>{TITLE}</Txt>
      </Box>
      <Box
        position="absolute"
        top={0}
        left={0}
        width={columns}
        justifyContent="flex-end"
        paddingRight={2}
      >
        <ConnectionMark status={status} />
      </Box>
    </Box>
  )
}
