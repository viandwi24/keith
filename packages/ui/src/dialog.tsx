import { Box } from 'ink'
import type { ReactNode } from 'react'
import { FramePanel } from './frame-panel.tsx'
import { GUTTER } from './spacing.ts'

export interface DialogProps {
  title: string
  /** `1 of 2`, a tag at the right of the top border. */
  count?: string
  /** The dialog has the keys: the frame and the title turn `warning`. */
  focused: boolean
  width: number
  /** The last row: key hints, a hint, or the reason input. */
  footer?: ReactNode
  /** Rows between the title and the footer. */
  children?: ReactNode
  /** The screen already has its margin (inside a `ScreenFrame`): no gutter, the frame is exactly `width`. */
  flush?: boolean
  /** The frame and the title take this tone instead of `warning` (a confirm is `warning`, a plain form none). */
  tone?: 'warning' | 'danger' | 'info' | 'success' | 'accent' | 'none'
}

/** Columns a dialog's rows get at `width`: the gutter, the two sides and one column of padding on each. */
export const dialogInner = (width: number): number => Math.max(10, width - GUTTER - 4)

/** The approval frame: a `FramePanel` (muted, `warning` when focused) with the title in its top border. */
export function Dialog({
  title,
  count,
  focused,
  width,
  footer,
  children,
  flush = false,
  tone,
}: DialogProps) {
  const frameTone =
    tone === undefined ? (focused ? 'warning' : undefined) : tone === 'none' ? undefined : tone
  return (
    <Box paddingLeft={flush ? 0 : GUTTER} width={width}>
      <FramePanel
        width={Math.max(2, flush ? width : width - GUTTER)}
        top={[{ text: title }]}
        {...(count === undefined ? {} : { topRight: [{ text: count }] })}
        {...(frameTone === undefined ? {} : { tone: frameTone })}
        padX={1}
      >
        {children}
        {footer}
      </FramePanel>
    </Box>
  )
}

/** A row inside a dialog that must not be cut or wrapped away (the command being approved), indented under the frame. */
export function Chip({ children }: { children: ReactNode }) {
  return <Box>{children}</Box>
}
