import { Box, type BoxProps } from 'ink'
import type { ReactNode } from 'react'
import { PAD } from './spacing.ts'
import type { Theme } from './theme.ts'

type Free = Omit<
  BoxProps,
  | 'backgroundColor'
  | 'borderStyle'
  | 'borderColor'
  | 'borderDimColor'
  | 'borderTop'
  | 'borderBottom'
  | 'borderLeft'
  | 'borderRight'
  | 'borderBackgroundColor'
>

export interface SurfaceProps extends Free {
  children?: ReactNode
}

/** `{ borderColor }` in the `border` token, nothing in none depth. */
export const borderColor = (t: Theme): { borderColor?: string } => {
  const c = t.color('border')
  return c === undefined ? {} : { borderColor: c }
}

/**
 * A region with `pad` columns of padding. Nothing is painted and nothing is drawn around it
 * (tui-design 1): regions are separated by whitespace and by `FramePanel`.
 */
export function Surface({ children, ...box }: SurfaceProps) {
  return (
    <Box paddingX={PAD} {...box}>
      {children}
    </Box>
  )
}
