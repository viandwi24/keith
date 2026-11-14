// The Memory screen: `Me > Memory` (docs/specs/tui.md, "Commands and keys"; docs/specs/dreaming.md "TUI"). It shows the person's own
// dreaming mode, the last run, a staged plan with the entries it would change, and the person's own diary. It reads `dreaming.status` and
// `dreaming.diary` only; it never reads another person's memory, and it changes nothing (the `/dream` commands do). The diary is the
// latest day; a listing of the days needs a procedure the contract does not have yet.
import type { KeithClient } from '@keith/client'
import type { DreamDiaryOutput, DreamStatusView } from '@keith/contracts'
import { Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import {
  countsTextOf,
  dateOf,
  runLineOf,
  stagedEntriesOf,
  stagedExpiryNoteOf,
  whenOf,
} from './dream-state.ts'

export interface MemoryScreenProps {
  client: KeithClient
  /** Cells and rows of the screen body (the frame's own rows are not counted). */
  width: number
  /** On screen with the keys (the step-up prompt or another screen takes them otherwise). */
  active: boolean
  /** `esc`: back to the Me screen. */
  onClose(): void
}

/** The diary lines the screen shows at most (the newest, at the bottom). */
const DIARY_LINES_MAX = 24
/** The staged entries the screen shows at most. */
const ENTRIES_MAX = 12

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const noDiary = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'NOT_FOUND'

interface MemoryData {
  status: DreamStatusView
  diary: DreamDiaryOutput | undefined
  staged: string[]
}

export function MemoryScreen({ client, width, active, onClose }: MemoryScreenProps) {
  const [data, setData] = useState<MemoryData | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    const load = async (): Promise<MemoryData> => {
      const status = await client.dreaming.status()
      const diary = await client.dreaming.diary().catch((e: unknown) => {
        if (noDiary(e)) return undefined
        throw e
      })
      // the entries a staged plan would change: the diary of the day the run that holds the plan started (not always lastRun)
      const runId = status.stagedRunId ?? status.lastRun?.id
      const startedAt = status.stagedRunStartedAt ?? status.lastRun?.startedAt
      let staged: string[] = []
      if (status.canApply && runId !== undefined && startedAt !== undefined) {
        const day = await client.dreaming.diary({ date: dateOf(startedAt) }).catch(() => undefined)
        if (day !== undefined) staged = stagedEntriesOf(day, runId)
      }
      return { status, diary, staged }
    }
    load().then(
      (next) => alive && setData(next),
      (e: unknown) => alive && setLoadError(messageOf(e)),
    )
    return () => {
      alive = false
    }
  }, [client])

  useFooter([{ key: 'esc', action: 'back' }])

  useInput(
    (_input, key) => {
      if (key.escape) onClose()
    },
    { isActive: active },
  )

  if (loadError !== undefined) return <Txt tone="danger">{loadError}</Txt>
  if (data === undefined) return <Txt tone="muted">reading ...</Txt>

  const { status, diary, staged } = data
  const run = status.lastRun
  const diaryLines = (diary?.text ?? '').split('\n').filter((line) => line.trim() !== '')
  const shownDiary = diaryLines.slice(-DIARY_LINES_MAX)

  return (
    <Box flexDirection="column" width={width}>
      <Txt tone="muted">
        Only your own memory. Change the mode with /dream mode off · propose · auto.
      </Txt>
      <Box marginTop={1} flexDirection="column">
        <Txt tone="text">{`Mode: ${status.mode}`}</Txt>
        <Txt tone="text">
          {run === null ? 'Last run: none yet.' : `Last run: ${runLineOf(run)}`}
        </Txt>
        {status.nextRunAt !== null && (
          <Txt tone="muted">{`Next run may start from ${whenOf(status.nextRunAt)}.`}</Txt>
        )}
      </Box>
      {status.canApply && run !== null && (
        <Box marginTop={1} flexDirection="column">
          <Txt tone="accent">{`Staged plan: ${countsTextOf(run)}`}</Txt>
          <Txt tone="muted">{`Apply it with /dream apply${stagedExpiryNoteOf(status)}.`}</Txt>
          {staged.slice(0, ENTRIES_MAX).map((entry, i) => (
            <Txt key={`${i}-${entry}`} tone="text">{`  ${entry}`}</Txt>
          ))}
          {staged.length > ENTRIES_MAX && (
            <Txt tone="muted">{`  … ${staged.length - ENTRIES_MAX} more`}</Txt>
          )}
        </Box>
      )}
      {status.canUndo && <Txt tone="muted">Undo is available: /dream undo.</Txt>}
      <Box marginTop={1} flexDirection="column">
        {diary === undefined ? (
          <Txt tone="muted">No diary yet.</Txt>
        ) : (
          <>
            <Txt tone="accent">{`Diary ${diary.date}`}</Txt>
            {shownDiary.map((line, i) => (
              <Txt key={`${i}-${line}`} tone="text">
                {line}
              </Txt>
            ))}
          </>
        )}
      </Box>
    </Box>
  )
}
