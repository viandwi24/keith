import { FramePanel, Rich, Txt, wrapRows } from '@keith/ui'
import { Box } from 'ink'
import { CORE_DOWN_ROWS, LOGGED_OUT_ROWS } from '../../messages.ts'

export type AuthKind = 'logged-out' | 'core-down'

/** The facts of the panel: the rows of the logged-out or core-down message (messages.ts). */
export function authRows(kind: AuthKind, core: string, detail?: string): string[] {
  return kind === 'logged-out' ? LOGGED_OUT_ROWS() : CORE_DOWN_ROWS(core, detail)
}

/** How many rows the panel takes at this width (borders included). */
export function authPanelRows(rows: readonly string[], width: number): number {
  return 2 + rows.reduce((n, r) => n + wrapRows(r, Math.max(1, width - 4)).length, 0)
}

export interface AuthPanelProps {
  kind: AuthKind
  rows: readonly string[]
  /** Cells, borders included. */
  width: number
  /** Plain muted lines under the frame (app notices), already wrapped to `width - 2`. */
  below?: readonly string[]
}

/**
 * `Sign in` / `Core down` (tui-design 5.12): the one problem panel of Home and of the chat, a
 * `FramePanel` with the first row in `danger`, the reassurance muted and the rest plain.
 */
export function AuthPanel({ kind, rows, width, below = [] }: AuthPanelProps) {
  return (
    <Box flexDirection="column" width={width}>
      <FramePanel
        width={width}
        top={[{ text: kind === 'logged-out' ? 'Sign in' : 'Core down' }]}
        padX={1}
      >
        {rows.map((row, i) => (
          <Rich
            key={i}
            text={row}
            tone={i === 0 ? 'danger' : kind === 'logged-out' && i === 2 ? 'muted' : 'text'}
          />
        ))}
      </FramePanel>
      {below.map((line, i) => (
        <Box key={i} paddingX={1} width={width}>
          <Txt tone="muted">{line}</Txt>
        </Box>
      ))}
    </Box>
  )
}
