import { isHome, isLeave, type KeithClient, keyBytes } from '@keith/client'
import {
  GUTTER,
  Notice,
  SCREEN_CHROME_ROWS,
  ScreenFrame,
  type StatusInfo,
  StyledLines,
  Txt,
  useTheme,
} from '@keith/ui'
import { Box } from 'ink'
import { useEffect } from 'react'
import { useGuardedInput as useInput, useLink } from '../activity/index.ts'
import { usePluginView } from './use-plugin-view.ts'
import { endText, TIMEOUT_TEXT, viewDepth } from './view-text.ts'

export interface PluginViewScreenProps {
  client: Pick<KeithClient, 'openView'>
  /** The wire id (`notes.list`) and the label of the menu entry. */
  view: { viewId: string; label: string }
  /** Cells and rows of the whole terminal. */
  width: number
  rows: number
  status: StatusInfo
  /** `esc`: back to where the view was opened from (Home). */
  onLeave(): void
  /** `ctrl+g`: Home. */
  onHome(): void
  /** Test seam: the slow-link and timeout waits (defaults: 400 ms and 10 s). */
  timing?: { slowMs?: number; timeoutMs?: number }
}

/** The protocol's size limits: a smaller terminal shows the view cut, a larger one gets at most this. */
const clampCols = (n: number): number => Math.max(20, Math.min(400, n))
const clampRows = (n: number): number => Math.max(4, Math.min(200, n))

/**
 * A plugin view in a framed screen (tui-design 5.19). The core runs the view; this draws the frames the client parsed
 * (text and styles only, drawn with Ink's `Text`: no byte of the view ever reaches the terminal), forwards the keys and
 * the size, and keeps `esc` (leave) and `ctrl+g` (Home) for itself. Frames carry no history: a view that ended shows
 * its last screen under the reason, and `r` opens a fresh one on the person's action, never by itself.
 */
export function PluginViewScreen({
  client,
  view,
  width,
  rows,
  status,
  onLeave,
  onHome,
  timing,
}: PluginViewScreenProps) {
  const theme = useTheme()
  const cols = clampCols(width - GUTTER * 2)
  const height = clampRows(rows - SCREEN_CHROME_ROWS)
  const { state, sendKey, close, reopen } = usePluginView({
    client,
    viewId: view.viewId,
    cols,
    rows: height,
    colorDepth: viewDepth(theme.depth),
    ...(timing === undefined ? {} : { timing }),
  })
  const timedOut = state.phase === 'timeout'
  // a timeout is a dead attempt the person may retry, like an ended view; no text of it is kept
  const ended = state.phase === 'ended' || timedOut
  // the link to the core is down: the view cannot be served any more; it closes and is not reopened by itself
  const down = useLink() !== undefined
  useEffect(() => {
    if (down && !ended) close()
  }, [down, ended, close])
  const end =
    state.reason === undefined ? (timedOut ? TIMEOUT_TEXT : undefined) : endText(state.reason)

  // a view that finished by itself (the plugin called exit) hands the screen back
  useEffect(() => {
    if (ended && state.reason === 'view') onLeave()
  }, [ended, state.reason, onLeave])

  useInput((input, key) => {
    if (isLeave(key)) {
      close()
      return onLeave()
    }
    if (isHome(input, key)) {
      close()
      return onHome()
    }
    if (ended) {
      if (input === 'r' && end?.reopen === true) reopen()
      return
    }
    const bytes = keyBytes(input, key)
    if (bytes !== undefined) sendKey(bytes)
  })

  const hints = ended
    ? [
        { key: 'esc', action: 'back' },
        ...(end?.reopen === true ? [{ key: 'r', action: 'reopen' }] : []),
        { key: 'ctrl+g', action: 'home' },
      ]
    : [
        { key: 'esc', action: 'back' },
        { key: 'ctrl+g', action: 'home' },
      ]
  const lines = state.frame?.lines ?? []
  return (
    <ScreenFrame width={width} height={rows} label={view.label} status={status} legend={hints}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {state.phase === 'connecting' && <Txt tone="muted">connecting…</Txt>}
        {state.phase === 'connecting' && state.slow && (
          <Txt tone="muted">still waiting: the link to the core may be slow</Txt>
        )}
        {state.phase !== 'connecting' && (
          <StyledLines
            lines={lines}
            width={Math.max(1, width - GUTTER * 2)}
            height={ended ? Math.max(1, height - (end?.rows.length ?? 0) - 1) : height}
          />
        )}
        {ended && end !== undefined && (
          <Box marginTop={1}>
            <Notice level={state.reason === 'view' ? 'info' : 'warning'} rows={end.rows} />
          </Box>
        )}
      </Box>
    </ScreenFrame>
  )
}
