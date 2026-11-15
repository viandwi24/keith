import { formatElapsed, isActive, shortAgent, statusIcon, statusWord } from '@keith/app-model'
import type { KeithClient } from '@keith/client'
import type { Task } from '@keith/contracts'
import {
  type Column,
  G,
  ListRow,
  Markdown,
  Notice,
  PulseGlyph,
  Txt,
  useFooter,
  useNow,
  windowOf,
} from '@keith/ui'
import { Box } from 'ink'
import { useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import { agentWidthOf, taskColumns } from './tasks-panel.tsx'

export interface TasksScreenProps {
  client: KeithClient
  tasks: readonly Task[]
  /** Columns of the content (inside the screen frame's margins). */
  width: number
  /** Rows of the content. */
  height: number
  /** The screen owns the keys (off while the step-up prompt is open). */
  active?: boolean
  /** The board could not be loaded. */
  error?: string | undefined
  /** Refetch the board (after a stop). */
  onReload(): void
  /** `Esc` on the list. */
  onClose(): void
  /** Runs a call, asking for a step-up when the core wants one (default: just runs it). */
  guard?: <T>(act: () => Promise<T>) => Promise<T>
}

type Note = { level: 'info' | 'error'; text: string }

const LIST_HINTS = [
  { key: '↑↓', action: 'select' },
  { key: 'enter', action: 'open' },
  { key: 's', action: 'stop' },
  { key: 'esc', action: 'back' },
] as const

const CONFIRM = 'stop this task?  [y] yes  any other key cancels'

/**
 * `/tasks`: every task. Up/down moves, Enter opens the summary or error, `s` then `y` stops a
 * running task (any other key cancels), `Esc` goes back (the detail first, then the list).
 */
export function TasksScreen({
  client,
  tasks,
  width,
  height,
  error,
  active = true,
  onReload,
  onClose,
  guard = (act) => act(),
}: TasksScreenProps) {
  const [cursor, setCursor] = useState(0)
  const [detail, setDetail] = useState<string | undefined>()
  const [confirm, setConfirm] = useState<string | undefined>()
  const [note, setNote] = useState<Note | undefined>()
  const now = useNow(tasks.some(isActive))
  const at = Math.min(cursor, Math.max(0, tasks.length - 1))
  const current = tasks[at]
  const opened = tasks.find((t) => t.id === detail)

  useFooter(
    confirm !== undefined
      ? CONFIRM
      : opened !== undefined
        ? [{ key: 'esc', action: 'back to the list' }]
        : LIST_HINTS,
  )
  useInput(
    (input, key) => {
      if (confirm !== undefined) {
        setConfirm(undefined)
        if (input !== 'y') return setNote({ level: 'info', text: 'Cancelled.' })
        guard(() => client.rpc.tasks.stop({ id: confirm }))
          .then(() => {
            setNote({ level: 'info', text: 'Task stopped.' })
            onReload()
          })
          .catch((e: Error) => setNote({ level: 'error', text: `Failed to stop: ${e.message}` }))
        return
      }
      if (key.escape) return detail === undefined ? onClose() : setDetail(undefined)
      if (opened !== undefined) return
      setNote(undefined)
      if (key.upArrow) setCursor(Math.max(0, at - 1))
      else if (key.downArrow) setCursor(Math.min(tasks.length - 1, at + 1))
      else if (key.return && current !== undefined) setDetail(current.id)
      else if (input === 's' && current !== undefined) {
        if (isActive(current)) setConfirm(current.id)
        else setNote({ level: 'info', text: 'This task is already finished.' })
      }
    },
    { isActive: active },
  )

  if (opened !== undefined) {
    const steps = `${opened.steps} ${opened.steps === 1 ? 'step' : 'steps'}`
    return (
      <Box flexDirection="column">
        <Box>
          <Txt bold>{shortAgent(opened.agent)}</Txt>
          <Txt tone="muted">
            {`  ${statusIcon(opened.status)} ${statusWord(opened.status)} ${G.sep} ${formatElapsed(opened, now)} ${G.sep} ${steps}`}
          </Txt>
        </Box>
        <Txt>{opened.description}</Txt>
        <Box height={1} flexShrink={0} />
        {opened.error !== null && (
          <>
            <Notice level="error" rows={[`Failed: ${opened.error}`]} />
            <Box height={1} flexShrink={0} />
          </>
        )}
        {opened.summary !== null ? (
          <Markdown text={opened.summary} width={Math.max(20, width)} />
        ) : (
          <Txt tone="muted">{isActive(opened) ? 'No result yet.' : 'No summary.'}</Txt>
        )}
      </Box>
    )
  }
  if (tasks.length === 0) {
    return (
      <Box flexDirection="column">
        <Txt tone="muted">No tasks yet. Ask keith to research something and it shows up here.</Txt>
        {error !== undefined && <Notice level="error" rows={[`Failed to load tasks: ${error}`]} />}
      </Box>
    )
  }
  const running = tasks.filter(isActive).length
  // the summary row, the table header, and the rows the notes below take
  const rowsFree = Math.max(
    1,
    height - 2 - (note !== undefined ? 1 : 0) - (error !== undefined ? 1 : 0),
  )
  const { start, end } = windowOf(at, tasks.length, rowsFree)
  const agentWidth = agentWidthOf(tasks)
  const head: Column[] = [
    { text: '', width: 1 },
    { text: 'agent', width: agentWidth, tone: 'muted' },
    { text: 'task', flex: true, tone: 'muted' },
    { text: 'time', width: 5, align: 'right', tone: 'muted' },
  ]
  return (
    <Box flexDirection="column">
      <Box>
        <Txt tone="muted">{`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}</Txt>
        {running > 0 && (
          <>
            <Txt tone="muted">{`  ${G.sep}  `}</Txt>
            <PulseGlyph tone="info" />
            <Txt tone="muted">{` ${running} running`}</Txt>
          </>
        )}
      </Box>
      <ListRow width={width} columns={head} />
      {tasks.slice(start, end).map((t) => (
        <ListRow
          key={t.id}
          selected={t.id === current?.id}
          width={width}
          columns={taskColumns(t, now, agentWidth)}
        />
      ))}
      {error !== undefined && <Notice level="error" rows={[`Failed to load tasks: ${error}`]} />}
      {note !== undefined && <Notice level={note.level} rows={[note.text]} />}
    </Box>
  )
}
