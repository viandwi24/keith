import { Box } from 'ink'
import type { ReactNode } from 'react'
import { GUTTER } from './spacing.ts'
import { Txt } from './text.tsx'

export interface ScreenProps {
  title: string
  /** Muted after the title: a count or a subtitle. */
  subtitle?: string | undefined
  width: number
  children?: ReactNode
}

/** A screen of the app: title row, one blank row, then the content in the gutter. */
export function Screen({ title, subtitle, width, children }: ScreenProps) {
  return (
    <Box flexDirection="column" width={width} flexGrow={1} flexShrink={1} paddingLeft={GUTTER}>
      <Box>
        <Txt bold>{title}</Txt>
        {subtitle !== undefined && <Txt tone="muted">{`  ${subtitle}`}</Txt>}
      </Box>
      <Box height={1} flexShrink={0} />
      {children}
    </Box>
  )
}
