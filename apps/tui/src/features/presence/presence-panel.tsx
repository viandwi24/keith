import type { KeithClient } from '@keith/client'
import { type Column, G, ListRow, Notice, Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import {
  audienceLabel,
  clientWord,
  disclosureRowsOf,
  nextLevel,
  stateLine,
  stateTone,
} from './presence-state.ts'
import { usePresenceData } from './use-presence.tsx'

export interface PresenceScreenProps {
  client: KeithClient
  /** Columns of the content (inside the screen frame's margins). */
  width: number
  /** The screen owns the keys (off while the step-up prompt is open). */
  active?: boolean
  /** `Esc` (the app goes back to where the screen was opened from). */
  onClose?(): void
}

const HINTS = [
  { key: '↑↓', action: 'select' },
  { key: 'enter', action: 'cycle who sees what' },
  { key: 'esc', action: 'back' },
] as const

/**
 * `/presence`: the person's own state and clients, then who may read the state (`none`, `state`, `detail` per audience).
 * `↑↓` selects an audience, `enter` cycles its level (`none`, `state`, `detail`), `esc` goes back. It shows only what the
 * person sees of themselves (`presence.mine`).
 */
export function PresenceScreen({ client, width, active = true, onClose }: PresenceScreenProps) {
  const { mine, error, setLevel } = usePresenceData(client)
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | undefined>()
  useFooter(HINTS)
  const rows = mine === undefined ? [] : disclosureRowsOf(mine.disclosure)
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const current = rows[at]

  useInput(
    (_input, key) => {
      if (key.escape) return onClose?.()
      if (key.upArrow) setCursor(Math.max(0, at - 1))
      else if (key.downArrow) setCursor(Math.min(rows.length - 1, at + 1))
      else if (key.return && current !== undefined) {
        setNote(undefined)
        setLevel(current.audience, nextLevel(current.level)).catch((e: Error) =>
          setNote(`Failed to change: ${e.message}`),
        )
      }
    },
    { isActive: active },
  )

  if (mine === undefined) {
    return (
      <Box flexDirection="column">
        {error === undefined ? (
          <Txt tone="muted">Reading your presence…</Txt>
        ) : (
          <Notice level="error" rows={[`Failed to load presence: ${error}`]} />
        )}
      </Box>
    )
  }
  const { presence, status, clients } = mine
  const head: Column[] = [
    { text: '', width: 1 },
    { text: 'audience', width: 16, tone: 'muted' },
    { text: 'who may read your state', flex: true, tone: 'muted' },
  ]
  return (
    <Box flexDirection="column">
      <Box>
        <Txt tone="muted">you </Txt>
        <Txt tone={stateTone(presence.state)} bold>
          {stateLine(presence, status)}
        </Txt>
      </Box>
      <Box height={1} flexShrink={0} />
      <Txt tone="muted">clients</Txt>
      {clients.length === 0 && <Txt tone="muted">none yet</Txt>}
      {clients.map((c) => (
        <ListRow
          key={c.id}
          width={width}
          columns={[
            { text: c.online ? G.dot : G.idle, width: 1, tone: c.online ? 'success' : 'muted' },
            { text: `${c.kind}  ${c.label}`, flex: true },
            { text: clientWord(c), width: 8, align: 'right', tone: 'muted' },
          ]}
        />
      ))}
      <Box height={1} flexShrink={0} />
      <ListRow width={width} columns={head} />
      {rows.map((r, i) => (
        <ListRow
          key={r.audience}
          selected={i === at}
          width={width}
          columns={[
            { text: audienceLabel(r.audience), width: 16 },
            { text: r.level, flex: true },
          ]}
        />
      ))}
      {note !== undefined && <Notice level="error" rows={[note]} />}
    </Box>
  )
}
