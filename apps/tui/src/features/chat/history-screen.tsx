// `/history`: the person's previous chat generations, newest first, in a compact frame (docs/specs/chat-context.md, "TUI").
// It reads `chat.generations` once on open and changes nothing; `esc` closes it and returns to where it was opened from.

import { type HistoryRow, historyRowsOf } from '@keith/app-model'
import type { KeithClient } from '@keith/client'
import { GUTTER, ScreenFrame, type StatusInfo, Txt } from '@keith/ui'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'

export interface HistoryScreenProps {
  client: Pick<KeithClient, 'chatContext'>
  width: number
  rows: number
  status: StatusInfo
  /** `esc`: back to the chat. */
  onClose(): void
}

/** The rows the panel shows at most (the newest; the rest is a count). */
export const HISTORY_ROWS_MAX = 12

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function HistoryScreen({ client, width, rows, status, onClose }: HistoryScreenProps) {
  const [list, setList] = useState<HistoryRow[] | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    client.chatContext.generations().then(
      (generations) => alive && setList(historyRowsOf(generations)),
      (e: unknown) => alive && setLoadError(messageOf(e)),
    )
    return () => {
      alive = false
    }
  }, [client])

  useInput((_input, key) => {
    if (key.escape) onClose()
  })

  const body = (() => {
    if (loadError !== undefined) return <Txt tone="danger">{loadError}</Txt>
    if (list === undefined) return <Txt tone="muted">reading ...</Txt>
    if (list.length === 0) return <Txt tone="muted">No earlier conversations yet.</Txt>
    const shown = list.slice(0, HISTORY_ROWS_MAX)
    return (
      <Box flexDirection="column">
        {shown.map((row) => (
          <Box key={row.generation} flexDirection="column">
            <Txt tone="accent">{`${row.generation === 0 ? 'First context' : `Context ${row.generation}`} · ${row.messages}${row.compacted === undefined ? '' : ` · ${row.compacted}`}`}</Txt>
            <Txt tone="text">{`  ${row.started} · ${row.ended}`}</Txt>
          </Box>
        ))}
        {list.length > shown.length && (
          <Txt tone="muted">{`… ${list.length - shown.length} older`}</Txt>
        )}
        <Box marginTop={1}>
          <Txt tone="muted">
            Read only. Your earlier messages stay with you; nothing here changes.
          </Txt>
        </Box>
      </Box>
    )
  })()

  return (
    <ScreenFrame
      width={width}
      height={rows}
      label="History"
      status={status}
      legend={[{ key: 'esc', action: 'back' }]}
    >
      <Box flexDirection="column" width={Math.max(1, width - GUTTER * 2)}>
        {body}
      </Box>
    </ScreenFrame>
  )
}
